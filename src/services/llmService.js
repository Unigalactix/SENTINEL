const { AzureOpenAI } = require("openai");
require("dotenv").config();

class LLMService {
    constructor() {
        this.client = null;
        this.deployment = process.env.LLM_DEPLOYEMENT_NAME // Using the env var exactly as found (typo included)
            ? process.env.LLM_DEPLOYEMENT_NAME.replace(/^"|"$/g, '')
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
}

module.exports = new LLMService();
