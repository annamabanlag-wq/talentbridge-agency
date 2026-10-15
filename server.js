const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || 'rachelrob@live.com';
const COMMISSION_RATE = 0.22;
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'talentbridge2026';
const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_FILE = path.join(__dirname, 'data.backup.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.talents)) return parsed;
    }
  } catch (e) {
    console.error('Data load failed, trying backup:', e.message);
  }
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.talents)) {
        console.log('Recovered from backup');
        return parsed;
      }
    }
  } catch (e) {
    console.error('Backup load failed:', e.message);
  }
  return {
    talents: [
      { id: 1, name: "Alex Rivera", title: "Senior Full-Stack Developer", skills: ["React", "Node.js", "TypeScript", "AWS"], rate: 95, rating: 4.9, available: true, bio: "10+ years building scalable web applications." },
      { id: 2, name: "Priya Sharma", title: "UI/UX Designer", skills: ["Figma", "Design Systems", "User Research"], rate: 75, rating: 4.8, available: true, bio: "Specializes in product design and design systems." },
      { id: 3, name: "Marcus Chen", title: "Data Scientist", skills: ["Python", "Machine Learning", "SQL"], rate: 110, rating: 5.0, available: true, bio: "ML engineer with production experience." },
      { id: 4, name: "Elena Volkov", title: "Digital Marketing Strategist", skills: ["SEO", "Paid Ads", "Analytics"], rate: 70, rating: 4.7, available: true, bio: "Growth marketing for SaaS and e-commerce." },
      { id: 5, name: "James Okonkwo", title: "DevOps Engineer", skills: ["Kubernetes", "CI/CD", "Terraform"], rate: 105, rating: 4.9, available: true, bio: "Infrastructure and deployment specialist." },
      { id: 6, name: "Sofia Alvarez", title: "Product Manager", skills: ["Roadmapping", "Agile", "Analytics"], rate: 90, rating: 4.8, available: true, bio: "Technical PM with startup and enterprise experience." }
    ],
    jobs: [], matches: [], payments: [], invoices: [], nextId: 7
  };
}

function saveData(d) {
  try {
    // On serverless (Vercel) filesystem may be read-only — skip safely so the app stays up
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      console.log('Serverless: data kept in memory');
      return;
    }
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Save failed (continuing in memory):', e.message);
  }
}

let data = loadData();
const sessions = new Map();
const startTime = Date.now();

