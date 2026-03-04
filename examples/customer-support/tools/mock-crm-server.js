#!/usr/bin/env node

// Mock MCP server for CRM integration
// In production, replace this with a real MCP server package
// e.g., npx -y @your-org/crm-mcp-server

const http = require('http');

const PORT = process.env.MCP_PORT || 0;

const customers = {
  'jane@example.com': {
    name: 'Jane Smith',
    plan: 'Pro',
    ltv: 2499.99,
    tickets: [
      { id: 'T-001', subject: 'Billing question', status: 'resolved' },
      { id: 'T-002', subject: 'Feature request', status: 'open' },
    ],
  },
  'bob@example.com': {
    name: 'Bob Johnson',
    plan: 'Free',
    ltv: 0,
    tickets: [],
  },
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url.startsWith('/customer/')) {
    const email = decodeURIComponent(req.url.split('/customer/')[1]);
    const customer = customers[email];
    if (customer) {
      res.end(JSON.stringify(customer));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Customer not found' }));
    }
  } else {
    res.end(JSON.stringify({ status: 'ok', service: 'mock-crm' }));
  }
});

server.listen(PORT, () => {
  const addr = server.address();
  console.error(`Mock CRM server listening on port ${addr.port}`);
});
