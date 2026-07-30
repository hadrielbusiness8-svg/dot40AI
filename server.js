// Dot.40 server
// Serves index.html AND proxies chat requests to Gemini.
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Dot.40 running at http://localhost:${PORT}`);
});