function sendJSON(res, status, obj) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(JSON.stringify(obj));
  } catch (e) {
    console.error('sendJSON error:', e.message);
  }
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; resolve({}); }
    }, 10000);
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timeout); resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    if (pathname === '/health' || pathname === '/api/health') {
      return sendJSON(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        talents: data.talents.length,
        jobs: data.jobs.length,
        matches: data.matches.length,
        paypal: PAYPAL_EMAIL
      });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.password === ADMIN_PASS) {
        const token = crypto.randomBytes(16).toString('hex');
        sessions.set(token, { role: 'admin', created: Date.now() });
        return sendJSON(res, 200, { token, role: 'admin' });
      }
      return sendJSON(res, 401, { error: 'Invalid password' });
    }

    if (pathname === '/api/talents' && req.method === 'GET') return sendJSON(res, 200, data.talents);
    if (pathname === '/api/jobs' && req.method === 'GET') return sendJSON(res, 200, data.jobs);
    if (pathname === '/api/matches' && req.method === 'GET') return sendJSON(res, 200, data.matches);
    if (pathname === '/api/paypal' && req.method === 'GET') return sendJSON(res, 200, { email: PAYPAL_EMAIL, rate: COMMISSION_RATE });
    if (pathname === '/api/invoices' && req.method === 'GET') return sendJSON(res, 200, data.invoices || []);

    if (pathname === '/api/talents' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.name || !body.title) return sendJSON(res, 400, { error: 'Name and title required' });
      const talent = {
        id: data.nextId++,
        name: String(body.name).slice(0, 100),
        title: String(body.title).slice(0, 100),
        skills: (body.skills || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 15),
        rate: Math.max(0, Number(body.rate) || 0),
        rating: 0,
        available: true,
        bio: String(body.bio || '').slice(0, 500)
      };
      data.talents.push(talent);
      saveData(data);
      return sendJSON(res, 201, talent);
    }

    if (pathname === '/api/jobs' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.title) return sendJSON(res, 400, { error: 'Title required' });
      const job = {
        id: data.nextId++,
        title: String(body.title).slice(0, 150),
        skills: (body.skills || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 15),
        budget: body.budget || '',
        description: String(body.description || '').slice(0, 1000),
        clientEmail: body.clientEmail || '',
        status: 'open',
        createdAt: new Date().toISOString()
      };
      job.suggestedMatches = data.talents
        .filter(t => t.available && t.skills.some(s => job.skills.includes(s)))
        .map(m => ({ id: m.id, name: m.name, title: m.title, rate: m.rate }));
      data.jobs.push(job);
      saveData(data);
      return sendJSON(res, 201, job);
    }

    if (pathname === '/api/matches' && req.method === 'POST') {
      const body = await parseBody(req);
      const talent = data.talents.find(t => t.id === Number(body.talentId));
      if (!talent) return sendJSON(res, 400, { error: 'Talent not found' });
      const clientRate = Math.round(talent.rate / (1 - COMMISSION_RATE));
      const match = {
        id: data.nextId++,
        jobId: Number(body.jobId),
        talentId: talent.id,
        status: 'active',
        paid: false,
        createdAt: new Date().toISOString(),
        commissionRate: COMMISSION_RATE,
        talentRate: talent.rate,
        clientRate,
        hours: Math.max(1, Number(body.hours) || 40)
      };
      data.matches.push(match);
      talent.available = false;
      const job = data.jobs.find(j => j.id === match.jobId);
      if (job) job.status = 'matched';
      const invoice = {
        id: data.nextId++,
        matchId: match.id,
        amount: Math.round(match.clientRate * match.hours * match.commissionRate),
        paypal: PAYPAL_EMAIL,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      if (!data.invoices) data.invoices = [];
      data.invoices.push(invoice);
      saveData(data);
      return sendJSON(res, 201, { match, invoice });
    }

    if (pathname === '/api/matches/pay' && req.method === 'POST') {
      const body = await parseBody(req);
      const match = data.matches.find(m => m.id === Number(body.matchId));
      if (!match) return sendJSON(res, 404, { error: 'Match not found' });
      match.paid = true;
      match.paidAt = new Date().toISOString();
      const inv = (data.invoices || []).find(i => i.matchId === match.id);
      if (inv) inv.status = 'paid';
      const payment = {
        id: data.nextId++,
        matchId: match.id,
        amount: Math.round(match.clientRate * match.hours * match.commissionRate),
        paypal: PAYPAL_EMAIL,
        status: 'recorded',
        createdAt: new Date().toISOString()
      };
      if (!data.payments) data.payments = [];
      data.payments.push(payment);
      saveData(data);
      return sendJSON(res, 200, { match, payment });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      let total = 0;
      data.matches.forEach(m => { total += (m.clientRate || 0) * (m.hours || 40) * m.commissionRate; });
      return sendJSON(res, 200, {
        talentCount: data.talents.length,
        openJobs: data.jobs.filter(j => j.status === 'open').length,
        activeMatches: data.matches.filter(m => m.status === 'active').length,
        totalMatches: data.matches.length,
        totalCommission: Math.round(total),
        paidCommission: (data.payments || []).reduce((s, p) => s + (p.amount || 0), 0),
        paypal: PAYPAL_EMAIL,
        invoices: (data.invoices || []).length,
        uptime: Math.floor((Date.now() - startTime) / 1000)
      });
    }

    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = path.join(__dirname, 'public', 'index.html');
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(htmlPath, 'utf8'));
      }
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Request error:', err.message);
    try { sendJSON(res, 500, { error: 'Internal error' }); } catch {}
  }
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TalentBridge stable at http://0.0.0.0:${PORT}`);
  console.log(`Health: /health`);
  console.log(`Revenue: ${PAYPAL_EMAIL}`);
});
