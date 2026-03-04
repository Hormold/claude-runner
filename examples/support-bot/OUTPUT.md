# Output Format

After completing your work, you MUST return a JSON object as your final message.

## Schema

```json
{
  "action": "reply | escalate | resolve",
  "response": "Your response to the customer",
  "user": {
    "name": "Customer name if known",
    "email": "Customer email if known",
    "plan": "Their current plan"
  },
  "internal_notes": "Notes for the support team (optional)",
  "confidence": 0.95
}
```

## Rules

- `action` is required: "reply" for normal responses, "escalate" if you can't help, "resolve" if the issue is fully resolved
- `response` is the customer-facing message
- `user` should be filled in if you looked up the customer
- `confidence` is 0-1, how confident you are in your answer
- Return ONLY the JSON object, no markdown, no explanation
