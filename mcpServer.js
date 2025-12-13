const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { generateWorkflowFile, getPullRequestChecks } = require('./githubService');

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
