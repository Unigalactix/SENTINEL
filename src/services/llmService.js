const { AzureOpenAI } = require("openai");
const { zodToJsonSchema } = require("zod-to-json-schema");
const tools = require("../tools/definitions"); // [NEW] Shared tools
require("dotenv").config();

class LLMService {
    constructor() {
        this.client = null;
        this.deployment = process.env.LLM_DEPLOYMENT_NAME // Corrected form
            ? process.env.LLM_DEPLOYMENT_NAME.replace(/^"|"$/g, '')
            : 'gpt-5.2-chat';

        this.init();
    }

    init() {
        try {
            if (process.env.LLM_API_KEY && process.env.LLM_ENDPOINT) {
                this.client = new AzureOpenAI({
                    apiKey: process.env.LLM_API_KEY,
                    endpoint: process.env.LLM_ENDPOINT.replace(/^"|"$/g, ''),
                    apiVersion: process.env.LLM_API_VERSION || "2024-02-15-preview",
                    deployment: this.deployment
                });
                console.log('[LLMService] Azure OpenAI client initialized.');
            } else {
                console.warn('[LLMService] Missing Azure OpenAI credentials in .env');
            }
        } catch (e) {
            console.error('[LLMService] Failed to initialize client:', e);
        }
    }

    /**
     * Generates a concise summary of the repository.
     * @param {string} fileStructure - Tree structure or list of files
     * @param {string} readmeContent - Content of README.md
     * @returns {Promise<string>}
     */
    async summarizeRepo(fileStructure, readmeContent) {
        if (!this.client) return "LLM not initialized.";

        const prompt = `You are a technical analyst. Summarize this repository in 2-3 concise sentences.
    Focus on the tech stack, main purpose, and key functionality.

    File Structure:
    ${fileStructure.substring(0, 2000)}

    README:
    ${readmeContent ? readmeContent.substring(0, 3000) : "No README"}
    `;

        try {
            const response = await this.client.chat.completions.create({
                messages: [
                    { role: "system", content: "You are a helpful software engineering assistant." },
                    { role: "user", content: prompt }
                ],
                model: this.deployment,
            });
            return response.choices[0].message.content.trim();
        } catch (e) {
            console.error('[LLMService] summarizeRepo failed:', e);
            return "Failed to generate summary.";
        }
    }

    /**
     * Plans a fix strategy based on the Jira ticket and Repo Summary.
     * @param {object} ticketData - Jira ticket fields (summary, description)
     * @param {string} repoSummary - The repo summary
     * @returns {Promise<string>}
     */
    async planFix(ticketData, repoSummary) {
        if (!this.client) return "LLM not initialized.";

        const prompt = `You are an expert developer.
    Repo Context: ${repoSummary}
    
    Ticket Request:
    Title: ${ticketData.summary}
    Description: ${ticketData.description}

    Task:
    Provide a high-level "Fix Strategy" paragraph (3-5 sentences) describing how to address this request in the codebase. 
    Explain WHAT needs to be done (e.g., "Create a new workflow file...", "Modify server.js to...", "Add a new route...").
    Do not write code yet, just the plan.
    `;

        try {
            const response = await this.client.chat.completions.create({
                messages: [
                    { role: "system", content: "You are an agentic coding assistant." },
                    { role: "user", content: prompt }
                ],
                model: this.deployment,
            });
            return response.choices[0].message.content.trim();
        } catch (e) {
            console.error('[LLMService] planFix failed:', e);
            return "Failed to generate fix strategy.";
        }
    }

    /**
     * Generates a detailed DevOps Audit Report for a Jira Ticket.
     * @param {string} repoName
     * @param {string} readme
     * @param {Array} findings
     * @param {Array} branches
     * @returns {Promise<string>}
     */
    async analyzeInspectionResults(repoName, readme, findings, branches = []) {
        if (!this.client) return null;

        const branchNames = branches.map(b => b.name).join(", ");
        const defaultBranch = branches.find(b => b.name === 'main' || b.name === 'master')?.name || 'unknown';

        const prompt = `You are a Senior DevOps Engineer performing a security and health audit on the repository '${repoName}'.
    
    Context:
    - Branches: [${branchNames}]. Default appears to be: '${defaultBranch}'.
    - README Excerpt:
    ${readme ? readme.substring(0, 1000) : "No README found."}

    Automated Tool Findings:
    ${JSON.stringify(findings, null, 2)}

    Task:
    Generate a professional, markdown-formatted Jira Ticket Description.
    
    Structure the report as follows:
    # DevOps Audit Report: ${repoName}
    
    ## 1. Executive Summary
    (2-3 sentences summarizing the overall health and readiness of the repo).

    ## 2. Branching Strategy Review
    - Analyze the branch list: [${branchNames}]
    - Identify if the repo follows standard conventions (main/master/dev) or if it has stale/weird branches.
    - Mention the default branch.

    ## 3. Critical Findings
    (List the most severe issues from the 'Automated Tool Findings' above. Explain WHY they are risky).
    
    ## 4. Remediation Plan
    (Step-by-step actionable list for the engineer who picks up this ticket).

    ## 5. Risk Assessment
    (What happens if we do nothing? e.g. Security vulnerabilities, deployment failures).

    Keep it professional, concise, and structured.
    `;

        try {
            const response = await this.client.chat.completions.create({
                messages: [
                    { role: "system", content: "You are a helpful software engineering assistant." },
                    { role: "user", content: prompt }
                ],
                model: this.deployment,
            });
            return response.choices[0].message.content.trim();
        } catch (e) {
            console.error('[LLMService] analyzeInspectionResults failed:', e);
            return null;
        }
    }

