# How to Integrate Jira Autopilot MCP with VS Code AI Agents

This guide explains how to connect your running **Jira Autopilot MCP Server** to AI coding assistants in VS Code, such as **Cline** (formerly Claude Dev) or **Roo Code**.

Once connected, your AI agent can:
-   **Read Jira Tickets**: "What is the acceptance criteria for NDE-123?"
-   **Check Status**: "Is the build failing for the current PR?"
-   **Trigger Actions**: "Force a poll now" or "Undraft this PR."

## Prerequisites
1.  **Node.js** installed.
2.  **Jira Autopilot** repository cloned.
3.  **VS Code** with **Cline** (or compatible extension) installed.

---

## Configuration Steps

### 1. Locate your Absolute Path
You need the full path to the `mcpServer.js` file.
*   **Windows Example**: `C:\Users\RajeshKodaganti(Quad\Downloads\GITHUB\AUTOMATION\mcpServer.js`
*   **Mac/Linux Example**: `/Users/username/github/automation/mcpServer.js`

### 2. Configure Cline / Roo Code
1.  Open the **Cline** extension in VS Code sidebar.
2.  Click the **Settings (Gear Icon)**.
3.  Scroll down to **"MCP Servers"** section.
4.  Add a new server configuration:

```json
{
  "jira-autopilot": {
    "command": "node",
    "args": [
      "C:\\Users\\RajeshKodaganti(Quad\\Downloads\\GITHUB\\AUTOMATION\\mcpServer.js"
    ],
    "env": {
      "PATH": "C:\\Program Files\\nodejs;${env:PATH}" 
    },
    "disabled": false,
    "alwaysAllow": []
  }
}
```

> **Note on Windows Paths**: You must use **double backslashes** (`\\`) in the JSON config.

### 3. Restart the Agent
1.  Close and reopen the Cline panel, or reload VS Code window.
2.  Cline should show a green indicator next to "MCP Servers".

---

## Usage Examples

Once connected, simply ask Cline in the chat:

*   **"Check the status of Jira ticket NDE-123."** -> (Calls `get_jira_details`)
*   **"Why is the server reporting an error? Check the logs."** -> (Calls `read_server_logs`)
*   **"I just added a ticket. Trigger a poll."** -> (Calls `trigger_manual_poll`)
*   **"What projects are you monitoring?"** -> (Calls `list_active_repos`)

## Troubleshooting

*   **Connection Failed**: Ensure `node` is in your system PATH, or specify the full path to `node.exe` in the "command" field (e.g., `C:\\Program Files\\nodejs\\node.exe`).
*   **Dependencies Missing**: Make sure you ran `npm install` in the AUTOMATION folder.
*   **Process Error**: Check if another instance is blocking port 3000 (though MCP uses stdio, it might try to fetch status from localhost:3000).
