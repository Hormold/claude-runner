# Plan: OAuth Token Support

Add OAuth token authentication as alternative to API key for users with Claude Max subscription.

**IMPORTANT:** Claude Max subscription is for personal use only. Cannot be used to build commercial products or resell API access per Anthropic's Terms of Service.

## Validation Commands
- `npx tsc --noEmit`
- `npx vitest run --reporter=verbose`

---

### Task 1: OAuth token management service
Create OAuth service based on support-agent pattern (see `~/projects/skipcalls-support-agent/src/services/claude-auth.ts`).

- [ ] Create `src/auth/oauth.ts` — token storage, refresh logic
- [ ] Store tokens in file-based cache (`data/oauth-tokens.json`) — no Redis dependency
- [ ] Auto-refresh 10 minutes before expiry
- [ ] Use Anthropic OAuth endpoint: `https://console.anthropic.com/v1/oauth/token`
- [ ] Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- [ ] Export `getAccessToken()` that handles refresh automatically
- [ ] Export `initializeOAuth(accessToken, refreshToken)` for initial setup
- [ ] Write unit tests

### Task 2: Integration with SDK calls
Use OAuth tokens when available, fall back to API key.

- [ ] Modify `SessionManager` to check for OAuth tokens first
- [ ] Pass access token to Claude SDK when creating sessions
- [ ] If OAuth token refresh fails, log error and continue with API key if available
- [ ] Add `authType: 'oauth' | 'apikey'` to session metadata for debugging
- [ ] Write integration tests

### Task 3: CLI setup command
Add `claude-runner oauth` subcommand for initial token setup.

- [ ] `claude-runner oauth setup` — prompts for access token and refresh token
- [ ] `claude-runner oauth status` — shows token status, expiry time
- [ ] `claude-runner oauth clear` — removes stored tokens
- [ ] Document in README.md with disclaimer about personal use only

### Task 4: Documentation update
Update README.md with OAuth authentication option.

- [ ] Add "Authentication" section explaining both options
- [ ] API key: recommended for production, no refresh needed
- [ ] OAuth: for personal use with Claude Max subscription only
- [ ] Include prominent disclaimer: "Claude Max subscription is for personal use only per Anthropic Terms of Service. Do not use for commercial products or to resell API access."
- [ ] Add setup instructions for OAuth flow
