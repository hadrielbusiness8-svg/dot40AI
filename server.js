// Dot.40 server
// Serves index.html AND proxies chat/search requests.
// This exact file runs the same way locally and on Render.
//
// The API key comes from an environment variable, never from code:
//   - Locally: create a file called apikey.txt next to this file containing
//     just your key (nothing else). It's git-ignored, so it never gets
//     pushed to GitHub.
//   - On Render: set an environment variable named GEMINI_API_KEY in the
//     dashboard (Settings -> Environment). Render's value always wins.
//
// Run locally:  node server.js   then open http://localhost:8787

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;

function getApiKey(){
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    return fs.readFileSync(path.join(__dirname, 'apikey.txt'), 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function readBody(req){
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
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

  // ---- Image generation (Gemini's Nano Banana model) ----
  if (req.method === 'POST' && req.url === '/image') {
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

    const genPayload = {
      contents: [{ parts: [{ text: payload.prompt || '' }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    };
    const body = JSON.stringify(genPayload);
    const forwardReq = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/gemini-2.5-flash-image:generateContent',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
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
      res.end(JSON.stringify({ error: 'Could not reach Gemini image model: ' + err.message }));
    });
    forwardReq.write(body);
    forwardReq.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Dot.40 running at http://localhost:${PORT}`);
});
