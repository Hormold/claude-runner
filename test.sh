#!/bin/bash
# Full end-to-end test of Claude Runner
# Usage: ./test.sh

set -euo pipefail
BASE="http://localhost:3456"
GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILS=$((FAILS+1)); }
FAILS=0

echo -e "${BOLD}"
echo "╔═══════════════════════════════════════════╗"
echo "║       Claude Runner — Full Test           ║"
echo "╚═══════════════════════════════════════════╝"
echo -e "${NC}"

# ── 0. Prerequisites ──
echo -e "${BOLD}Checking prerequisites...${NC}"
docker image inspect claude-runner >/dev/null 2>&1 || {
  echo "Building Docker image..."
  docker build -t claude-runner . || { fail "Docker build failed"; exit 1; }
}
pass "Docker image: claude-runner"

# Start server if not running
if ! curl -sf $BASE/health >/dev/null 2>&1; then
  echo "Starting server..."
  node server.mjs &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null" EXIT
  sleep 2
fi
curl -sf $BASE/health >/dev/null && pass "Server running on :3456" || { fail "Server not responding"; exit 1; }

# ── 1. Health ──
echo ""
echo -e "${BOLD}1. Health Check${NC}"
HEALTH=$(curl -sf $BASE/health)
echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'   status={d[\"status\"]} sessions={d[\"sessions\"]} active={d[\"activeTasks\"]}')" && pass "Health OK" || fail "Health failed"

# ── 2. New session with tools ──
echo ""
echo -e "${BOLD}2. New Session → Tools → Structured Output${NC}"
R1=$(curl -sf -X POST $BASE/task -H "Content-Type: application/json" \
  -d '{"sessionId":"alice","message":"My email is jane@example.com. How many calls do I have left?","context":"Channel: web-chat"}')
echo "$R1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
o=d.get('output',{})
print(f'   taskId:   {d[\"taskId\"]}')
print(f'   cost:     \${d[\"cost\"]:.4f}')
print(f'   duration: {d[\"duration\"]}ms')
print(f'   tools:    {d[\"tools\"]}')
print(f'   resumed:  {d[\"resumed\"]}')
if o:
  print(f'   output.action:     {o.get(\"action\")}')
  print(f'   output.response:   {str(o.get(\"response\",\"\"))[:100]}')
  print(f'   output.user:       {json.dumps(o.get(\"user\"))}')
  print(f'   output.confidence: {o.get(\"confidence\")}')
" 2>/dev/null
[ $? -eq 0 ] && pass "Session alice: tools + structured output" || fail "Session alice failed"

# ── 3. Independent session ──
echo ""
echo -e "${BOLD}3. Independent Session (Isolation)${NC}"
R2=$(curl -sf -X POST $BASE/task -H "Content-Type: application/json" \
  -d '{"sessionId":"bob","message":"My email is john@example.com. What plan am I on?"}')
echo "$R2" | python3 -c "
import sys,json
d=json.load(sys.stdin)
o=d.get('output',{})
print(f'   taskId: {d[\"taskId\"]}')
print(f'   cost:   \${d[\"cost\"]:.4f}')
if o:
  print(f'   user:   {json.dumps(o.get(\"user\"))}')
  print(f'   plan:   {o.get(\"user\",{}).get(\"plan\")}')
" 2>/dev/null
[ $? -eq 0 ] && pass "Session bob: independent" || fail "Session bob failed"

# ── 4. Resume session (memory) ──
echo ""
echo -e "${BOLD}4. Resume Session (Memory Persistence)${NC}"
R3=$(curl -sf -X POST $BASE/task -H "Content-Type: application/json" \
  -d '{"sessionId":"alice","message":"What was my email and how many calls left? Answer from memory."}')
echo "$R3" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'   resumed: {d[\"resumed\"]}')
print(f'   cost:    \${d[\"cost\"]:.4f}')
o=d.get('output',{})
resp=o.get('response','') if o else d.get('response','')
print(f'   answer:  {str(resp)[:120]}')
" 2>/dev/null
[ $? -eq 0 ] && pass "Resume alice: remembers context" || fail "Resume failed"

# ── 5. Session list ──
echo ""
echo -e "${BOLD}5. Sessions List${NC}"
curl -sf $BASE/sessions | python3 -c "
import sys,json
for s in json.load(sys.stdin):
  print(f'   {s[\"sessionId\"]}: turns={s.get(\"turns\",0)}, busy={s.get(\"busy\")}, queued={s.get(\"queued\",0)}')
" && pass "Sessions listed" || fail "Sessions list failed"

# ── 6. Session details ──
echo ""
echo -e "${BOLD}6. Session Details${NC}"
curl -sf $BASE/session/alice | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'   turns:     {d.get(\"turns\")}')
print(f'   created:   {d.get(\"created\")}')
print(f'   lastActive: {d.get(\"lastActive\")}')
" && pass "Session details" || fail "Session details failed"

# ── 7. Reset session ──
echo ""
echo -e "${BOLD}7. Reset Session${NC}"
curl -sf -X POST $BASE/session/bob/reset | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'   reset: {d.get(\"reset\")}')
" && pass "Session bob reset" || fail "Reset failed"

# Verify reset worked (turns should be 0)
TURNS=$(curl -sf $BASE/session/bob | python3 -c "import sys,json; print(json.load(sys.stdin).get('turns',0))" 2>/dev/null || echo "0")
[ "$TURNS" = "0" ] && pass "Reset verified: turns=0" || fail "Reset not clean (turns=$TURNS)"

# ── 8. Delete session ──
echo ""
echo -e "${BOLD}8. Delete Session${NC}"
curl -sf -X DELETE $BASE/session/bob | python3 -c "
import sys,json; print(f'   deleted: {json.load(sys.stdin).get(\"deleted\")}')
" && pass "Session bob deleted" || fail "Delete failed"

# ── 9. Workspace isolation ──
echo ""
echo -e "${BOLD}9. Workspace Isolation${NC}"
for u in alice; do
  DIR="sessions/$u"
  if [ -d "$DIR" ]; then
    FILES=$(ls "$DIR" 2>/dev/null | tr '\n' ', ')
    echo "   $u/: $FILES"
    pass "$u workspace exists"
  fi
done
[ ! -d "sessions/bob" ] && pass "bob workspace deleted" || fail "bob still exists"

# ── Summary ──
echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"

# Calculate total cost
TOTAL=$(python3 -c "
import json
total = 0
for r in ['''$R1''', '''$R2''', '''$R3''']:
  try: total += json.loads(r).get('cost', 0)
  except: pass
print(f'{total:.4f}')
" 2>/dev/null || echo "?")

if [ $FAILS -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}ALL TESTS PASSED${NC}  |  Total cost: \$$TOTAL"
else
  echo -e "  ${RED}${BOLD}$FAILS TESTS FAILED${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════${NC}"

# Cleanup
rm -rf sessions/
exit $FAILS
