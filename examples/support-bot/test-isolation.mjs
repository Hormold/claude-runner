/**
 * Isolation Test — two users, independent sessions, full persistence
 *
 * 1. User "jane" asks about her account → agent uses tools, responds
 * 2. User "john" asks about his account → separate session, separate workspace
 * 3. Resume "jane" — remembers everything, no contamination from "john"
 */

import { ask, listSessions, deleteSession } from './session-manager.mjs';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Clean slate
deleteSession('jane');
deleteSession('john');

console.log('╔═══════════════════════════════════════════════╗');
console.log('║  Isolation Test: 2 users, independent state   ║');
console.log('╚═══════════════════════════════════════════════╝\n');

// ─── USER 1: Jane ───
console.log('━━ USER 1 (jane): Asks about her account ━━\n');
const r1 = await ask(
  'jane',
  "My email is jane@example.com. How many calls do I have left?",
  "Channel: web | Priority: normal"
);
console.log(`  Response: ${r1.response.slice(0, 200)}`);
console.log(`  Cost: $${r1.cost.toFixed(4)} | Resumed: ${r1.resumed}\n`);

// ─── USER 2: John ───
console.log('━━ USER 2 (john): Asks about HIS account ━━\n');
const r2 = await ask(
  'john',
  "Hi, I'm john@example.com. What plan am I on and when does it renew?",
  "Channel: slack | Priority: high"
);
console.log(`  Response: ${r2.response.slice(0, 200)}`);
console.log(`  Cost: $${r2.cost.toFixed(4)} | Resumed: ${r2.resumed}\n`);

// ─── RESUME Jane ───
console.log('━━ RESUME (jane): Remembers her context? ━━\n');
const r3 = await ask(
  'jane',
  "What was my email and plan? Answer from memory."
);
console.log(`  Response: ${r3.response.slice(0, 200)}`);
console.log(`  Cost: $${r3.cost.toFixed(4)} | Resumed: ${r3.resumed}\n`);

// ─── Show state ───
console.log('━━ Sessions ━━\n');
for (const s of listSessions()) {
  console.log(`  ${s.sessionId}: turns=${s.turns}, last=${s.lastActive}`);
}

// Show workspace isolation
console.log('\n━━ Workspace isolation ━━\n');
for (const user of ['jane', 'john']) {
  const dir = join(__dirname, 'sessions', user);
  if (existsSync(dir)) {
    const files = readdirSync(dir);
    console.log(`  ${user}/: ${files.join(', ')}`);
  }
}

console.log('\n✅ Done!');
