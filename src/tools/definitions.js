const { z } = require('zod');
const { generateWorkflowFile, getPullRequestChecks, deleteBranch, markPullRequestReadyForReview, mergePullRequest } = require('../services/githubService');
const { addComment, getIssueDetails } = require('../services/jiraService');
const fs = require('fs');
const path = require('path');

// Helper for API calls to the main server
const API_BASE = 'http://localhost:3000/api';

const tools = [
    {
        name: "generate_workflow_yaml",
        description: "Generates a GitHub Actions CI pipeline YAML for a given language.",
        schema: z.object({
            language: z.enum(['node', 'python', 'dotnet', 'java']).describe("Language of the project"),
            repoName: z.string().describe("Full repository name (owner/repo)"),
            buildCommand: z.string().optional().describe("Custom build command"),
            testCommand: z.string().optional().describe("Custom test command"),
            deployTarget: z.string().optional().describe("Deployment target (azure-webapp)")
        }),
        handler: async ({ language, repoName, buildCommand, testCommand, deployTarget }) => {
            const yaml = generateWorkflowFile({ language, repoName, buildCommand, testCommand, deployTarget });
            return {
                content: [{ type: "text", text: yaml }]
            };
        }
    },
    {
        name: "check_pr_status",
        description: "Checks the CI/CD status of a Pull Request for a given branch.",
        schema: z.object({
            repoName: z.string().describe("Full repository name (owner/repo)"),
            ref: z.string().describe("Branch name or Commit SHA to check")
        }),
        handler: async ({ repoName, ref }) => {
            const checks = await getPullRequestChecks({ repoName, ref });
            return {
                content: [{ type: "text", text: JSON.stringify(checks, null, 2) }]
            };
        }
    },
    {
        name: "add_jira_comment",
        description: "Post a comment to a Jira ticket.",
        schema: z.object({
            issueKey: z.string().describe("The Jira Issue Key (e.g., PROJ-123)"),
            commentBody: z.string().describe("The text content of the comment")
        }),
        handler: async ({ issueKey, commentBody }) => {
            await addComment(issueKey, commentBody);
            return {
                content: [{ type: "text", text: `Comment added to ${issueKey}` }]
            };
        }
    },
    {
        name: "delete_branch",
        description: "Delete a branch from the repository.",
        schema: z.object({
            repoName: z.string().describe("Target repository (owner/repo)"),
            branchName: z.string().describe("Name of the branch to delete")
        }),
        handler: async ({ repoName, branchName }) => {
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
    },
    {
        name: "undraft_pr",
        description: "Mark a Pull Request as 'Ready for Review' (remove Draft status).",
        schema: z.object({
            repoName: z.string().describe("Target repository (owner/repo)"),
            pullNumber: z.number().describe("The Pull Request Number")
        }),
        handler: async ({ repoName, pullNumber }) => {
            const result = await markPullRequestReadyForReview({ repoName, pullNumber });
            if (result.ok) {
                return {
                    content: [{ type: "text", text: `Successfully marked PR #${pullNumber} as Ready for Review.` }]
                };
            } else {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to undraft PR: ${result.message || 'Unknown error'}` }]
                };
            }
        }
    },
    {
        name: "merge_pr",
        description: "Merge a Pull Request into its base branch.",
        schema: z.object({
            repoName: z.string().describe("Target repository (owner/repo)"),
            pullNumber: z.number().describe("The Pull Request Number"),
            method: z.enum(['merge', 'squash', 'rebase']).optional().describe("Merge method (default: squash)")
        }),
        handler: async ({ repoName, pullNumber, method }) => {
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
    },
    {
        name: "get_jira_details",
        description: "Read the full details of a specific Jira ticket.",
        schema: z.object({
            issueKey: z.string().describe("The Jira Issue Key (e.g., NDE-123)")
        }),
        handler: async ({ issueKey }) => {
            const details = await getIssueDetails(issueKey);
            return {
                content: [{ type: "text", text: JSON.stringify(details, null, 2) }]
            };
        }
    },
    {
        name: "read_server_logs",
        description: "Read the last N lines of the server log file.",
        schema: z.object({
            lines: z.number().optional().describe("Number of lines to read (default: 50)")
        }),
        handler: async ({ lines = 50 }) => {
            const logPath = path.join(__dirname, '../../logs', 'server.log');
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
    },
    {
        name: "trigger_manual_poll",
        description: "Force the Autopilot to check Jira for new tickets immediately.",
        schema: z.object({}),
        handler: async () => {
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
    },
    {
        name: "list_active_repos",
        description: "List all Jira projects currently being monitored by the Autopilot.",
        schema: z.object({}),
        handler: async () => {
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
    }
];

module.exports = tools;
