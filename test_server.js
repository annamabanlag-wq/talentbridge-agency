const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ADMIN_SECRET = 'test-admin-password-longer-than-twenty-characters';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startApp(adminPass) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      ADMIN_PASS: adminPass
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited early: ' + logs);
    try {
      const response = await fetch(base + '/health');
      if (response.ok) {
        return {
          base,
          child,
          stop: () => new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            child.kill('SIGTERM');
            setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000).unref();
          })
        };
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('Server did not become ready: ' + logs);
}

async function jsonRequest(base, pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
}

test('admin routes require a valid stateless bearer token', async t => {
  const app = await startApp(ADMIN_SECRET);
  t.after(() => app.stop());

  const health = await jsonRequest(app.base, '/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.db, false);

  for (const [pathname, method, body] of [
    ['/api/stats', 'GET'],
    ['/api/matches', 'GET'],
    ['/api/jobs', 'GET'],
    ['/api/invoices', 'GET'],
    ['/api/talents', 'POST', { name: 'Test', title: 'Tester', skills: 'testing', rate: 1 }],
    ['/api/matches', 'POST', { jobId: 1, talentId: 1, hours: 1 }],
    ['/api/matches/pay', 'POST', { matchId: 1 }]
  ]) {
    const result = await jsonRequest(app.base, pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(result.response.status, 401, pathname + ' must reject unauthenticated access');
  }

  const badLogin = await jsonRequest(app.base, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' })
  });
  assert.equal(badLogin.response.status, 401);

  const login = await jsonRequest(app.base, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_SECRET })
  });
  assert.equal(login.response.status, 200);
  assert.equal(typeof login.body.token, 'string');

  const authorizedStats = await jsonRequest(app.base, '/api/stats', {
    headers: { Authorization: 'Bearer ' + login.body.token }
  });
  assert.equal(authorizedStats.response.status, 200);
  assert.equal(authorizedStats.body.db, false);

  const malformedToken = await jsonRequest(app.base, '/api/stats', {
    headers: { Authorization: 'Bearer 0123456789abcdef0123456789abcdef' }
  });
  assert.equal(malformedToken.response.status, 401);

  const noDatabaseWrite = await jsonRequest(app.base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test role', skills: 'testing', description: 'Safe test' })
  });
  assert.equal(noDatabaseWrite.response.status, 503);
});

test('admin login fails closed when the secret is missing or weak', async t => {
  const app = await startApp('');
  t.after(() => app.stop());

  const login = await jsonRequest(app.base, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'anything' })
  });
  assert.equal(login.response.status, 503);
  assert.match(login.body.error, /ADMIN_PASS/);

  const protectedRoute = await jsonRequest(app.base, '/api/stats');
  assert.equal(protectedRoute.response.status, 503);
});

test('frontend does not expose the old demo password and escapes submitted text', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.equal(html.includes('talentbridge2026'), false);
  assert.equal(html.includes('localStorage'), false);
  assert.match(html, /function show\(id\)/);
  assert.match(html, /aria-label="Main navigation"/);
  assert.match(html, /onclick="show\('dashboard'\)" class="shrink-0/);
  assert.match(html, /escapeHtml/);
  assert.equal(server.includes('const seed = ['), false);
  assert.match(server, /DELETE FROM talents WHERE/);
  assert.equal(server.includes("Access-Control-Allow-Origin': '*'"), false);
  assert.match(server, /async function notifyManpowerRequest/);
  assert.match(server, /MANPOWER_ALERT_EMAIL/);
  assert.match(server, /RESEND_API_KEY/);
  assert.match(server, /RESEND_FROM/);
  assert.match(server, /GOOGLE_APPS_SCRIPT_URL/);
  assert.match(server, /GOOGLE_APPS_SCRIPT_SECRET/);
  assert.match(server, /await notifyManpowerRequest/);
  const gas = fs.readFileSync(path.join(__dirname, 'google-apps-script', 'Code.gs'), 'utf8');
  assert.match(gas, /TALENTBRIDGE_SHARED_SECRET/);
  assert.ok(gas.includes('easytiger.business@gmail.com'));
  assert.ok(gas.includes('MailApp.sendEmail'));
});

test('request bodies over 100 KB are rejected', async t => {
  const app = await startApp(ADMIN_SECRET);
  t.after(() => app.stop());

  const response = await fetch(app.base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(105 * 1024) })
  });
  assert.equal(response.status, 413);
});
