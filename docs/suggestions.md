# Future Improvements & Suggestions

## 1. Persistent Session Storage
**Issue:** Currently, user sessions and OAuth tokens are stored in-memory (`express-session` default and `userTokenStore` map). 
**Risk:** Restarting the server logs out all users and loses active agent contexts.
**Suggestion:** Implement Redis or a database (PostgreSQL/MongoDB) store for `express-session` and link it to the agent system.

## 3. Rate Limiting
**Issue:** No explicit handling for GitHub API rate limits.
**Suggestion:** Add `octokit-plugin-throttling` to automatically handle secondary rate limits and back off.

## 4. Input Validation
**Issue:** Formatting of JIRA tickets is parsed manually.
**Suggestion:** Use a more robust JIRA ADF parser or validation schema (Zod) for incoming webhook payloads.

## 5. Persist System Status & History
**Issue:** `systemStatus`, `scanHistory`, and `monitoredTickets` are held entirely in memory.
**Risk:** A server restart drops all monitoring state and history, and horizontal scaling becomes difficult.
**Suggestion:**
- Introduce a small database (e.g., Postgres, SQLite, or MongoDB) and map `scanHistory`, `monitoredTickets`, and per-agent state into tables/collections.
- Persist each "run" (ticket + workflow + PR + checks) so the UI can render history across restarts and between multiple instances.
- Keep the in-memory objects as a cache but treat the database as the source of truth.

## 6. Durable Session & Agent Store
**Issue:** Agents and sessions are tied to in-memory maps and the default `express-session` store.
**Risk:** Loss of agents on restart and no way to share state across multiple Node processes.
**Suggestion:**
- Use a shared store for sessions and agent contexts (Redis, DynamoDB, or Postgres-backed session store).
- Store minimal, non-sensitive agent metadata (GitHub login, last activity timestamps) in the database for better auditability.

## 7. Job Queue for Ticket Processing
**Issue:** Ticket processing is done inline in the polling loop.
**Risk:** A single slow Jira or GitHub call can block the loop and delay other tickets; it also couples API, polling, and processing into one process.
**Suggestion:**
- Introduce a job queue (BullMQ / RabbitMQ / SQS) where the poller enqueues tickets and one or more workers process them.
- This makes it easier to scale processing horizontally, add retries, and track per-job state.

## 8. Webhooks + Polling Hybrid
**Issue:** The system relies heavily on polling Jira and GitHub for updates.
**Risk:** Unnecessary API usage and slower reaction time to events.
**Suggestion:**
- Add optional Jira and GitHub webhooks to push events (issue transitions, PR updates, workflow runs) into Sentinel.
- Keep polling as a fallback, but reduce intervals when webhooks are configured, lowering rate-limit pressure.

## 9. Structured Logging & Observability
**Issue:** Logs are mostly plaintext with limited structure.
**Suggestion:**
- Standardize on structured logging (JSON) with fields like `ticketKey`, `repo`, `phase`, `agentId`, and `correlationId`.
- Add a dedicated health endpoint (e.g., `/health` and `/ready`) for Kubernetes-style probes.
- Consider integrating with a log aggregator (ELK, Loki, or CloudWatch) and emitting metrics (Prometheus) for processed tickets, failures, retry counts, etc.

## 10. Retry & Backoff Strategy
**Issue:** Many Jira/GitHub calls are one-shot; failures are logged but not retried safely.
**Suggestion:**
- Wrap external API calls with a retry policy that handles transient errors (network issues, 5xx, secondary rate limits) with exponential backoff and jitter.
- Classify errors into transient vs permanent, and only retry transient ones.
- Surface retry information in the UI so users know when Sentinel is still trying vs when a ticket is marked failed.

## 11. UI: Real-Time Updates & Filtering
**Issue:** The dashboard is driven by periodic polling and gets crowded as history grows.
**Suggestion:**
- Consider upgrading to WebSockets or Server-Sent Events for near real-time pushes from the server to the browser.
- Add filters on the Kanban and history views (by project, priority, status, date range, agent) so users can focus on relevant tickets.
- Provide a detail panel for a selected ticket with full timeline: Jira transitions, workflow runs, Copilot actions, and comments.

## 12. UI: Error States & Guidance
**Issue:** Some error states are only visible in logs or as brief banners.
**Suggestion:**
- Add clear, persistent banners when OAuth is misconfigured, GitHub App is missing permissions, or Jira credentials fail.
- Link those banners directly to setup docs or a "Configuration" section describing required env vars and scopes.
- In the log terminal, visually distinguish warnings vs errors using color and icons.

## 13. Security & Secrets Management
**Issue:** The app relies on environment variables and in-memory tokens without a dedicated secrets strategy.
**Suggestion:**
- Integrate with a secrets manager (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault) for GitHub/Jira credentials.
- Ensure logs never include full tokens or sensitive headers; mask or truncate IDs where possible.
- Define and document the minimal OAuth scopes and GitHub App permissions required, and validate them at startup with clear error messages.

## 14. Test Coverage & CI
**Issue:** Existing tests cover basic exports but not full end-to-end flows.
**Suggestion:**
- Add unit tests for each service module (GitHub, Jira, LLM) using mocked HTTP responses.
- Add integration tests for key API endpoints (`/api/status`, `/api/tickets`, `/api/auth/*`) with mocked external services.
- Configure a CI pipeline (GitHub Actions) that runs `npm test`, lints the code, and optionally spins up a minimal Jira/GitHub mock harness.

## 15. Multi-Tenant Hardening
**Issue:** Multi-tenant support (multiple agents/users) is emerging but not fully isolated.
**Suggestion:**
- Clearly separate per-user state from global system state so one user cannot affect another user's tickets or repos.
- Add organization-level configuration (allowed orgs, default projects, rate limits per tenant).
- Consider persisting per-tenant preferences (e.g., default Jira project, default branch naming) in a configuration store instead of only env vars.

## 16. MCP & Editor Integration
**Issue:** The MCP server exposes powerful tools, but failure modes and configuration feedback in the editor can be improved.
**Suggestion:**
- Add more descriptive error messages and result payloads on MCP tools (e.g., clearly differentiate auth errors vs config vs logic errors).
- Document MCP capabilities in the README with example prompts and screenshots from VS Code.
- Add a simple MCP health check tool that verifies connectivity to the Sentinel HTTP API and reports configuration issues.

## 17. Deployment Profiles
**Issue:** Local development and production share many defaults.
**Suggestion:**
- Introduce explicit environment profiles (development, staging, production) with separate config files or env var prefixes.
- In production, tighten security (HTTPS-only cookies, secure session flags, stricter CORS) and reduce log verbosity.
- Provide example Docker Compose or Kubernetes manifests showing a recommended production topology (API + worker + Redis/DB).


## IMPLEMENTED
-------------------------------------------------------------------------------------------------------------

## 2. Token Refresh Logic
**Issue:** GitHub OAuth tokens may expire. The current system logs a 401 error but does not automatically refresh the token.
**Suggestion:** Implement a token refresh flow using the refresh token provided during the initial OAuth handshake.

## 18. UX for First-Time Setup
**Issue:** New users need to understand how to connect Jira, GitHub, and the GitHub App correctly.
**Suggestion:**
- Expand the onboarding flow in the UI: a short checklist or wizard that walks through OAuth, GitHub App installation, and Jira project selection.
- Add more visual cues in the dashboard showing which integrations are active and which steps remain.

These improvements should help make Sentinel more reliable, easier to operate in production, and friendlier for new users while preserving its current architecture.