# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.1.0] - 2026-11-16

Security remediation release. Sentinel is now safe to run as a deployed, authenticated service: the API requires authentication in production, OAuth tokens are never exposed by the status endpoint, and each operator's token is isolated to their own work.

### Added
- **CI Workflow**: New `.github/workflows/ci.yml` runs ESLint and the full Jest test suite on every push and pull request to `main`. The Azure deploy workflow now runs the same lint + test job first and is gated on it passing.
- **`LICENSE` File**: MIT license text is now included in the repository (previously claimed in the README but missing).
- **Repo Allowlist**: Target repositories are restricted by the new `ALLOWED_REPOS` / `ALLOWED_ORGS` environment variables. When neither is set, the default is repos owned by the issues-repo owner or by the signed-in operator.
- **Internal Token for MCP Scans**: The MCP `trigger_manual_poll` tool can send a `SENTINEL_INTERNAL_TOKEN` internal token header so it can call the production API, which otherwise requires an authenticated session.
- **Deploy Guard**: The Azure deploy workflow now fails early if the `GITHUB_ISSUES_REPO` secret is empty, instead of deploying a scanner with no issues repo.

### Changed
- **Version Aligned to 3.1.0**: `package.json` and the MCP server now both report 3.1.0 (previously 1.0.0 in code vs 3.0.0 in docs).
- **Per-Operator Token Context**: Replaced the single module-global active token with per-operator token isolation via async context. Each signed-in operator's token is scoped to their own background work. Multiple operators can be signed in at once; dashboard operations state (queue, logs, history) remains shared — this is token isolation, not full multi-tenant data isolation.
- **`NODE_ENV=production` in Deployments**: The Dockerfile and the Azure deploy workflow now set `NODE_ENV=production`. Runtime config editing and the MCP Inspector stay disabled in production.
- **Post-PR Status Config**: `config/board_post_pr_status.json` is keyed by repo full name (`owner/repo`), with `POST_PR_STATUS` as the global default.

### Fixed
- **Main-PR Lifecycle Completed**: When the main PR merges, the source issue is now transitioned to **Done** and monitoring stops. On CI failure, the issue is commented with the failure details and returned to **To Do**. Previously the loop never reached Done.
- **Issue Directives Now Work**: `build:`, `test:`, and `deploy:` directives in the issue body are now actually honoured when generating workflows and PRs (previously parsed but ignored).
- **Failing .NET Language-Detection Test**: Fixed the mocked Octokit client in `tests/githubService.test.js` so .NET detection is genuinely exercised; the full suite is now 85/85 passing.
- **ESLint Errors**: Fixed all ESLint errors (including a constant-condition and an empty block in `server.js` and a useless escape in `githubService.js`); lint now passes cleanly.
- **Undeclared Dependency**: `zod-to-json-schema`, required directly by `llmService.js`, is now declared in `package.json` instead of only arriving transitively via the MCP SDK.

### Removed
- **Dead Jira Utilities**: Deleted `src/utils/check_boards.js` and `scripts/debug_jira_types.js`, leftover Jira-era utilities for a service that no longer exists.
- **Free-Text Repo Guessing**: Removed the fallback that guessed a target `owner/repo` from free text in the issue body. The target repo now comes only from the issue's `repo:` directive or `DEFAULT_REPO`.
- **Immediate-Merge Fallback**: Removed the fallback that merged a Copilot sub-PR immediately when enabling auto-merge failed.
- **Deploy to Azure Button**: Removed the README button linking to a non-existent `azuredeploy.json`. Deployment is via the GitHub Actions workflow to Azure Web Apps.

