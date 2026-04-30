# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
