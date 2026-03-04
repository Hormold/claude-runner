import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = __dirname;

const systemPrompt = readFileSync(join(WORKSPACE, 'AGENTS.md'), 'utf-8');

async function run(prompt, resumeId) {
  const opts = {
    model: 'claude-sonnet-4-20250514',
    maxTurns: 8,
    cwd: WORKSPACE,
    systemPrompt,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
  if (resumeId) opts.resume = resumeId;

  const stream = query({ prompt, options: opts });
  let result = '', sid = '', cost = 0, dur = 0;

  for await (const m of stream) {
    if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
    if (m.type === 'assistant' && m.message?.content) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') console.log(`  🔧 Tool: ${b.name}`);
      }
    }
    if (m.type === 'result' && m.subtype === 'success') {
      result = m.result || '';
      cost = m.total_cost_usd || 0;
      dur = m.duration_ms || 0;
    }
  }
  return { result, sid, cost, dur };
}

// ─── STEP 1 ───
console.log('╔══════════════════════════════════════════════╗');
console.log('║  Full Cycle Test: New → Tools → Resume       ║');
console.log('╚══════════════════════════════════════════════╝\n');

console.log('━━ STEP 1: Customer asks about their account ━━\n');

const r1 = await run(
  "Hi, my email is jane@example.com. I'm running out of calls on my plan. What are my options? Use the lookup-user and check-subscription tools in the tools/ directory."
);

console.log(`\n  ✅ Session: ${r1.sid}`);
console.log(`  💰 Cost: $${r1.cost.toFixed(4)} | ⏱️ ${r1.dur}ms`);
console.log(`  💬 ${r1.result.slice(0, 300)}\n`);

// ─── STEP 2: Resume ───
console.log('━━ STEP 2: Resume — follow-up (same session) ━━\n');

const r2 = await run(
  "What was my email and how many calls have I used so far? Answer from memory, don't look anything up.",
  r1.sid
);

console.log(`\n  ✅ Same session: ${r1.sid === r2.sid ? 'YES ✅' : 'NO ❌'}`);
console.log(`  💰 Cost: $${r2.cost.toFixed(4)} | ⏱️ ${r2.dur}ms`);
console.log(`  💬 ${r2.result.slice(0, 300)}\n`);

console.log('━━ DONE ━━');
console.log(`Total cost: $${(r1.cost + r2.cost).toFixed(4)}`);
