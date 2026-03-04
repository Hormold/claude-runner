#!/bin/bash
# Lookup user by email — returns JSON
# Usage: ./lookup-user.sh <email>

EMAIL="$1"

# Mock database
if [[ "$EMAIL" == "john@example.com" ]]; then
  echo '{"id": "usr_123", "name": "John Smith", "email": "john@example.com", "plan": "pro", "joined": "2025-03-15", "calls_used": 47, "calls_limit": 100}'
elif [[ "$EMAIL" == "jane@example.com" ]]; then
  echo '{"id": "usr_456", "name": "Jane Doe", "email": "jane@example.com", "plan": "free", "joined": "2026-01-10", "calls_used": 9, "calls_limit": 10}'
else
  echo '{"error": "User not found"}'
  exit 1
fi
