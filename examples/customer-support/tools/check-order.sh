#!/bin/bash
# Mock order status tool
# Usage: ./check-order.sh <order_id>
# In production, this would query your order management system

ORDER_ID="$1"

if [ -z "$ORDER_ID" ]; then
  echo "Usage: check-order.sh <order_id>" >&2
  exit 1
fi

# Mock response — replace with real API call
cat <<EOF
{
  "order_id": "$ORDER_ID",
  "status": "shipped",
  "items": [
    {"name": "Widget Pro", "quantity": 2, "price": 29.99},
    {"name": "Gadget Mini", "quantity": 1, "price": 14.99}
  ],
  "total": 74.97,
  "shipped_at": "2024-12-20T10:30:00Z",
  "tracking": "1Z999AA10123456784",
  "carrier": "UPS",
  "estimated_delivery": "2024-12-24"
}
EOF
