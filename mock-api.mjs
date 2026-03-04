/**
 * Mock API Server — simulates a real SaaS backend
 * 
 * GET  /api/users?email=...         → user profile
 * GET  /api/users/:id/subscription  → subscription details
 * POST /api/users/:id/upgrade       → upgrade plan
 * GET  /api/users/:id/usage         → usage stats
 * GET  /api/health                  → health check
 * 
 * Requires: Authorization: Bearer <token>
 */

import http from 'http';

const PORT = parseInt(process.env.MOCK_API_PORT || '3457');
const API_TOKEN = process.env.MOCK_API_TOKEN || 'acme-secret-token-42';

// ── Mock Database ──

const users = {
  'usr_101': { id: 'usr_101', name: 'Alice Chen', email: 'alice@startup.io', created: '2025-06-12', status: 'active' },
  'usr_102': { id: 'usr_102', name: 'Bob Martinez', email: 'bob@bigcorp.com', created: '2025-01-03', status: 'active' },
  'usr_103': { id: 'usr_103', name: 'Carol Wu', email: 'carol@freelance.dev', created: '2026-02-18', status: 'suspended' },
};

const subscriptions = {
  'usr_101': { plan: 'growth', price: 49, interval: 'monthly', renewal: '2026-04-12', status: 'active', features: ['5_agents', '500_calls', 'api_access', 'webhooks'] },
  'usr_102': { plan: 'enterprise', price: 249, interval: 'monthly', renewal: '2026-03-03', status: 'past_due', features: ['unlimited_agents', '5000_calls', 'api_access', 'webhooks', 'sso', 'sla'] },
  'usr_103': { plan: 'starter', price: 19, interval: 'monthly', renewal: null, status: 'cancelled', features: ['1_agent', '60_calls'] },
};

const usage = {
  'usr_101': { calls_used: 312, calls_limit: 500, agents_active: 3, agents_limit: 5, storage_mb: 45, last_call: '2026-03-04T10:30:00Z' },
  'usr_102': { calls_used: 4891, calls_limit: 5000, agents_active: 12, agents_limit: -1, storage_mb: 890, last_call: '2026-03-04T09:15:00Z' },
  'usr_103': { calls_used: 58, calls_limit: 60, agents_active: 0, agents_limit: 1, storage_mb: 2, last_call: '2026-02-20T14:00:00Z' },
};

// ── Helpers ──

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health (no auth)
  if (path === '/api/health') return json(res, { status: 'ok', timestamp: new Date().toISOString() });

  // Auth check
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_TOKEN}`) {
    return json(res, { error: 'Unauthorized', message: 'Invalid or missing Bearer token' }, 401);
  }

  // GET /api/users?email=...
  if (req.method === 'GET' && path === '/api/users') {
    const email = url.searchParams.get('email');
    if (!email) return json(res, { error: 'email parameter required' }, 400);
    const user = Object.values(users).find(u => u.email === email);
    if (!user) return json(res, { error: 'User not found', email }, 404);
    return json(res, { user });
  }

  // GET /api/users/:id/subscription
  const subMatch = path.match(/^\/api\/users\/(usr_\d+)\/subscription$/);
  if (req.method === 'GET' && subMatch) {
    const id = subMatch[1];
    const sub = subscriptions[id];
    if (!sub) return json(res, { error: 'Subscription not found' }, 404);
    return json(res, { user_id: id, subscription: sub });
  }

  // GET /api/users/:id/usage
  const usageMatch = path.match(/^\/api\/users\/(usr_\d+)\/usage$/);
  if (req.method === 'GET' && usageMatch) {
    const id = usageMatch[1];
    const u = usage[id];
    if (!u) return json(res, { error: 'Usage data not found' }, 404);
    return json(res, { user_id: id, usage: u });
  }

  // POST /api/users/:id/upgrade
  const upgradeMatch = path.match(/^\/api\/users\/(usr_\d+)\/upgrade$/);
  if (req.method === 'POST' && upgradeMatch) {
    const id = upgradeMatch[1];
    const body = await readBody(req);
    if (!subscriptions[id]) return json(res, { error: 'User not found' }, 404);
    if (!body.plan) return json(res, { error: 'plan field required' }, 400);
    const oldPlan = subscriptions[id].plan;
    subscriptions[id].plan = body.plan;
    subscriptions[id].status = 'active';
    return json(res, { success: true, user_id: id, old_plan: oldPlan, new_plan: body.plan, message: `Upgraded from ${oldPlan} to ${body.plan}` });
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock API running on http://localhost:${PORT}`);
  console.log(`Token: ${API_TOKEN}`);
});
