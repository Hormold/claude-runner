/**
 * Agent Starter — HTTP Server
 *
 * Thin HTTP API that receives questions and routes them to sessions.
 * Replace or wrap this with your own connector (Slack, webhook, etc.)
 */

import { createServer } from 'http';
import { ask, getHistory, deleteSession, listSessions } from './session.mjs';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Read JSON body from request
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Route handler
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // POST /api/ask — main endpoint
    if (method === 'POST' && path === '/api/ask') {
      const body = await readBody(req);

      if (!body.sessionId || !body.message) {
        return json(res, 400, { error: 'Required: sessionId, message' });
      }

      const result = await ask(body.sessionId, body.message, body.context);
      return json(res, 200, result);
    }

    // GET /api/session/:id/history
    const historyMatch = path.match(/^\/api\/session\/([^/]+)\/history$/);
    if (method === 'GET' && historyMatch) {
      const history = getHistory(historyMatch[1]);
      return json(res, 200, history);
    }

    // DELETE /api/session/:id
    const deleteMatch = path.match(/^\/api\/session\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      deleteSession(deleteMatch[1]);
      return json(res, 200, { deleted: deleteMatch[1] });
    }

    // GET /api/sessions
    if (method === 'GET' && path === '/api/sessions') {
      return json(res, 200, listSessions());
    }

    // GET /api/health
    if (method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        status: 'ok',
        sessions: listSessions().length,
        uptime: process.uptime(),
      });
    }

    // 404
    json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error(`[server] Error: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

// Start server
const server = createServer(handleRequest);
server.listen(PORT, HOST, () => {
  console.log(`
┌─────────────────────────────────────┐
│  Agent Starter                      │
│  http://${HOST}:${PORT}                  │
│                                     │
│  POST /api/ask         Ask agent    │
│  GET  /api/sessions    List         │
│  GET  /api/session/:id/history      │
│  DELETE /api/session/:id            │
│  GET  /api/health                   │
└─────────────────────────────────────┘
  `);
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, shutting down...`);
    server.close(() => process.exit(0));
  });
}
