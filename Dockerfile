FROM node:22-slim

# Install system deps (curl for CLI tools, git for SDK)
RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*

# Install Claude Agent SDK
WORKDIR /app
RUN npm init -y && npm install @anthropic-ai/claude-agent-sdk@latest

# Create non-root user
RUN useradd -m -s /bin/bash runner
USER runner
WORKDIR /workspace
