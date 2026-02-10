# Integrate Sentinel MCP with GitHub Copilot (VS Code)

This guide explains how to connect the running **Sentinel MCP Server** to **GitHub Copilot Chat** in VS Code via the Model Context Protocol (MCP).

Once connected, Copilot can:
- **Read Jira Tickets**: "What is the acceptance criteria for NDE-123?"
- **Check Status**: "Is the build failing for the current PR?"
- **Trigger Actions**: "Force a poll now" or "Undraft this PR."

## Prerequisites
1.  **Node.js** installed.
2.  **Sentinel** repository cloned.
3.  **VS Code** with **Cline** (or compatible extension) installed.

---

## Configuration

### 1. Locate your Absolute Path
You need the full path to the `mcpServer.js` file.
*   **Windows Example**: `C:\Users\RajeshKodaganti(Quad\Downloads\GITHUB\SENTINEL\mcpServer.js`
*   **Mac/Linux Example**: `/Users/username/github/automation/mcpServer.js`

### 2. Add MCP Server to GitHub Copilot Chat

Use either the Settings UI or settings JSON. Both approaches are equivalent.

- Settings UI (recommended):
  1. Open VS Code Settings (Ctrl+,).
  2. Search for "Copilot MCP" or "MCP Servers" under GitHub Copilot Chat.
  3. Add a new MCP server:
     - Name: `sentinel`
     - Command: `node`
     - Args: `C:\\Users\\RajeshKodaganti(Quad\\Downloads\\GITHUB\\SENTINEL\\mcpServer.js`
     - Env → `PATH`: `C:\\Program Files\\nodejs;${env:PATH}`
     - Disabled: `false`
     - Always Allow: `[]`

- Settings JSON (advanced): add an MCP servers block that Copilot Chat reads. Example:

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "node",
      "args": [
        "C:\\Users\\RajeshKodaganti(Quad\\Downloads\\GITHUB\\SENTINEL\\mcpServer.js"
      ],
      "env": {
        "PATH": "C:\\Program Files\\nodejs;${env:PATH}"
      },
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

> Windows note: In JSON, use double backslashes (`\\`) in paths.

### 3. Reload and Verify
1. Reload the VS Code window to let Copilot pick up the new MCP server.
2. Open Copilot Chat. You should see MCP tools available and the server start without errors.

---

## Usage Examples

Once connected, simply ask Copilot Chat:

* **"Check the status of Jira ticket NDE-123."** → uses `get_jira_details`
* **"Why is the server reporting an error? Check the logs."** → uses `read_server_logs`
* **"I just added a ticket. Trigger a poll."** → uses `trigger_manual_poll`
* **"What projects are you monitoring?"** → uses `list_active_repos`

## Troubleshooting

* **Connection failed**: Ensure `node` is in PATH, or use the full path (e.g., `C:\\Program Files\\nodejs\\node.exe`).
* **Dependencies missing**: In the repo root, run `npm install`. This project requires `@modelcontextprotocol/sdk` and `zod` (already declared in package.json).
* **Module not found (@modelcontextprotocol/sdk)**: Re-run `npm install`. If npm is flaky, try `npx -y npm@latest install`.
* **Server can’t reach API**: Some tools call `http://localhost:3000/api`. If you use those tools, run the main service (`npm start`) so the API is available.
* **Manual test (optional)**: Inspect with MCP Inspector:

  ```powershell
  npx @modelcontextprotocol/inspector node mcpServer.js
  ```