### Security
- **Status Endpoint No Longer Returns Tokens**: `GET /api/status` now returns an explicit, safe status DTO. OAuth access and refresh tokens are never serialized into the response.
- **API Authentication Guards**: All state-changing and sensitive API routes now require an authenticated GitHub OAuth session in production (or GitHub App mode, or an internal token header for MCP-triggered calls). Previously routes such as pause, config, log download, and manual poll could be invoked unauthenticated.
- **OAuth State Verification**: The OAuth `state` parameter is now generated with `crypto` and verified on callback, closing the login CSRF gap. Previously it was generated with `Math.random()` and never checked.
- **Session Secret Fail-Fast**: Production refuses to boot without a strong `SESSION_SECRET` (at least 16 characters, and not the old built-in default `sentinel-dev-secret-change-in-prod`).
- **Sub-PR Merge Gating**: Copilot sub-PR auto-merge is now gated on successful check runs. A sub-PR is approved and merged only after its checks pass.
- **Destructive Tool Gating**: The MCP/LLM tools `merge_pr` and `delete_branch` are disabled unless `SENTINEL_ALLOW_DESTRUCTIVE=true`.

---

## [3.0.0] - 2026-04-30

### Added
- **GitHub Issues Migration**: Sentinel now reads from and writes to **GitHub Issues** exclusively. `githubIssueService.js` handles all issue polling, creation, updating, and commenting.
- **Post-Inspection Issue Creation**: `/api/inspect` now auto-creates a GitHub Issue in `GITHUB_ISSUES_REPO` with full inspection findings and a `sentinel:todo` label after every successful repo scan. The response includes `issueKey` and `issueUrl` for immediate navigation.
- **`getActiveOrgPRsWithGHKeys`**: New function in `githubService.js` that discovers open org PRs referencing `GH-NNN` keys in title, body, or branch name—replaces the Jira-key reconciliation logic.
- **`/api/issues-source` Endpoint**: Returns the configured `GITHUB_ISSUES_REPO` and label to the dashboard (avoids `process.env` in browser JavaScript).
- **`sentinel:todo` Label Support**: Inspection results are filed with the `sentinel:todo` label so they are automatically picked up on the next scan.

### Changed
- **Manual-Only Polling**: Removed all automatic 30-second `setTimeout(poll, ...)` scheduling. `poll()` is now a one-shot function invoked exclusively on demand.
  - Dashboard: "Scan Now" button triggers `POST /api/poll`
  - Idle system phase is now **"Ready"** (was "Waiting")
- **`global.forcePoll` Fixed**: Was a no-op comment; now correctly set to `poll` at the end of `startPolling()` so the `/api/poll` endpoint always invokes the real scan function.
- **`/api/poll` Concurrency Guard**: Returns `{ phase }` without re-triggering if a scan is already in progress.
- **`reconcileActivePRsOnStartup`**: Switched from `getActiveOrgPRsWithJiraKeys` (Jira `ABC-123`) to `getActiveOrgPRsWithGHKeys` (`GH-NNN`). `issueUrl` construction is now null-safe.
- **`scripts/inspect_repo.js`**: Replaced `jiraService` import with `githubIssueService`. Removed `JIRA_PROJECT_KEY` dependency. `processRepo()` returns `{ issueKey, issueUrl }`.
- **Error handling in inspect_repo.js**: Fixed try/catch structure to ensure `return` is only reached on success; outer catch handles search failures gracefully.
- **Status filter regex** in `inspect_repo.js`: Changed from loose `/done|closed|resolved/i` to strict `/^(done|closed|resolved)$/i` to prevent false positives (e.g. "Postponed").

### Removed
- **Automatic 30-second polling timer** (`POLL_INTERVAL_MS` constant and all `setTimeout(poll, POLL_INTERVAL_MS)` calls)
- **Jira fields from Secrets Sidebar**: Removed Jira Base URL, Jira Email, and Jira API Token input fields
- **Jira-style countdown timer** from the dashboard header
- **"MCP Inspector" launch button** (dev tool) from the dashboard
- **Jira project selection step** from the setup checklist panel
- **`onboardingProjects` / `selectedJiraProject`** browser state and related localStorage helpers (`getStoredJiraProject`, `setStoredJiraProject`, `ensureOnboardingProjectsLoaded`)

### UI Changes
- **Dashboard header**: Countdown timer replaced with a prominent **"Scan Now"** button that shows "Scanning…" while active
- **"Jira Ticket" hero button** renamed to **"GitHub Issue"**
- **"Create Jira Ticket" modal** renamed to **"Create GitHub Issue"**
- **Setup checklist**: Replaced "Select primary Jira project" step with "GitHub Issues Repo configured" step
- **Inspections panel**: GitHub issue URLs now fetched via `/api/issues-source` (browser-compatible); creation dates restored in the listing
- **Secrets sidebar**: Now only shows GitHub Token, GitHub Org, GitHub Issues Repo, and LLM Key

