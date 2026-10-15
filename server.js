const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PAYPAL_EMAIL = 'rachelrob@live.com';
const COMMISSION_RATE = 0.22;
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = 'talentbridge2026';
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      talents: [
        { id: 1, name: "Alex Rivera", title: "Senior Full-Stack Developer", skills: ["React", "Node.js", "TypeScript", "AWS"], rate: 95, rating: 4.9, available: true, bio: "10+ years building scalable web applications." },
        { id: 2, name: "Priya Sharma", title: "UI/UX Designer", skills: ["Figma", "Design Systems", "User Research"], rate: 75, rating: 4.8, available: true, bio: "Specializes in product design and design systems." },
        { id: 3, name: "Marcus Chen", title: "Data Scientist", skills: ["Python", "Machine Learning", "SQL"], rate: 110, rating: 5.0, available: true, bio: "ML engineer with production experience." },
        { id: 4, name: "Elena Volkov", title: "Digital Marketing Strategist", skills: ["SEO", "Paid Ads", "Analytics"], rate: 70, rating: 4.7, available: true, bio: "Growth marketing for SaaS and e-commerce." },
        { id: 5, name: "James Okonkwo", title: "DevOps Engineer", skills: ["Kubernetes", "CI/CD", "Terraform"], rate: 105, rating: 4.9, available: true, bio: "Infrastructure and deployment specialist." },
        { id: 6, name: "Sofia Alvarez", title: "Product Manager", skills: ["Roadmapping", "Agile", "Analytics"], rate: 90, rating: 4.8, available: true, bio: "Technical PM with startup and enterprise experience." }
      ],
      jobs: [],
      matches: [],
      payments: [],
      invoices: [],
      nextId: 7
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
let data = loadData();

const sessions = new Map();

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
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

  if (pathname === '/api/talents' && req.method === 'POST') {
    const body = await parseBody(req);
    const talent = { id: data.nextId++, name: body.name, title: body.title, skills: (body.skills||'').split(',').map(s=>s.trim()).filter(Boolean), rate: Number(body.rate)||0, rating: 0, available: true, bio: body.bio||'' };
    data.talents.push(talent); saveData(data); return sendJSON(res, 201, talent);
  }

  if (pathname === '/api/jobs' && req.method === 'POST') {
    const body = await parseBody(req);
    const job = { id: data.nextId++, title: body.title, skills: (body.skills||'').split(',').map(s=>s.trim()).filter(Boolean), budget: body.budget, description: body.description, clientEmail: body.clientEmail||'', status: 'open', createdAt: new Date().toISOString() };
    job.suggestedMatches = data.talents.filter(t => t.available && t.skills.some(s => job.skills.includes(s))).map(m => ({ id: m.id, name: m.name, title: m.title, rate: m.rate }));
    data.jobs.push(job); saveData(data); return sendJSON(res, 201, job);
  }

  if (pathname === '/api/matches' && req.method === 'POST') {
    const body = await parseBody(req);
    const talent = data.talents.find(t => t.id === Number(body.talentId));
    const clientRate = talent ? Math.round(talent.rate / (1 - COMMISSION_RATE)) : 0;
    const match = { id: data.nextId++, jobId: Number(body.jobId), talentId: Number(body.talentId), status: 'active', paid: false, createdAt: new Date().toISOString(), commissionRate: COMMISSION_RATE, talentRate: talent?.rate || 0, clientRate, hours: Number(body.hours)||40 };
    data.matches.push(match);
    if (talent) talent.available = false;
    const job = data.jobs.find(j => j.id === match.jobId); if (job) job.status = 'matched';
    const invoice = { id: data.nextId++, matchId: match.id, amount: Math.round(match.clientRate * match.hours * match.commissionRate), paypal: PAYPAL_EMAIL, status: 'pending', createdAt: new Date().toISOString() };
    if (!data.invoices) data.invoices = [];
    data.invoices.push(invoice);
    saveData(data);
    return sendJSON(res, 201, { match, invoice });
  }

  if (pathname === '/api/matches/pay' && req.method === 'POST') {
    const body = await parseBody(req);
    const match = data.matches.find(m => m.id === Number(body.matchId));
    if (!match) return sendJSON(res, 404, { error: 'Not found' });
    match.paid = true; match.paidAt = new Date().toISOString();
    const inv = (data.invoices||[]).find(i => i.matchId === match.id);
    if (inv) inv.status = 'paid';
    const payment = { id: data.nextId++, matchId: match.id, amount: Math.round(match.clientRate * match.hours * match.commissionRate), paypal: PAYPAL_EMAIL, status: 'recorded', createdAt: new Date().toISOString() };
    if (!data.payments) data.payments = [];
    data.payments.push(payment);
    saveData(data);
    return sendJSON(res, 200, { match, payment });
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    let total = 0;
    data.matches.forEach(m => { total += (m.clientRate||0) * (m.hours||40) * m.commissionRate; });
    return sendJSON(res, 200, {
      talentCount: data.talents.length,
      openJobs: data.jobs.filter(j=>j.status==='open').length,
      activeMatches: data.matches.filter(m=>m.status==='active').length,
      totalMatches: data.matches.length,
      totalCommission: Math.round(total),
      paidCommission: (data.payments||[]).reduce((s,p)=>s+p.amount,0),
      paypal: PAYPAL_EMAIL,
      invoices: (data.invoices||[]).length
    });
  }

  if (pathname === '/api/invoices' && req.method === 'GET') return sendJSON(res, 200, data.invoices||[]);

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`TalentBridge COMPLETE at http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASS}`);
  console.log(`Revenue: ${PAYPAL_EMAIL}`);
});
