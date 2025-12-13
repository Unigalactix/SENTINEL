# Jira Autopilot & GitHub Automation Service 🚀

A comprehensive Node.js automation service that bridges Jira and GitHub. It acts as an autonomous agent that polls Jira for tickets, intelligently detects project requirements (Language, Repo), and generates remote CI/CD workflows via GitHub Pull Requests.

## Features ✨

-   **Autopilot Polling**: Automatically polls Jira every 30 seconds for new tickets.
-   **Smart Language Detection**: Automatically parses repository files to detect the tech stack:
    -   `package.json` → **Node.js**
    -   `*.csproj` / `*.sln` → **.NET**
    -   `requirements.txt` → **Python**
-   **Priority Queue**: Processes tickets based on Priority (Highest -> Lowest).
-   **Stable PR Workflow**: Creates specific feature branches (`chore/{key}-workflow-setup`) and opens Pull Requests.
-   **Live Dashboard**: Real-time UI at `http://localhost:3000` showing:
    -   Active Queue & History
    -   **Live CI/CD Checks**: See the status of checks (e.g., "Build", "Tests") on the cards directly.
    -   Quick Links to Jira Tickets and GitHub PRs.
-   **mcp-server**: Built-in Model Context Protocol server for AI Agents (Claude Desktop, etc.).

## Prerequisites

-   **Node.js** (v18 or higher)
-   **Jira Account** (Cloud) with an API Token.
-   **GitHub Account** with a Personal Access Token (Classic) having `repo`, `workflow`, and `read:user` scopes.

## Setup & Installation

1.  **Clone the repository**:
    ```bash
    git clone <your-repo-url>
    cd AUTOMATION
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment**:
    Create a `.env` file in the root directory:
    ```env
    GHUB_TOKEN=ghp_your_github_token_here
    JIRA_BASE_URL=https://your-domain.atlassian.net
    JIRA_USER_EMAIL=your-email@example.com
    JIRA_API_TOKEN=your_jira_api_token
    JIRA_PROJECT_KEY=PROJ,ECT
    PORT=3000
    ```

## Usage

### Run Locally
```bash
npm start
```
-   **Dashboard**: `http://localhost:3000`
-   **MCP Server** (Manual): `npm run start:mcp` (Usually run by AI Client)

### Run with Docker 🐳
Build and run the containerized application:
```bash
docker build -t jira-automation .
docker run -p 3000:3000 --env-file .env jira-automation
```

### Running Tests
Execute the Jest unit tests:
```bash
npm test
```

## AI Integration (MCP) 🤖
This project includes an **MCP Server** (`mcpServer.js`).
Add this to your Claude Desktop config to give your AI access to the agent's tools:
```json
"mcpServers": {
  "jira-autopilot": {
    "command": "node",
    "args": ["/absolute/path/to/AUTOMATION/mcpServer.js"]
  }
}
```
**Capabilities:**
-   `autopilot://status`: Read live system status.
-   `generate_workflow_yaml`: Ask AI to draft a CI file using the service's logic.
-   `check_pr_status`: Ask AI to check if a specific PR is passing.

## Architecture

See [automation_workflow.md](./automation_workflow.md) for a detailed sequence diagram.

## License

MIT
