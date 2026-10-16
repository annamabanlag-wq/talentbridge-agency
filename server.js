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
      title TEXT, skills TEXT, budget TEXT, description TEXT, client_email TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      job_id INT, talent_id INT, status TEXT, paid BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(),
      commission_rate NUMERIC, talent_rate NUMERIC, client_rate NUMERIC, hours NUMERIC
    )`;
    await sql`CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      match_id INT, amount NUMERIC, paypal TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    const count = await sql`SELECT COUNT(*) FROM talents`;
    if (Number(count[0].count) === 0) {
      const seed = [
        ["Alex Rivera", "Senior Full-Stack Developer", "React,Node.js,TypeScript,AWS", 95, 4.9, true, "10+ years building scalable web applications."],
        ["Priya Sharma", "UI/UX Designer", "Figma,Design Systems,User Research", 75, 4.8, true, "Specializes in product design and design systems."],
        ["Marcus Chen", "Data Scientist", "Python,Machine Learning,SQL", 110, 5.0, true, "ML engineer with production experience."],
        ["Elena Volkov", "Digital Marketing Strategist", "SEO,Paid Ads,Analytics", 70, 4.7, true, "Growth marketing for SaaS and e-commerce."],
        ["James Okonkwo", "DevOps Engineer", "Kubernetes,CI/CD,Terraform", 105, 4.9, true, "Infrastructure and deployment specialist."],
        ["Sofia Alvarez", "Product Manager", "Roadmapping,Agile,Analytics", 90, 4.8, true, "Technical PM with startup and enterprise experience."]
      ];
      for (const t of seed) {
        await sql`INSERT INTO talents (name, title, skills, rate, rating, available, bio) VALUES (${t[0]}, ${t[1]}, ${t[2]}, ${t[3]}, ${t[4]}, ${t[5]}, ${t[6]})`;
      }
      console.log('Database seeded');
    }
    dbReady = true;
    console.log('Database connected');
  } catch (e) {
    console.error('DB init failed, falling back to memory:', e.message);
    dbReady = false;
  }
}

let mem = { talents: [], jobs: [], matches: [], invoices: [], nextId: 1 };
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const startTime = Date.now();

function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer ([a-f0-9]{32})$/i);
  if (!match) { sendJSON(res, 401, { error: 'Authentication required' }); return false; }
  const createdAt = sessions.get(match[1]);
  if (!createdAt || Date.now() - createdAt > SESSION_TTL_MS) {
    sessions.delete(match[1]);
    sendJSON(res, 401, { error: 'Session expired; please sign in again' });
    return false;
  }
  return true;
}

function sendJSON(res, status, obj) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(JSON.stringify(obj));
  } catch {}
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
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
    return rows.map(r => ({ ...r, skills: (r.skills || '').split(',').filter(Boolean), suggestedMatches: [] }));
  }
  return mem.jobs;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }

    if (pathname === '/health' || pathname === '/api/health') {
      return sendJSON(res, 200, { status: 'ok', db: dbReady, uptime: Math.floor((Date.now()-startTime)/1000) });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!ADMIN_PASS) return sendJSON(res, 503, { error: 'Admin login is not configured. Set ADMIN_PASS in deployment environment variables.' });
      if (typeof body.password === 'string' && body.password === ADMIN_PASS) {
        const token = crypto.randomBytes(16).toString('hex');
        sessions.set(token, Date.now());
        return sendJSON(res, 200, { token });
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
      const skills = (body.skills || '').split(',').map(s=>s.trim()).filter(Boolean).join(',');
      if (dbReady) {
        const rows = await sql`INSERT INTO talents (name, title, skills, rate, rating, available, bio) VALUES (${body.name}, ${body.title}, ${skills}, ${Number(body.rate)||0}, 0, true, ${body.bio||''}) RETURNING *`;
        return sendJSON(res, 201, { ...rows[0], skills: skills.split(',') });
      }
      const t = { id: mem.nextId++, name: body.name, title: body.title, skills: skills.split(','), rate: Number(body.rate)||0, available: true, bio: body.bio||'' };
      mem.talents.push(t);
      return sendJSON(res, 201, t);
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
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
      const skills = (body.skills || '').split(',').map(s=>s.trim()).filter(Boolean).join(',');
      if (dbReady) {
        const rows = await sql`INSERT INTO jobs (title, skills, budget, description, client_email, status) VALUES (${body.title}, ${skills}, ${body.budget||''}, ${body.description||''}, ${body.clientEmail||''}, 'open') RETURNING *`;
        const job = { ...rows[0], skills: skills.split(',') };
        const talents = await getTalents();
        job.suggestedMatches = talents.filter(t => t.available && (t.skills||[]).some(s => job.skills.includes(s))).map(t => ({ id: t.id, name: t.name, title: t.title, rate: t.rate }));
        return sendJSON(res, 201, job);
      }
      const job = { id: mem.nextId++, title: body.title, skills: skills.split(','), budget: body.budget, description: body.description, status: 'open', suggestedMatches: [] };
      mem.jobs.push(job);
      return sendJSON(res, 201, job);
    }

    if (pathname === '/api/matches' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      if (!dbReady) return sendJSON(res, 503, { error: 'Persistent database unavailable; match was not created' });
      const body = await parseBody(req);
      const talents = await getTalents();
      const talent = talents.find(t => t.id === Number(body.talentId));
      if (!talent) return sendJSON(res, 400, { error: 'Talent not found' });
      const clientRate = Math.round(talent.rate / (1 - COMMISSION_RATE));
      const hours = Number(body.hours) || 40;
      if (dbReady) {
        await sql`UPDATE talents SET available = false WHERE id = ${talent.id}`;
        await sql`UPDATE jobs SET status = 'matched' WHERE id = ${Number(body.jobId)}`;
        const mrows = await sql`INSERT INTO matches (job_id, talent_id, status, commission_rate, talent_rate, client_rate, hours) VALUES (${Number(body.jobId)}, ${talent.id}, 'active', ${COMMISSION_RATE}, ${talent.rate}, ${clientRate}, ${hours}) RETURNING *`;
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
