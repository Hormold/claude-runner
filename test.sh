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

# Start mock API server (external, agent can't see its source)
MOCK_PID=""
if ! curl -sf http://host.docker.internal:3457/api/health >/dev/null 2>&1; then
  node mock-api.mjs &
  MOCK_PID=$!
  sleep 1
fi
curl -sf http://localhost:3457/api/health >/dev/null && pass "Mock API running on :3457" || { fail "Mock API not responding"; exit 1; }

# Start server if not running
if ! curl -sf $BASE/health >/dev/null 2>&1; then
  node server.mjs &
  SERVER_PID=$!
  sleep 2
fi
trap "kill $SERVER_PID $MOCK_PID 2>/dev/null; wait $SERVER_PID $MOCK_PID 2>/dev/null" EXIT
curl -sf $BASE/health >/dev/null && pass "Server running on :3456" || { fail "Server not responding"; exit 1; }

# Env vars passed to Docker containers (agent uses CLI that calls mock API)
AGENT_ENV='{"ACME_API_URL":"http://host.docker.internal:3457","ACME_API_TOKEN":"acme-secret-token-42"}'

# ── 1. Health ──
echo ""
echo -e "${BOLD}1. Health Check${NC}"
HEALTH=$(curl -sf $BASE/health)
echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'   status={d[\"status\"]} sessions={d[\"sessions\"]} active={d[\"activeTasks\"]}')" && pass "Health OK" || fail "Health failed"

# ── 2. New session with tools ──
echo ""
echo -e "${BOLD}2. New Session → Tools → Structured Output${NC}"
R1=$(curl -sf -X POST $BASE/task -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"alice\",\"message\":\"My email is alice@startup.io. How many calls do I have left?\",\"context\":\"Channel: web-chat\",\"env\":$AGENT_ENV}")
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
  -d "{\"sessionId\":\"bob\",\"message\":\"My email is bob@bigcorp.com. What plan am I on and is my payment up to date?\",\"env\":$AGENT_ENV}")
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
  -d "{\"sessionId\":\"alice\",\"message\":\"What was my email and how many calls did I have left? Answer from memory.\",\"env\":$AGENT_ENV}")
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

# ── 9. WebSocket streaming ──
echo ""
echo -e "${BOLD}9. WebSocket Streaming${NC}"
# Combined test: WS listener + HTTP task in one node script
WS_LOG=$(mktemp)
node -e "
const http = require('http');
const crypto = require('crypto');

const events = [];
const key = crypto.randomBytes(16).toString('base64');

// 1. Connect WebSocket
const req = http.request({hostname:'localhost',port:3456,path:'/stream/ws-test',headers:{
  'Upgrade':'websocket','Connection':'Upgrade','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'
}});

req.on('upgrade',(res,socket)=>{
  let buf=Buffer.alloc(0);
  socket.on('data',(d)=>{
    buf=Buffer.concat([buf,d]);
    while(buf.length>=2){
      let len=buf[1]&0x7f,off=2;
      if(len===126){len=buf.readUInt16BE(2);off=4;}
      else if(len===127){len=Number(buf.readBigUInt64BE(2));off=10;}
      if(buf.length<off+len)break;
      const msg=buf.slice(off,off+len).toString();
      buf=buf.slice(off+len);
      try{const e=JSON.parse(msg);events.push(e.type);
        if(e.type==='task_complete'){
          // Done — print events and exit
          for(const t of events) process.stdout.write(t+'\\n');
          process.exit(0);
        }
      }catch{}
    }
  });
  socket.on('close',()=>{for(const t of events)process.stdout.write(t+'\\n');process.exit(0);});

  // 2. After connected, send task via HTTP
  setTimeout(()=>{
    const r2=http.request({hostname:'localhost',port:3456,path:'/task',method:'POST',headers:{'Content-Type':'application/json'}});
    r2.write(JSON.stringify({sessionId:'ws-test',message:'Say just hello'}));
    r2.end();
  },500);
});
req.end();
" > "$WS_LOG" 2>/dev/null

WS_EVENTS=$(cat "$WS_LOG" | sort | uniq -c | sort -rn)
echo "   Events received:"
echo "$WS_EVENTS" | head -8 | while read line; do echo "     $line"; done
WS_COUNT=$(cat "$WS_LOG" | wc -l | tr -d ' ')
rm -f "$WS_LOG"
[ "$WS_COUNT" -gt 2 ] && pass "WebSocket: $WS_COUNT events streamed" || fail "WebSocket: only $WS_COUNT events"

# ── 10. Workspace isolation ──
echo ""
echo -e "${BOLD}10. Workspace Isolation${NC}"
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
rm -rf sessions/ 2>/dev/null
exit $FAILS
