#!/bin/bash
# Check subscription status — returns JSON
# Usage: ./check-subscription.sh <user_id>

USER_ID="$1"

if [[ "$USER_ID" == "usr_123" ]]; then
  echo '{"user_id": "usr_123", "plan": "pro", "price": "$49/mo", "renewal": "2026-04-15", "status": "active", "features": ["unlimited_calls", "priority_support", "api_access"]}'
elif [[ "$USER_ID" == "usr_456" ]]; then
  echo '{"user_id": "usr_456", "plan": "free", "price": "$0", "renewal": null, "status": "active", "features": ["10_calls_per_month"], "upgrade_options": ["pro: $49/mo", "business: $99/mo"]}'
else
  echo '{"error": "Subscription not found"}'
  exit 1
fi
