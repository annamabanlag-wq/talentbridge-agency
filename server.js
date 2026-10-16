const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || '';
const COMMISSION_RATE = 0.22;
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS;
const DATABASE_URL = process.env.DATABASE_URL;
const MANPOWER_ALERT_EMAIL = process.env.MANPOWER_ALERT_EMAIL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || '';

function escapeEmailHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function notifyManpowerRequest(lead) {
  if (!MANPOWER_ALERT_EMAIL || !RESEND_API_KEY || !RESEND_FROM) {
    console.warn('Manpower alert email skipped: configure MANPOWER_ALERT_EMAIL, RESEND_API_KEY and RESEND_FROM.');
    return false;
  }

  const subject = 'New manpower request #' + lead.id + ' — ' + lead.companyName;
  const text = [
    'A new manpower request was submitted on TalentBridge.',
    '',
    'Request ID: ' + lead.id,
    'Company: ' + lead.companyName,
    'Contact person: ' + lead.contactName,
    'Business email: ' + lead.clientEmail,
    'Phone: ' + lead.contactPhone,
    'Work location: ' + lead.location,
    'Role: ' + lead.title,
    'Workers needed: ' + lead.workersNeeded,
    'Required skills: ' + lead.skills.join(', '),
    'Budget: ' + (lead.budget || 'Not specified'),
    '',
    'Description:',
    lead.description,
    '',
    'Sign in to the TalentBridge admin dashboard to review the full lead.'
  ].join('\n');
  const html = '<h2>New manpower request</h2><p>A new request was submitted on TalentBridge.</p><table>' +
    [['Request ID', lead.id], ['Company', lead.companyName], ['Contact person', lead.contactName],
     ['Business email', lead.clientEmail], ['Phone', lead.contactPhone], ['Work location', lead.location],
     ['Role', lead.title], ['Workers needed', lead.workersNeeded], ['Required skills', lead.skills.join(', ')],
     ['Budget', lead.budget || 'Not specified']].map(([label, value]) =>
       '<tr><th align="left" style="padding:6px">' + escapeEmailHtml(label) + '</th><td style="padding:6px">' + escapeEmailHtml(value) + '</td></tr>'
     ).join('') + '</table><h3>Description</h3><p>' + escapeEmailHtml(lead.description).replace(/\n/g, '<br>') +
     '</p><p>Sign in to the TalentBridge admin dashboard to review the full lead.</p>';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [MANPOWER_ALERT_EMAIL], subject, text, html }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error('Manpower alert email provider rejected the request; status:', response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Manpower alert email delivery request failed:', error?.name || 'UnknownError');
    return false;
  }
}

let sql;
let dbReady = false;

