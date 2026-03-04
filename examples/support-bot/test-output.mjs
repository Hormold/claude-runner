/**
 * Output Test — structured JSON output via OUTPUT.md
 *
 * 1. New session → agent uses tools → returns structured JSON
 * 2. Resume → returns structured JSON again (from memory)
 * 3. Verify both outputs have required fields
 */

import { ask, deleteSession } from './session-manager.mjs';

deleteSession('output-test');

console.log('╔═══════════════════════════════════════════════╗');
console.log('║  Output Test: Structured JSON via OUTPUT.md   ║');
console.log('╚═══════════════════════════════════════════════╝\n');

// ─── STEP 1 ───
console.log('━━ STEP 1: New session → structured output ━━\n');

const r1 = await ask(
  'output-test',
  "My email is jane@example.com. I'm almost out of calls, help me.",
  "Channel: web"
);

console.log(`  Resumed: ${r1.resumed}`);
console.log(`  Cost: $${r1.cost.toFixed(4)} | ${r1.duration}ms`);
console.log(`  Has structured output: ${r1.output ? '✅' : '❌'}`);
if (r1.output) {
  console.log(`  action: ${r1.output.action}`);
  console.log(`  response: ${String(r1.output.response).slice(0, 150)}`);
  console.log(`  user: ${JSON.stringify(r1.output.user)}`);
  console.log(`  confidence: ${r1.output.confidence}`);
} else {
  console.log(`  Raw: ${r1.response.slice(0, 200)}`);
}

// ─── STEP 2 ───
console.log('\n━━ STEP 2: Resume → structured output from memory ━━\n');

const r2 = await ask(
  'output-test',
  "Remind me what plan I'm on and how many calls I've used."
);

console.log(`  Resumed: ${r2.resumed}`);
console.log(`  Cost: $${r2.cost.toFixed(4)} | ${r2.duration}ms`);
console.log(`  Has structured output: ${r2.output ? '✅' : '❌'}`);
if (r2.output) {
  console.log(`  action: ${r2.output.action}`);
  console.log(`  response: ${String(r2.output.response).slice(0, 150)}`);
  console.log(`  user: ${JSON.stringify(r2.output.user)}`);
  console.log(`  confidence: ${r2.output.confidence}`);
} else {
  console.log(`  Raw: ${r2.response.slice(0, 200)}`);
}

// ─── Validate ───
console.log('\n━━ Validation ━━\n');
const checks = [
  ['Step 1 has output', !!r1.output],
  ['Step 1 has action', !!r1.output?.action],
  ['Step 1 has response', !!r1.output?.response],
  ['Step 2 has output', !!r2.output],
  ['Step 2 resumed', r2.resumed],
  ['Step 2 has action', !!r2.output?.action],
];
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
}

const allPassed = checks.every(([, ok]) => ok);
console.log(`\n${allPassed ? '✅ All checks passed!' : '❌ Some checks failed'}`);
console.log(`Total cost: $${(r1.cost + r2.cost).toFixed(4)}`);
