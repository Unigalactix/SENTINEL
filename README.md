# Sentinel 🛡️

> **Autonomous DevOps Orchestrator for Jira ↔ GitHub**

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FUnigalactix%2FSENTINEL%2Fmain%2Fazuredeploy.json)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Azure-0072C6?style=for-the-badge&logo=microsoftazure)](https://sentineldevagent.azurewebsites.net)
[![Install App](https://img.shields.io/badge/Install%20App-GitHub-181717?style=for-the-badge&logo=github)](https://github.com/apps/sentinel-devops-automation-agent)

Sentinel continuously monitors Jira boards, automatically creates GitHub PRs with CI/CD workflows, and uses AI to implement ticket requirements—closing the loop from "To Do" to "Done" with minimal human intervention.

---

## How It Works

```mermaid
flowchart LR
    subgraph JIRA["🟦 Jira"]
        T1[📋 Ticket Created]
        T2[✅ Done]
    end

    subgraph SENTINEL["🤖 Sentinel"]
        S1[Poll every 30s]
        S2[Analyze Repo]
        S3[Generate @copilot Prompt]
    end

    subgraph GITHUB["🐙 GitHub"]
        G1[Create PR]
        G2["@copilot Implements"]
        G3[CI/CD Runs]
        G4[Auto-Merge]
    end

    T1 -->|"New ticket"| S1
    S1 --> S2 --> S3 --> G1
    G1 --> G2 --> G3 --> G4
    G4 -->|"Webhook"| T2
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Auto-Polling** | Scans Jira every 30s for new "To Do" tickets |
| **Multi-Tenant Auth** | Multiple users can log in simultaneously, each with isolated agent contexts |
| **Per-User OAuth** | Uses GitHub OAuth to perform actions as the logged-in user |
| **AI Analysis** | Uses Azure OpenAI to analyze repos and plan fixes |
| **Smart Detection** | Auto-detects Node/Python/.NET/Java from repo files |
| **@copilot Integration** | Posts context-aware prompts to trigger GitHub Copilot |
| **Secret Placeholders** | Uses `${{ secrets.X }}` in workflows—never exposes values |
| **Sub-PR Management** | Detects, approves, and merges Copilot-generated PRs |
| **Live Dashboard** | Real-time UI with timer, terminal feed, agent badge, and inspection panel |
| **Cloud Deployment** | Azure Web App deployment with Docker support |
| **MCP Server** | Exposes tools for AI agents (Claude, VS Code Copilot) |

---

## Architecture

```mermaid
flowchart TB
    subgraph Client["👤 User"]
        JIRA_UI[Jira Board]
        DASHBOARD[Sentinel Dashboard]
    end

    subgraph Sentinel["🤖 Sentinel Server"]
        SERVER[server.js<br/>Port 3000]
        MCP[mcpServer.js<br/>MCP Protocol]
        
        subgraph Services["Services Layer"]
        gh[githubService.js<br/>OAuth & API]
            JIRA_SVC[jiraService.js<br/>Tickets]
            LLM[llmService.js<br/>Azure OpenAI]
            DEVOPS[devopsChecks.js<br/>Repo scanning]
        end
    end

    subgraph External["☁️ External APIs"]
        JIRA_API[Jira REST API]
        GH_API[GitHub REST API]
        AZURE[Azure OpenAI]
    end

    JIRA_UI --> JIRA_API
    DASHBOARD --> SERVER
    SERVER --> Services
    gh --> GH_API
    JIRA_SVC --> JIRA_API
    LLM --> AZURE
    MCP --> Services
```

---

## Quick Start

### 1. Install
```bash
git clone https://github.com/Unigalactix/SENTINEL.git
cd SENTINEL
npm install
```

### 2. Configure `.env`
```env
# GitHub OAuth (Required for Per-User Auth)
OAUTH_CLIENT_ID=your_client_id
OAUTH_CLIENT_SECRET=your_client_secret

# Jira
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_USER_EMAIL=you@example.com
JIRA_API_TOKEN=your_jira_token

# AI (Optional)
AZURE_OPENAI_API_KEY=your_key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o
USE_GH_COPILOT=true

# Session
SESSION_SECRET=your_random_secret
```

### 3. Run
```bash
npm start          # Start server at http://localhost:3000
npm run start:mcp  # Start MCP server for AI agents
```

---

## Project Structure

```
SENTINEL/
├── server.js              # Main orchestrator (polling, API, multi-tenant agents)
├── mcpServer.js           # MCP server for AI agents
├── CHANGELOG.md           # Version history & change tracking
├── public/
│   └── index.html         # Live dashboard UI (timer, feed, agent badge)
├── src/
│   ├── services/
│   │   ├── githubService.js   # GitHub API (42 exports)
│   │   ├── authService.js     # OAuth handling
│   │   ├── jiraService.js     # Jira API (10 exports)
│   │   ├── llmService.js      # Azure OpenAI integration
│   │   └── devopsChecks.js    # Repo scanning
│   └── tools/
│       └── definitions.js     # MCP tool definitions
├── scripts/
│   └── inspect_repo.js    # Standalone repo inspector
├── __tests__/
│   └── exports.test.js    # Export verification tests
├── config/
│   └── board_post_pr_status.json
├── docs/                  # Project documentation
│   ├── agents.md          # Agent architecture & changelog reminder
│   ├── DETAILED_WORKFLOW.md
│   ├── PROJECT_REPORT.md
│   ├── workflow-flow.md
│   ├── suggestions.md
│   └── vscode_integration.md
├── logs/
│   └── server.log
└── Dockerfile             # Container definition
```

---

## Workflow Lifecycle

```mermaid
sequenceDiagram
    participant User
    participant Jira
    participant Sentinel
    participant GitHub
    participant Copilot

    User->>Jira: Create ticket (To Do)
    loop Every 30s
        Sentinel->>Jira: Poll for new tickets
    end
    Jira-->>Sentinel: New ticket found
    
    Sentinel->>GitHub: Analyze repo structure
    Sentinel->>Sentinel: Generate AI fix strategy
    Sentinel->>GitHub: Create feature branch
    Sentinel->>GitHub: Create PR with @copilot prompt
    
    Copilot->>GitHub: Implement changes (sub-PR)
    Sentinel->>GitHub: Detect & approve sub-PR
    Sentinel->>GitHub: Merge sub-PR into feature branch
    
    GitHub->>GitHub: CI/CD runs
    alt Tests Pass
        Sentinel->>GitHub: Auto-merge to main
        Sentinel->>Jira: Transition to Done
    else Tests Fail
        Sentinel->>Jira: Add failure comment
    end
```

---

## @copilot Prompt Format

Sentinel generates **context-aware prompts** (not hardcoded YAML):

```markdown
@copilot /fix **PROJ-123: Add user authentication**

[Description from Jira ticket]

---
## 🤖 AI Analysis
[AI-generated fix strategy based on repo analysis]

---
## Repository Context
| Property | Value |
|----------|-------|
| **Repo** | Org/RepoName |
| **Language** | node |
| **Available Secrets** | ${{ secrets.ACR_LOGIN_SERVER }}, ... |

> **Note:** This repository already has a CI/CD workflow.

## Guidelines
1. Read the entire repository first
2. Use secret placeholders—never hardcode values
3. Only create workflows if needed
```

---

## NPM Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run start:mcp` | Run MCP server for AI agents |
| `npm test` | Run all Jest tests |
| `npm run test:exports` | Verify all function exports |
| `npm run lint` | Run ESLint |
| `npm run verify` | Lint + export tests |

---

## MCP Integration

Add to Claude Desktop's `config.json`:

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "node",
      "args": ["C:/path/to/SENTINEL/mcpServer.js"]
    }
  }
}
```

**Available Tools:**
- `sentinel://status` — Live system status
- `generate_workflow_yaml` — Generate CI/CD workflow
- `check_pr_status` — Check PR status

---

## GitHub Secrets for Workflows

| Secret | Purpose |
|--------|---------|
| `ACR_LOGIN_SERVER` | Azure Container Registry URL |
| `ACR_USERNAME` | ACR username |
| `ACR_PASSWORD` | ACR password |
| `AZURE_WEBAPP_APP_NAME` | Web App name |
| `AZURE_WEBAPP_PUBLISH_PROFILE` | Publish profile XML |
| `OAUTH_CLIENT_ID` | GitHub OAuth App Client ID |
| `OAUTH_CLIENT_SECRET` | GitHub OAuth App Client Secret |
| `JIRA_API_TOKEN` | Jira API Token |
| `SESSION_SECRET` | Session Encryption Key |

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and detailed change tracking.

---

## License

MIT
