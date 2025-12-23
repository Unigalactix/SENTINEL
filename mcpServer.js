const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { generateWorkflowFile, getPullRequestChecks } = require('./githubService');
const { addComment } = require('./jiraService');

// Create the MCP Server
const server = new McpServer({
    name: "Jira Autopilot MCP",
    version: "1.0.0"
});

const API_BASE = 'http://localhost:3000/api';

// --- Resources ---

// 1. System Status
// URI: autopilot://status
server.resource(
    "system-status",
    "autopilot://status",
    async (uri) => {
        try {
            const response = await fetch(`${API_BASE}/status`);
            if (!response.ok) throw new Error('Dashboard not running');
            const data = await response.json();

            return {
                contents: [{
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify(data, null, 2)
                }]
            };
        } catch (error) {
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: "text/plain",
                    text: `Error fetching status: ${error.message}. Is the main server running on port 3000?`
                }]
            };
        }
    }
);

// --- Tools ---

// 1. Generate Workflow YAML
server.tool(
    "generate_workflow_yaml",
    "Generates a GitHub Actions CI pipeline YAML for a given language.",
    {
        language: z.enum(['node', 'python', 'dotnet']).describe("Language of the project"),
        repoName: z.string().describe("Full repository name (owner/repo)"),
        buildCommand: z.string().optional().describe("Custom build command"),
        testCommand: z.string().optional().describe("Custom test command"),
        deployTarget: z.string().optional().describe("Deployment target (azure-webapp)")
    },
    async ({ language, repoName, buildCommand, testCommand, deployTarget }) => {
        const yaml = generateWorkflowFile({ language, repoName, buildCommand, testCommand, deployTarget });
        return {
            content: [{ type: "text", text: yaml }]
        };
    }
);

// 2. Check PR Status
server.tool(
    "check_pr_status",
    "Checks the CI/CD status of a Pull Request for a given branch.",
    {
        repoName: z.string().describe("Full repository name (owner/repo)"),
        ref: z.string().describe("Branch name or Commit SHA to check")
    },
    async ({ repoName, ref }) => {
        const checks = await getPullRequestChecks({ repoName, ref });
        return {
            content: [{ type: "text", text: JSON.stringify(checks, null, 2) }]
        };
    }
);

// 3. Add Jira Comment
server.tool(
    "add_jira_comment",
    "Post a comment to a Jira ticket.",
    {
        issueKey: z.string().describe("The Jira Issue Key (e.g., PROJ-123)"),
        commentBody: z.string().describe("The text content of the comment")
    },
    async ({ issueKey, commentBody }) => {
        await addComment(issueKey, commentBody);
        return {
            content: [{ type: "text", text: `Comment added to ${issueKey}` }]
        };
    }
);

// 4. Delete Branch
server.tool(
    "delete_branch",
    "Delete a branch from the repository.",
    {
        repoName: z.string().describe("Target repository (owner/repo)"),
        branchName: z.string().describe("Name of the branch to delete")
    },
    async ({ repoName, branchName }) => {
        const { deleteBranch } = require('./githubService');
        const result = await deleteBranch({ repoName, branchName });
        if (result.deleted) {
            return {
                content: [{ type: "text", text: `Successfully deleted branch ${branchName}` }]
            };
        } else {
            return {
                isError: true,
                content: [{ type: "text", text: `Failed to delete branch: ${result.error}` }]
            };
        }
    }
);

// 5. Undraft PR
server.tool(
    "undraft_pr",
    "Mark a Pull Request as 'Ready for Review' (remove Draft status).",
    {
        repoName: z.string().describe("Target repository (owner/repo)"),
        pullNumber: z.number().describe("The Pull Request Number")
    },
    async ({ repoName, pullNumber }) => {
        const { markPullRequestReadyForReview } = require('./githubService');
        const result = await markPullRequestReadyForReview({ repoName, pullNumber });
        if (result.success) {
            return {
                content: [{ type: "text", text: `Successfully marked PR #${pullNumber} as Ready for Review.` }]
            };
        } else {
            return {
                isError: true,
                content: [{ type: "text", text: `Failed to undraft PR: ${result.error}` }]
            };
        }
    }
);

// 6. Merge PR
server.tool(
    "merge_pr",
    "Merge a Pull Request into its base branch.",
    {
        repoName: z.string().describe("Target repository (owner/repo)"),
        pullNumber: z.number().describe("The Pull Request Number"),
        method: z.enum(['merge', 'squash', 'rebase']).optional().describe("Merge method (default: squash)")
    },
    async ({ repoName, pullNumber, method }) => {
        const { mergePullRequest } = require('./githubService');
        const result = await mergePullRequest({ repoName, pullNumber, method: method || 'squash' });
        if (result.merged) {
            return {
                content: [{ type: "text", text: `Successfully merged PR #${pullNumber}.` }]
            };
        } else {
            return {
                isError: true,
                content: [{ type: "text", text: `Failed to merge PR: ${result.message}` }]
            };
        }
    }
);

// 7. Get Jira Details
server.tool(
    "get_jira_details",
    "Read the full details of a specific Jira ticket.",
    {
        issueKey: z.string().describe("The Jira Issue Key (e.g., NDE-123)")
    },
    async ({ issueKey }) => {
        const { getIssueDetails } = require('./jiraService');
        const details = await getIssueDetails(issueKey);
        return {
            content: [{ type: "text", text: JSON.stringify(details, null, 2) }]
        };
    }
);

// 8. Read Server Logs
server.tool(
    "read_server_logs",
    "Read the last N lines of the server log file.",
    {
        lines: z.number().optional().describe("Number of lines to read (default: 50)")
    },
    async ({ lines = 50 }) => {
        const fs = require('fs');
        const path = require('path');
        const logPath = path.join(__dirname, 'logs', 'server.log');

        try {
            if (!fs.existsSync(logPath)) {
                return { content: [{ type: "text", text: "Log file not found." }] };
            }
            const content = fs.readFileSync(logPath, 'utf8');
            const allLines = content.split('\n');
            const lastLines = allLines.slice(-lines).join('\n');
            return {
                content: [{ type: "text", text: lastLines }]
            };
        } catch (e) {
            return { isError: true, content: [{ type: "text", text: `Error reading log: ${e.message}` }] };
        }
    }
);

// 9. Trigger Manual Poll
server.tool(
    "trigger_manual_poll",
    "Force the Autopilot to check Jira for new tickets immediately.",
    {},
    async () => {
        try {
            const response = await fetch(`${API_BASE}/poll`, { method: 'POST' });
            const data = await response.json();
            return {
                content: [{ type: "text", text: `Poll Triggered: ${data.message}` }]
            };
        } catch (e) {
            return { isError: true, content: [{ type: "text", text: `Failed to trigger poll: ${e.message}` }] };
        }
    }
);

// 10. List Active Repos / Projects
server.tool(
    "list_active_repos",
    "List all Jira projects currently being monitored by the Autopilot.",
    {},
    async () => {
        try {
            const response = await fetch(`${API_BASE}/projects`);
            const data = await response.json();
            return {
                content: [{ type: "text", text: `Monitored Projects: ${data.projects.join(', ')}` }]
            };
        } catch (e) {
            return { isError: true, content: [{ type: "text", text: `Failed to list projects: ${e.message}` }] };
        }
    }
);

// Start the server transport
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in MCP Server:", error);
    process.exit(1);
});