    /**
     * Customizes the workflow generation prompt.
     * @param {string} fixStrategy - The plan
     * @param {string} language - Repo language
     * @param {object} repoContext - Extra context (build commands, etc.)
     * @param {string[]} availableSecrets - List of secret names
     * @returns {Promise<string>} - The YAML content
     */
    async generateDraftWorkflow(fixStrategy, language, repoContext, availableSecrets = []) {
        if (!this.client) return null;

        const secretsList = availableSecrets.length > 0 ? availableSecrets.join(", ") : "None";

        const prompt = `Generate a GitHub Actions Workflow YAML file.
    
    Language: ${language}
    Context: ${JSON.stringify(repoContext)}
    
    Strategy: ${fixStrategy}
    
    Available Secrets (Use these exact names if needed): [${secretsList}]
    
    Requirements:
    - Valid YAML.
    - Standard checkout, setup, build, test steps.
    - If deployment is implied by the strategy and secrets are available (e.g. AZURE_*, ACR_*), include it.
    - Return ONLY the YAML code block.
    `;

        try {
            const response = await this.client.chat.completions.create({
                messages: [
                    { role: "system", content: "You are a DevOps expert. Output only valid YAML." },
                    { role: "user", content: prompt }
                ],
                model: this.deployment,
            });

            let content = response.choices[0].message.content.trim();
            // Strip markdown code blocks if present
            content = content.replace(/^```yaml\s*/, '').replace(/^```/, '').replace(/```$/, '');
            return content;
        } catch (e) {
            console.error('[LLMService] generateDraftWorkflow failed:', e);
            return null;
        }
    }

    /**
     * Executes an agentic task using full tool access.
     * @param {string} userPrompt - The goal (e.g., "Check PR status for PROJ-123")
     * @param {object} context - Additional context (ticket details, etc)
     * @returns {Promise<string>} - The final explanation
     */
    async executeAgenticTask(userPrompt, context = {}) {
        if (!this.client) return "LLM not initialized.";

        // Convert shared tools to OpenAI format
        const openAiTools = tools.map(t => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: zodToJsonSchema(t.schema)
            }
        }));

        const messages = [
            {
                role: "system",
                content: `You are an autonomous DevOps agent. You have access to tools to interact with GitHub and Jira.
                Context: ${JSON.stringify(context)}
                Use tools to gather info or perform actions.
                If you need to verify something, use a tool.
                When done, provide a summary.`
            },
            { role: "user", content: userPrompt }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;

        while (loopCount < MAX_LOOPS) {
            loopCount++;
            try {
                const response = await this.client.chat.completions.create({
                    messages: messages,
                    model: this.deployment,
                    tools: openAiTools,
                    tool_choice: "auto"
                });

                const message = response.choices[0].message;
                messages.push(message); // Add assistant's response to history

                // Check for tool calls
                if (message.tool_calls && message.tool_calls.length > 0) {
                    console.log(`[LLM Agent] Executing ${message.tool_calls.length} tool(s)...`);

                    for (const toolCall of message.tool_calls) {
                        const fnName = toolCall.function.name;
                        const fnArgs = JSON.parse(toolCall.function.arguments);

                        console.log(`[LLM Agent] Calling ${fnName} with`, fnArgs);

                        // Find matching tool handler
                        const toolDef = tools.find(t => t.name === fnName);
                        let result;

                        if (toolDef) {
                            try {
                                result = await toolDef.handler(fnArgs);
                            } catch (err) {
                                result = { isError: true, content: [{ type: 'text', text: err.message }] };
                            }
                        } else {
                            result = { isError: true, content: [{ type: 'text', text: `Tool ${fnName} not found` }] };
                        }

                        // Add tool result to history
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(result)
                        });
                    }
                } else {
                    // No more tool calls, return final text
                    return message.content;
                }

            } catch (e) {
                console.error('[LLM Agent] Execution failed:', e);
                return `Agent execution failed: ${e.message}`;
            }
        }

        return "Agent stopped after maximum steps.";
    }
}

module.exports = new LLMService();
