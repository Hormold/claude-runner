#!/bin/bash
# AcmeApp CLI — interact with the AcmeApp API
#
# Usage:
#   acme-cli.sh user <email>              Look up user by email
#   acme-cli.sh subscription <user_id>    Get subscription details
#   acme-cli.sh usage <user_id>           Get usage stats
#   acme-cli.sh upgrade <user_id> <plan>  Upgrade user's plan
#
# Requires env vars: ACME_API_URL, ACME_API_TOKEN

set -euo pipefail

CMD="${1:-help}"
API="${ACME_API_URL:?ACME_API_URL not set}"
TOKEN="${ACME_API_TOKEN:?ACME_API_TOKEN not set}"

do_get() {
  local resp
  resp=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "$1")
  local code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')
  if [ "$code" -ge 400 ] 2>/dev/null; then
    echo "{\"error\": \"HTTP $code\", \"details\": $body}" >&2
    exit 1
  fi
  echo "$body"
}

case "$CMD" in
  user)
    EMAIL="${2:?Usage: acme-cli.sh user <email>}"
    do_get "$API/api/users?email=$EMAIL"
    ;;
  subscription)
    USER_ID="${2:?Usage: acme-cli.sh subscription <user_id>}"
    do_get "$API/api/users/$USER_ID/subscription"
    ;;
  usage)
    USER_ID="${2:?Usage: acme-cli.sh usage <user_id>}"
    do_get "$API/api/users/$USER_ID/usage"
    ;;
  upgrade)
    USER_ID="${2:?Usage: acme-cli.sh upgrade <user_id> <plan>}"
    PLAN="${3:?Usage: acme-cli.sh upgrade <user_id> <plan>}"
    curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"plan\":\"$PLAN\"}" "$API/api/users/$USER_ID/upgrade"
    ;;
  help|*)
    echo "AcmeApp CLI"
    echo ""
    echo "Commands:"
    echo "  user <email>              Look up user by email"
    echo "  subscription <user_id>    Get subscription details"
    echo "  usage <user_id>           Get usage stats"
    echo "  upgrade <user_id> <plan>  Upgrade user's plan"
    echo ""
    echo "Available plans: starter (\$19/mo), growth (\$49/mo), enterprise (\$249/mo)"
    ;;
esac