async function initDB() {
  if (!DATABASE_URL) {
    console.log('No DATABASE_URL — running in memory only');
    return;
  }
  try {
    const { neon } = require('@neondatabase/serverless');
    sql = neon(DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS talents (
      id SERIAL PRIMARY KEY,
      name TEXT, title TEXT, skills TEXT, rate NUMERIC, rating NUMERIC, available BOOLEAN, bio TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      title TEXT, skills TEXT, budget TEXT, description TEXT,
      company_name TEXT, contact_name TEXT, contact_phone TEXT, workers_needed INT, location TEXT,
      client_email TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_name TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS contact_name TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS contact_phone TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workers_needed INT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location TEXT`;

    // Remove only the exact six fictional seed profiles shipped by the old demo version.
    // Real candidate records that do not match all identifying fields are untouched.
    const removedDemoProfiles = await sql`DELETE FROM talents WHERE
      (name = 'Alex Rivera' AND title = 'Senior Full-Stack Developer' AND skills = 'React,Node.js,TypeScript,AWS' AND rate = 95 AND bio = '10+ years building scalable web applications.') OR
      (name = 'Priya Sharma' AND title = 'UI/UX Designer' AND skills = 'Figma,Design Systems,User Research' AND rate = 75 AND bio = 'Specializes in product design and design systems.') OR
      (name = 'Marcus Chen' AND title = 'Data Scientist' AND skills = 'Python,Machine Learning,SQL' AND rate = 110 AND bio = 'ML engineer with production experience.') OR
      (name = 'Elena Volkov' AND title = 'Digital Marketing Strategist' AND skills = 'SEO,Paid Ads,Analytics' AND rate = 70 AND bio = 'Growth marketing for SaaS and e-commerce.') OR
      (name = 'James Okonkwo' AND title = 'DevOps Engineer' AND skills = 'Kubernetes,CI/CD,Terraform' AND rate = 105 AND bio = 'Infrastructure and deployment specialist.') OR
      (name = 'Sofia Alvarez' AND title = 'Product Manager' AND skills = 'Roadmapping,Agile,Analytics' AND rate = 90 AND bio = 'Technical PM with startup and enterprise experience.')
      RETURNING id`;
    if (removedDemoProfiles.length) console.log('Removed legacy fictional demo profiles:', removedDemoProfiles.length);
    await sql`CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      job_id INT, talent_id INT, status TEXT, paid BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(),
      commission_rate NUMERIC, talent_rate NUMERIC, client_rate NUMERIC, hours NUMERIC
    )`;
    await sql`CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      match_id INT, amount NUMERIC, paypal TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    // Do not seed fictional candidate profiles into a real agency directory.
    dbReady = true;
    console.log('Database connected');
  } catch (e) {
    console.error('DB init failed, falling back to memory:', e.message);
    dbReady = false;
  }
}

let mem = { talents: [], jobs: [], matches: [], invoices: [], nextId: 1 };
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const startTime = Date.now();

function createAdminToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + SESSION_TTL_MS, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_PASS).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function requireAdmin(req, res) {
  if (!ADMIN_PASS || ADMIN_PASS.length < 20) {
    sendJSON(res, 503, { error: 'Admin login requires a unique ADMIN_PASS of at least 20 characters in deployment environment variables.' });
    return false;
  }
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) { sendJSON(res, 401, { error: 'Authentication required' }); return false; }
  const expected = crypto.createHmac('sha256', ADMIN_PASS).update(match[1]).digest();
  const actual = Buffer.from(match[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    sendJSON(res, 401, { error: 'Invalid or expired session' });
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    const now = Date.now();
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + 60000 || payload.exp <= now || payload.exp - payload.iat !== SESSION_TTL_MS) {
      sendJSON(res, 401, { error: 'Invalid or expired session' });
      return false;
    }
  } catch {
    sendJSON(res, 401, { error: 'Invalid or expired session' });
    return false;
  }
  return true;
}

function bodyError(body, res) {
  if (body && body.__error === 'BODY_TOO_LARGE') {
    sendJSON(res, 413, { error: 'Request body too large' });
    return true;
  }
  if (body && body.__error === 'INVALID_JSON') {
    sendJSON(res, 400, { error: 'Invalid JSON body' });
    return true;
  }
  return false;
}

function sendJSON(res, status, obj) {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(JSON.stringify(obj));
  } catch {}
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > 100 * 1024) {
        tooLarge = true;
        body = '';
      }
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ __error: 'BODY_TOO_LARGE' });
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({ __error: 'INVALID_JSON' }); }
    });
    req.on('error', () => resolve({ __error: 'INVALID_JSON' }));
  });
}

async function getTalents() {
  if (dbReady) {
    const rows = await sql`SELECT * FROM talents ORDER BY id`;
    return rows.map(r => ({ ...r, skills: (r.skills || '').split(',').filter(Boolean) }));
  }
  return mem.talents;
}

