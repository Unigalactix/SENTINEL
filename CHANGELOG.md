# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2.1.0] - 2026-02-09

### Added
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
