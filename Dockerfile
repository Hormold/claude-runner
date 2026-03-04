FROM node:22-slim

# Install Claude Agent SDK
WORKDIR /app
RUN npm init -y && npm install @anthropic-ai/claude-agent-sdk@latest

# Create non-root user
RUN useradd -m -s /bin/bash runner
USER runner
WORKDIR /workspace