async function getJobs() {
  if (dbReady) {
    const rows = await sql`SELECT * FROM jobs ORDER BY id DESC`;
    return rows.map(r => ({
      id: r.id, title: r.title, skills: (r.skills || '').split(',').filter(Boolean),
      budget: r.budget, description: r.description, status: r.status, createdAt: r.created_at,
      companyName: r.company_name || '', contactName: r.contact_name || '', contactPhone: r.contact_phone || '',
      workersNeeded: r.workers_needed || 0, location: r.location || '', clientEmail: r.client_email || '',
      suggestedMatches: []
    }));
  }
  return mem.jobs.map(j => ({ id: j.id, title: j.title, skills: j.skills, budget: j.budget, description: j.description, status: j.status, suggestedMatches: j.suggestedMatches || [] }));
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (pathname === '/health' || pathname === '/api/health') {
      return sendJSON(res, 200, { status: 'ok', db: dbReady, uptime: Math.floor((Date.now()-startTime)/1000) });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      if (bodyError(body, res)) return;
      if (!ADMIN_PASS || ADMIN_PASS.length < 20) return sendJSON(res, 503, { error: 'Admin login requires a unique ADMIN_PASS of at least 20 characters in deployment environment variables.' });
      if (typeof body.password === 'string' && Buffer.byteLength(body.password, 'utf8') <= 512 && body.password === ADMIN_PASS) {
        return sendJSON(res, 200, { token: createAdminToken() });
      }
      return sendJSON(res, 401, { error: 'Invalid credentials' });
    }

    if (pathname === '/api/talents' && req.method === 'GET') {
      return sendJSON(res, 200, await getTalents());
    }

    if (pathname === '/api/talents' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      if (!dbReady) return sendJSON(res, 503, { error: 'Persistent database unavailable; talent was not saved' });
      const body = await parseBody(req);
      if (bodyError(body, res)) return;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const rawSkills = typeof body.skills === 'string' ? body.skills.trim() : '';
      const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
      const rate = Number(body.rate);
      if (!name || name.length > 120 || !title || title.length > 120 || !rawSkills || rawSkills.length > 500 || bio.length > 1500 || !Number.isFinite(rate) || rate < 0 || rate > 10000000) {
        return sendJSON(res, 400, { error: 'Invalid talent details. Check name, title, skills, bio length and rate.' });
      }
      const skills = rawSkills.split(',').map(s=>s.trim()).filter(Boolean).join(',');
      if (dbReady) {
        const rows = await sql`INSERT INTO talents (name, title, skills, rate, rating, available, bio) VALUES (${name}, ${title}, ${skills}, ${rate}, 0, true, ${bio}) RETURNING *`;
        return sendJSON(res, 201, { ...rows[0], skills: skills.split(',') });
      }
      const t = { id: mem.nextId++, name, title, skills: skills.split(','), rate, available: true, bio };
      mem.talents.push(t);
      return sendJSON(res, 201, t);
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const jobs = await getJobs();
      const talents = await getTalents();
      for (const j of jobs) {
        j.suggestedMatches = talents.filter(t => t.available && (t.skills||[]).some(s => (j.skills||[]).includes(s))).map(t => ({ id: t.id, name: t.name, title: t.title, rate: t.rate }));
      }
      return sendJSON(res, 200, jobs);
    }

    if (pathname === '/api/jobs' && req.method === 'POST') {
      if (!dbReady) return sendJSON(res, 503, { error: 'Persistent database unavailable; job request was not saved' });
      const body = await parseBody(req);
      if (bodyError(body, res)) return;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const rawSkills = typeof body.skills === 'string' ? body.skills.trim() : '';
      const budget = typeof body.budget === 'string' ? body.budget.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
      const contactName = typeof body.contactName === 'string' ? body.contactName.trim() : '';
      const contactPhone = typeof body.contactPhone === 'string' ? body.contactPhone.trim() : '';
      const location = typeof body.location === 'string' ? body.location.trim() : '';
      const workersNeeded = Number(body.workersNeeded);
      const clientEmail = typeof body.clientEmail === 'string' ? body.clientEmail.trim() : '';
      if (!title || title.length > 150 || !rawSkills || rawSkills.length > 500 || !description || description.length > 3000 || budget.length > 100 ||
          !companyName || companyName.length > 180 || !contactName || contactName.length > 120 ||
          !contactPhone || !/^[0-9+() \-]{7,24}$/.test(contactPhone) || !location || location.length > 180 ||
          !Number.isSafeInteger(workersNeeded) || workersNeeded < 1 || workersNeeded > 5000 ||
          !clientEmail || clientEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
        return sendJSON(res, 400, { error: 'Please provide a valid company, contact person, email, phone, work location, worker count, title, skills and description.' });
      }
      const skills = rawSkills.split(',').map(s=>s.trim()).filter(Boolean).join(',');
      if (dbReady) {
        const rows = await sql`INSERT INTO jobs (title, skills, budget, description, company_name, contact_name, contact_phone, workers_needed, location, client_email, status) VALUES (${title}, ${skills}, ${budget}, ${description}, ${companyName}, ${contactName}, ${contactPhone}, ${workersNeeded}, ${location}, ${clientEmail}, 'open') RETURNING *`;
        const job = { id: rows[0].id, title: rows[0].title, skills: skills.split(','), budget: rows[0].budget, description: rows[0].description, status: rows[0].status, createdAt: rows[0].created_at };
        const talents = await getTalents();
        job.suggestedMatches = talents.filter(t => t.available && (t.skills||[]).some(s => job.skills.includes(s))).map(t => ({ id: t.id, name: t.name, title: t.title, rate: t.rate }));
        await notifyManpowerRequest({ id: job.id, companyName, contactName, clientEmail, contactPhone, location, title, workersNeeded, skills: skills.split(','), budget, description });
        return sendJSON(res, 201, job);
      }
      const job = { id: mem.nextId++, title, skills: skills.split(','), budget, description, status: 'open', suggestedMatches: [] };
      mem.jobs.push(job);
      return sendJSON(res, 201, job);
    }

    if (pathname === '/api/matches' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      if (!dbReady) return sendJSON(res, 503, { error: 'Persistent database unavailable; match was not created' });
      const body = await parseBody(req);
      if (bodyError(body, res)) return;
      const jobId = Number(body.jobId);
      const talentId = Number(body.talentId);
      const hours = body.hours === undefined ? 40 : Number(body.hours);
      if (!Number.isSafeInteger(jobId) || jobId <= 0 || !Number.isSafeInteger(talentId) || talentId <= 0 || !Number.isFinite(hours) || hours <= 0 || hours > 10000) {
        return sendJSON(res, 400, { error: 'Valid jobId, talentId and positive hours are required' });
      }
      const jobs = await sql`SELECT id, status FROM jobs WHERE id = ${jobId}`;
      if (!jobs.length) return sendJSON(res, 404, { error: 'Job not found' });
      if (jobs[0].status !== 'open') return sendJSON(res, 409, { error: 'Job is not open for matching' });
      const talents = await getTalents();
      const talent = talents.find(t => Number(t.id) === talentId);
      if (!talent) return sendJSON(res, 404, { error: 'Talent not found' });
      if (talent.available === false) return sendJSON(res, 409, { error: 'Talent is already engaged' });
      const clientRate = Math.round(Number(talent.rate) / (1 - COMMISSION_RATE));
      if (dbReady) {
        await sql`UPDATE talents SET available = false WHERE id = ${talent.id}`;
        await sql`UPDATE jobs SET status = 'matched' WHERE id = ${jobId}`;
        const mrows = await sql`INSERT INTO matches (job_id, talent_id, status, commission_rate, talent_rate, client_rate, hours) VALUES (${jobId}, ${talent.id}, 'active', ${COMMISSION_RATE}, ${talent.rate}, ${clientRate}, ${hours}) RETURNING *`;
        const amount = Math.round(clientRate * hours * COMMISSION_RATE);
        await sql`INSERT INTO invoices (match_id, amount, paypal, status) VALUES (${mrows[0].id}, ${amount}, ${PAYPAL_EMAIL}, 'pending')`;
        return sendJSON(res, 201, mrows[0]);
      }
      return sendJSON(res, 201, { id: mem.nextId++, jobId: body.jobId, talentId: talent.id, clientRate, talentRate: talent.rate, hours });
    }

    if (pathname === '/api/matches' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      if (dbReady) {
        const rows = await sql`SELECT * FROM matches ORDER BY id DESC`;
        return sendJSON(res, 200, rows.map(r => ({ ...r, jobId: r.job_id, talentId: r.talent_id, clientRate: r.client_rate, talentRate: r.talent_rate, commissionRate: r.commission_rate })));
      }
      return sendJSON(res, 200, mem.matches);
    }

    if (pathname === '/api/matches/pay' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      if (bodyError(body, res)) return;
      const matchId = Number(body.matchId);
      if (!Number.isInteger(matchId) || matchId <= 0) return sendJSON(res, 400, { error: 'Valid matchId required' });
      if (!dbReady) return sendJSON(res, 503, { error: 'Persistent database unavailable; payment status was not changed' });
      const rows = await sql`SELECT id FROM matches WHERE id = ${matchId}`;
      if (!rows.length) return sendJSON(res, 404, { error: 'Match not found' });
      await sql`UPDATE matches SET paid = true WHERE id = ${matchId}`;
      await sql`UPDATE invoices SET status = 'paid' WHERE match_id = ${matchId}`;
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/invoices' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      if (dbReady) {
        const rows = await sql`SELECT * FROM invoices ORDER BY id DESC`;
        return sendJSON(res, 200, rows);
      }
      return sendJSON(res, 200, []);
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const talents = await getTalents();
      const jobs = await getJobs();
      let matches = [];
      if (dbReady) {
        matches = await sql`SELECT * FROM matches`;
      }
      let total = 0;
      matches.forEach(m => { total += (m.client_rate || m.clientRate || 0) * (m.hours || 40) * COMMISSION_RATE; });
      return sendJSON(res, 200, {
        talentCount: talents.length,
        openJobs: jobs.filter(j => j.status === 'open').length,
        activeMatches: matches.filter(m => m.status === 'active').length,
        totalCommission: Math.round(total),
        db: dbReady
      });
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      return res.end(html);
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Internal error' });
  }
});

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`TalentBridge running on ${PORT} | DB: ${dbReady ? 'connected' : 'memory'}`);
  });
});
