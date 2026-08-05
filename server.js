// Dot.40 server
// Serves index.html, proxies chat/search requests, and gates everything
// behind a simple password login so random visitors can't use your API quota.
//
// The API key comes from an environment variable, never from code:
//   - Locally: create a file called apikey.txt next to this file containing
//     just your key (nothing else). It's git-ignored, so it never gets
//     pushed to GitHub.
//   - On Render: set an environment variable named GEMINI_API_KEY in the
//     dashboard (Settings -> Environment). Render's value always wins.
//
// The login password works the same way:
//   - Locally: create a file called password.txt with your chosen password.
//   - On Render: set an environment variable named ACCESS_PASSWORD.
//
// Run locally:  node server.js   then open http://localhost:8787

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const SESSION_COOKIE = 'dot40_session';
const validSessions = new Set(); // resets if the server restarts — fine for personal use

function getApiKey(){
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    return fs.readFileSync(path.join(__dirname, 'apikey.txt'), 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function getAccessPassword(){
  if (process.env.ACCESS_PASSWORD) return process.env.ACCESS_PASSWORD;
  try {
    return fs.readFileSync(path.join(__dirname, 'password.txt'), 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function getCookie(req, name){
  const header = req.headers.cookie || '';
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function isLoggedIn(req){
  const requiredPassword = getAccessPassword();
  if (!requiredPassword) return true; // no password configured -> app stays open
  const token = getCookie(req, SESSION_COOKIE);
  return !!token && validSessions.has(token);
}

function readBody(req){
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function serveLoginPage(res, errorMsg){
  const err = errorMsg
    ? `<div style="color:#ffb3b3;font-family:sans-serif;font-size:13px;margin-top:10px;text-align:center;">${errorMsg}</div>`
    : '';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dot.40 — Sign in</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0d0e12;color:#e9eaef;font-family:'Inter',sans-serif;height:100vh;display:flex;align-items:center;justify-content:center;}
  .card{width:100%;max-width:320px;padding:32px;text-align:center;}
  .dot{width:16px;height:16px;border-radius:50%;background:#5b5fff;box-shadow:0 0 0 4px rgba(91,95,255,0.14),0 0 18px rgba(91,95,255,0.6);margin:0 auto 14px;}
  h1{font-family:'Space Grotesk',sans-serif;font-size:20px;margin-bottom:22px;}
  input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #282c38;background:#1c1f29;color:#e9eaef;font-size:14px;outline:none;margin-bottom:12px;}
  input:focus{border-color:#5b5fff;}
  button{width:100%;padding:12px;border-radius:10px;border:none;background:#5b5fff;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
  button:hover{filter:brightness(1.08);}
</style></head>
<body>
  <div class="card">
    <div class="dot"></div>
    <h1>Sign in to Dot.40</h1>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Enter</button>
    </form>
    ${err}
  </div>
</body></html>`);
}

const server = http.createServer(async (req, res) => {
  // ---- Login page ----
  if (req.method === 'GET' && req.url === '/login') {
    serveLoginPage(res);
    return;
  }
  if (req.method === 'POST' && req.url === '/login') {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const attempt = params.get('password') || '';
    const required = getAccessPassword();

    const ok = required &&
      attempt.length === required.length &&
      crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(required));

    if (ok) {
      const token = crypto.randomBytes(24).toString('hex');
      validSessions.add(token);
      res.writeHead(302, {
        'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`,
        'Location': '/'
      });
      res.end();
    } else {
      serveLoginPage(res, 'Wrong password — try again.');
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/logout') {
    const token = getCookie(req, SESSION_COOKIE);
    if (token) validSessions.delete(token);
    res.writeHead(302, {
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
      'Location': '/login'
    });
    res.end();
    return;
  }

  // ---- Everything below requires login (if a password is configured) ----
  if (!isLoggedIn(req)) {
    if (req.url === '/chat' || req.url.startsWith('/search')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not signed in' }));
    } else {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
    }
    return;
  }

  // ---- Serve the app ----
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Could not load index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ---- SEO files ----
  if (req.method === 'GET' && req.url === '/robots.txt') {
    fs.readFile(path.join(__dirname, 'robots.txt'), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/sitemap.xml') {
    fs.readFile(path.join(__dirname, 'sitemap.xml'), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(data);
    });
    return;
  }

  // ---- Chat proxy (OpenAI-compatible Gemini endpoint) ----
  if (req.method === 'POST' && req.url === '/chat') {
    const apiKey = getApiKey();
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No Gemini API key set. Locally: create apikey.txt with your key. On Render: set GEMINI_API_KEY in the dashboard.'
      }));
      return;
    }

    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request body' }));
      return;
    }

    const body = JSON.stringify(payload);
    const forwardReq = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: '/v1beta/openai/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(body)
        }
      },
      upstreamRes => {
        let data = '';
        upstreamRes.on('data', chunk => { data += chunk; });
        upstreamRes.on('end', () => {
          res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      }
    );
    forwardReq.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not reach Gemini: ' + err.message }));
    });
    forwardReq.write(body);
    forwardReq.end();
    return;
  }

  // ---- Web search (free, keyless, via DuckDuckGo's Instant Answer API) ----
  if (req.method === 'GET' && req.url.startsWith('/search')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const q = urlObj.searchParams.get('q') || '';
    if (!q.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query' }));
      return;
    }
    const ddgPath = '/?q=' + encodeURIComponent(q) + '&format=json&no_html=1&skip_disambig=1';
    https.get({ hostname: 'api.duckduckgo.com', path: ddgPath, headers: { 'User-Agent': 'Dot40/1.0' } }, upstreamRes => {
      let data = '';
      upstreamRes.on('data', chunk => { data += chunk; });
      upstreamRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }).on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not reach search: ' + err.message }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Dot.40 running at http://localhost:${PORT}`);
});
