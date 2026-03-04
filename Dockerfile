FROM node:22-slim

# System dependencies (add yours here: python3, curl, jq, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Agent SDK
WORKDIR /app
RUN npm init -y && npm install @anthropic-ai/claude-agent-sdk@latest

# Copy server code
COPY src/ /app/src/
COPY package.json /app/

# Agent workspace (mounted as volume)
RUN mkdir -p /workspace && \
    git config --global user.email "agent@localhost" && \
    git config --global user.name "Agent" && \
    git config --global init.defaultBranch main

WORKDIR /workspace
EXPOSE 3000

# Server runs from /app, agent works in /workspace
CMD ["node", "--experimental-specifier-resolution=node", "/app/src/server.mjs"]
