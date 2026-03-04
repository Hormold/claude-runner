#!/usr/bin/env npx tsx
/**
 * Full Cycle Test — demonstrates the complete agent lifecycle:
 *
 * 1. First run: agent uses tools, returns structured JSON
 * 2. Second run: resumes session, remembers everything
 *
 * Usage: npx tsx test-full-cycle.ts
 */

import { runAgent } from './agent.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = import.meta.dirname;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['reply', 'escalate', 'resolve'],
      description: 'What action to take',
    },
    response: {
      type: 'string',
      description: 'Response to the customer',
    },
    user_info: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        plan: { type: 'string' },
        email: { type: 'string' },
      },
    },
    internal_notes: {
      type: 'string',
      description: 'Internal notes for support team',
    },
  },
  required: ['action', 'response'],
};

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Agent Full Cycle Test                   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // ─── STEP 1: First question ───
  console.log('━━━ STEP 1: New session — customer asks about their plan ━━━');
  console.log('');

  const result1 = await runAgent({
    sessionId: 'customer-jane',
    message: 'Hi, I\'m running out of calls on my account. What can I do? My email is jane@example.com',
    context: 'Channel: web chat\nPriority: normal\nTimestamp: 2026-03-04T08:45:00Z',
    workspace: WORKSPACE,
    outputSchema: OUTPUT_SCHEMA,
    maxTurns: 10,
  });

  console.log('');
  console.log('┌── Result ──────────────────────────────┐');
  console.log(`│ Session ID: ${result1.sdkSessionId.slice(0, 20)}...`);
  console.log(`│ Cost: $${result1.costUsd.toFixed(4)}`);
  console.log(`│ Duration: ${result1.durationMs}ms`);
  console.log('│');
  if (result1.output) {
    console.log('│ Structured Output:');
    console.log(`│   action: ${result1.output.action}`);
    console.log(`│   response: ${String(result1.output.response).slice(0, 100)}`);
    if (result1.output.user_info) {
      console.log(`│   user: ${JSON.stringify(result1.output.user_info)}`);
    }
    if (result1.output.internal_notes) {
      console.log(`│   notes: ${String(result1.output.internal_notes).slice(0, 100)}`);
    }
  } else {
    console.log(`│ Response: ${result1.response.slice(0, 200)}`);
  }
  console.log('└────────────────────────────────────────┘');
  console.log('');

  // Show session state
  const statePath = join(WORKSPACE, '.sessions', 'customer-jane.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    console.log(`Session state saved: turns=${state.turns}, sdk=${state.sdkSessionId.slice(0, 20)}...`);
  }

  console.log('');
  console.log('━━━ STEP 2: Resume — follow-up question (same session) ━━━');
  console.log('');

  // ─── STEP 2: Follow-up (resume) ───
  const result2 = await runAgent({
    sessionId: 'customer-jane',
    message: 'How much does the Pro plan cost? And what extra features do I get?',
    workspace: WORKSPACE,
    outputSchema: OUTPUT_SCHEMA,
    maxTurns: 10,
  });

  console.log('');
  console.log('┌── Result (Resumed) ────────────────────┐');
  console.log(`│ Same session: ${result2.sdkSessionId === result1.sdkSessionId ? '✅ YES' : '❌ NO (new: ' + result2.sdkSessionId.slice(0, 12) + ')'}`);
  console.log(`│ Cost: $${result2.costUsd.toFixed(4)}`);
  console.log(`│ Duration: ${result2.durationMs}ms`);
  console.log('│');
  if (result2.output) {
    console.log('│ Structured Output:');
    console.log(`│   action: ${result2.output.action}`);
    console.log(`│   response: ${String(result2.output.response).slice(0, 100)}`);
  } else {
    console.log(`│ Response: ${result2.response.slice(0, 200)}`);
  }
  console.log('└────────────────────────────────────────┘');
  console.log('');

  // Final state
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    console.log(`Final state: turns=${state.turns}, created=${state.created}`);
  }

  console.log('');
  console.log('✅ Full cycle complete!');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
