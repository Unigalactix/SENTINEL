# Future Improvements & Suggestions

## 1. Persistent Session Storage
**Issue:** Currently, user sessions and OAuth tokens are stored in-memory (`express-session` default and `userTokenStore` map). 
**Risk:** Restarting the server logs out all users and loses active agent contexts.
**Suggestion:** Implement Redis or a database (PostgreSQL/MongoDB) store for `express-session` and link it to the agent system.

## 2. Token Refresh Logic
**Issue:** GitHub OAuth tokens may expire. The current system logs a 401 error but does not automatically refresh the token.
**Suggestion:** Implement a token refresh flow using the refresh token provided during the initial OAuth handshake.

## 3. Rate Limiting
**Issue:** No explicit handling for GitHub API rate limits.
**Suggestion:** Add `octokit-plugin-throttling` to automatically handle secondary rate limits and back off.

## 4. Input Validation
**Issue:** Formatting of JIRA tickets is parsed manually.
**Suggestion:** Use a more robust JIRA ADF parser or validation schema (Zod) for incoming webhook payloads.