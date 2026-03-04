/**
 * OAuth token management for Claude Agent SDK.
 * Handles automatic refresh of tokens.
 *
 * Auth priority:
 * 1. ANTHROPIC_API_KEY env var (standard API key)
 * 2. CLAUDE_OAUTH_TOKEN + CLAUDE_REFRESH_TOKEN env vars (OAuth)
 * 3. ~/.claude/.credentials.json (local Claude CLI credentials)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // Refresh 10 min before expiry

let cachedTokens = null;

/**
 * Load initial tokens from environment or credentials file
 */
function loadInitialTokens() {
  // Option 1: Standard API key
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: 'api_key', token: process.env.ANTHROPIC_API_KEY };
  }

  // Option 2: OAuth tokens from env
  if (process.env.CLAUDE_OAUTH_TOKEN) {
    return {
      type: 'oauth',
      accessToken: process.env.CLAUDE_OAUTH_TOKEN,
      refreshToken: process.env.CLAUDE_REFRESH_TOKEN,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000, // Assume 8h validity
    };
  }

  // Option 3: Local Claude CLI credentials
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        type: 'oauth',
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt || Date.now() + 8 * 60 * 60 * 1000,
      };
    }
  } catch {
    // No local credentials
  }

  return null;
}

/**
 * Refresh OAuth tokens
 */
async function refreshTokens(refreshToken) {
  console.log('[auth] Refreshing OAuth tokens...');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return {
    type: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Get a valid API key/token for the SDK.
 * Handles refresh automatically.
 */
export async function getApiKey() {
  if (!cachedTokens) {
    cachedTokens = loadInitialTokens();
  }

  if (!cachedTokens) {
    throw new Error(
      'No authentication configured. Set ANTHROPIC_API_KEY, or CLAUDE_OAUTH_TOKEN + CLAUDE_REFRESH_TOKEN.'
    );
  }

  if (cachedTokens.type === 'api_key') {
    return cachedTokens.token;
  }

  // OAuth: check if refresh needed
  if (cachedTokens.refreshToken && Date.now() >= cachedTokens.expiresAt - REFRESH_BUFFER_MS) {
    try {
      cachedTokens = await refreshTokens(cachedTokens.refreshToken);
      console.log('[auth] Tokens refreshed successfully');
    } catch (err) {
      console.error('[auth] Refresh failed:', err.message);
      // Use old token if still valid
      if (Date.now() >= cachedTokens.expiresAt) {
        throw err;
      }
    }
  }

  return cachedTokens.accessToken;
}
