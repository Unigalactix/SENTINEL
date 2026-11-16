# Integrate Sentinel MCP with GitHub Copilot (VS Code)

This guide explains how to connect the running **Sentinel MCP Server** to **GitHub Copilot Chat** in VS Code via the Model Context Protocol (MCP).

Once connected, Copilot can:
- **Read GitHub Issues**: "What does issue GH-123 ask for?"
- **Check Status**: "What is Sentinel doing right now?" or "Is the build failing for the current PR?"
- **Trigger Actions**: "Scan for new issues now" or "Undraft this PR."

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

* **"What does GitHub Issue GH-123 ask for?"** → uses `get_github_issue`
* **"What is Sentinel doing right now?"** → uses the `sentinel://status` resource
* **"Why is the server reporting an error? Check the logs."** → uses `read_server_logs`
* **"I just labelled an issue `sentinel:todo`. Trigger a scan."** → uses `trigger_manual_poll`
* **"Is the build passing for this PR?"** → uses `check_pr_status`
* **"Post that summary as a comment on GH-123."** → uses `add_github_issue_comment`
* **"Generate the CI workflow YAML for this repo."** → uses `generate_workflow_yaml`
* **"What projects are you monitoring?"** → uses `list_active_repos`
* **"Mark PR #42 as ready for review."** → uses `undraft_pr`

The full MCP surface is: the `sentinel://status` resource and the tools `generate_workflow_yaml`, `check_pr_status`, `add_github_issue_comment`, `delete_branch`, `undraft_pr`, `merge_pr`, `get_github_issue`, `read_server_logs`, `trigger_manual_poll`, and `list_active_repos`.

> ⚠️ `merge_pr` and `delete_branch` are **destructive** and are disabled unless the MCP server is started with `SENTINEL_ALLOW_DESTRUCTIVE=true`.

> Production note: against a deployed instance, the production API requires an authenticated session. Set `SENTINEL_INTERNAL_TOKEN` (on both the server and the MCP server) so `trigger_manual_poll` can send it as an internal token header.

## Troubleshooting

* **Connection failed**: Ensure `node` is in PATH, or use the full path (e.g., `C:\\Program Files\\nodejs\\node.exe`).
* **Dependencies missing**: In the repo root, run `npm install`. This project requires `@modelcontextprotocol/sdk` and `zod` (already declared in package.json).
* **Module not found (@modelcontextprotocol/sdk)**: Re-run `npm install`. If npm is flaky, try `npx -y npm@latest install`.
* **Server can’t reach API**: Some tools call `http://localhost:3000/api`. If you use those tools, run the main service (`npm start`) so the API is available.
* **Manual test (optional)**: Inspect with MCP Inspector:

  ```powershell
  npx @modelcontextprotocol/inspector node mcpServer.js
  ```