---

## [2.1.0] - 2026-02-09

### Added
- **UI Documentation**: README now includes a **Screenshots** section that references images in `docs/ui/*` (dashboard, login/install, logs, sidebar). When updating the UI, also refresh these screenshots so the docs stay visually accurate.
- **Multi-Tenant Agent System**: Replaced single global `activeUserToken` with `activeAgents` Map for concurrent user support
  - `registerAgent()`, `removeAgent()`, `getAgent()`, `getFirstAgent()` lifecycle functions
  - `cleanupStaleAgents()` runs every 15 minutes, removes agents inactive for 1 hour
  - `/api/status` now returns `myAgent`, `allAgents`, `activeAgentsCount`
- **Agent Count Badge**: Dashboard header displays active agent count when > 1 user is logged in
- **Independent Inspection Fetching**: Moved INS board ticket fetch to its own 60-second timer, preventing crashes from blocking the main poll loop

### Fixed
- **Cloud Polling Blocked**: Poll loop was gated on deprecated `systemStatus.activeUserToken`; now uses `getFirstAgent()` from `activeAgents` Map
- **`/api/jira-base-url` Endpoint**: Repaired malformed endpoint with escaped newlines
- **Dashboard Crash**: Fixed `new URL(null)` TypeError when `currentJiraUrl` was null, which silently killed timer and terminal feed

### Changed
- OAuth callback now registers agents via `registerAgent(user, token, hasCopilot)`
- Logout endpoint now calls `removeAgent(userId)` before destroying session
- `systemStatus.activeUserToken` and `systemStatus.activeUser` marked as **DEPRECATED**

---

## [2.0.0] - 2026-01-29

### Added
- **Agentic AI Analysis**: Azure OpenAI integration for repository summarization, fix planning, and workflow generation
- **GitHub Copilot Integration**: `@copilot` prompt generation with context-aware PR descriptions
- **Sub-PR Management**: Automatic detection, approval, and merging of Copilot-generated sub-PRs
- **Auto-Merge**: Enable GitHub Auto-Merge on approved sub-PRs with squash strategy
- **PR Monitoring (Sentinel Loop)**: Continuous monitoring of open PRs for CI status, auto-approve, and merge
- **Reconciliation on Startup**: `reconcileActivePRsOnStartup()` scans org for open PRs with Jira keys
- **Pause/Resume**: Dashboard toggle to pause/resume ticket processing
- **Inspection Board**: `/api/inspections` endpoint for INS board tickets
- **Repo Inspector**: `scripts/inspect_repo.js` standalone tool for auditing repositories
- **MCP Server**: `mcpServer.js` exposes tools for external AI agents (Claude Desktop, VS Code Copilot)
- **DevOps Scan**: `devopsChecks.js` for comprehensive repository health checks
- **Per-Board Status Mapping**: `config/board_post_pr_status.json` for custom post-PR Jira transitions

### Changed
- Authentication moved from service account to **GitHub OAuth** (per-user security model)
- Language detection priority: Jira Fields → Instruction Files → Code Analysis → Defaults
- Workflow YAML generation includes CodeQL security scans and Docker/ACR build jobs

---

## [1.0.0] - 2026-01-19

### Added
- **Core Polling Loop**: 30-second Jira polling for "To Do" tickets
- **CI/CD Workflow Generation**: Auto-generates GitHub Actions YAML for Node.js, Python, .NET, and Java
- **PR Creation**: Feature branch creation and Pull Request opening
- **Jira Transitions**: Automatic ticket state management (To Do → In Progress → Done)
- **Live Dashboard**: Real-time web UI at `http://localhost:3000`
- **GitHub OAuth**: Per-user authentication for secure API operations
- **Dockerfile Generation**: Auto-generates Dockerfiles based on detected language
- **Export Verification Tests**: `__tests__/exports.test.js` validates 50+ function exports
