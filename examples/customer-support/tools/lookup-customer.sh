#!/bin/bash
# Mock customer lookup tool
# Usage: ./lookup-customer.sh <email>
# In production, this would query your CRM or database

EMAIL="$1"

if [ -z "$EMAIL" ]; then
  echo "Usage: lookup-customer.sh <email>" >&2
  exit 1
fi

# Mock response — replace with real API call
cat <<EOF
{
  "email": "$EMAIL",
  "name": "Jane Smith",
  "account_id": "ACME-12345",
  "plan": "Pro",
  "member_since": "2024-03-15",
  "total_orders": 12,
  "open_tickets": 1,
  "notes": "VIP customer, priority support"
}
EOF
