#!/bin/bash
# Full cycle test via HTTP server
# Usage: ./test-server.sh

BASE="http://localhost:3456"

echo "╔═══════════════════════════════════════════════╗"
echo "║  Server Test: HTTP → Docker → Structured Out  ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# Health check
echo "━━ Health ━━"
curl -s $BASE/health | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"
echo ""

# Step 1: New session
echo "━━ STEP 1: New session (jane) ━━"
echo ""
RESULT1=$(curl -s -X POST $BASE/ask \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"jane","message":"My email is jane@example.com. I am running out of calls. Help me.","context":"Channel: web\nPriority: normal"}')

echo "$RESULT1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  Resumed: {d.get(\"resumed\")}')
print(f'  Cost: \${d.get(\"cost\", 0):.4f} | Duration: {d.get(\"duration\", 0)}ms')
print(f'  Tools: {d.get(\"tools\", [])}')
o = d.get('output')
if o:
  print(f'  ✅ Structured output:')
  print(f'     action: {o.get(\"action\")}')
  print(f'     response: {str(o.get(\"response\",\"\"))[:150]}')
  print(f'     user: {json.dumps(o.get(\"user\"))}')
  print(f'     confidence: {o.get(\"confidence\")}')
else:
  print(f'  Response: {str(d.get(\"response\",\"\"))[:200]}')
"
echo ""

# Check container is running
echo "━━ Container status ━━"
docker ps --filter "name=agent-jane" --format "  {{.Names}} — {{.Status}}"
echo ""

# Step 2: Resume
echo "━━ STEP 2: Resume (jane) ━━"
echo ""
RESULT2=$(curl -s -X POST $BASE/ask \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"jane","message":"What was my email and plan? Answer from memory."}')

echo "$RESULT2" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  Resumed: {d.get(\"resumed\")}')
print(f'  Cost: \${d.get(\"cost\", 0):.4f} | Duration: {d.get(\"duration\", 0)}ms')
o = d.get('output')
if o:
  print(f'  ✅ Structured output:')
  print(f'     action: {o.get(\"action\")}')
  print(f'     response: {str(o.get(\"response\",\"\"))[:150]}')
else:
  print(f'  Response: {str(d.get(\"response\",\"\"))[:200]}')
"
echo ""

# Sessions list
echo "━━ Sessions ━━"
curl -s $BASE/sessions | python3 -c "
import sys, json
for s in json.load(sys.stdin):
  print(f'  {s[\"sessionId\"]}: turns={s.get(\"turns\")}, container={s.get(\"containerRunning\")}')
"
echo ""

# Total
echo "━━ DONE ━━"
COST=$(python3 -c "
import json
r1 = json.loads('$RESULT1')
r2 = json.loads('$RESULT2')
print(f'Total cost: \${r1.get(\"cost\",0) + r2.get(\"cost\",0):.4f}')
")
echo "  $COST"
echo "  Container will auto-stop after idle timeout"
