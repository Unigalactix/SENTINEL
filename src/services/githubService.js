const { Octokit } = require('@octokit/rest');
require('dotenv').config();

// Try to load GitHub App auth (optional - falls back to PAT if unavailable)
let createAppAuth = null;
try {
    createAppAuth = require('@octokit/auth-app').createAppAuth;
} catch (e) {
    // GitHub App auth not available
}

/**
 * Per-user token store (maps session ID to access token)
 * In production, use Redis or database
 */
const userTokenStore = new Map();

/**
 * Store a user's access token
 */
function setUserToken(sessionId, accessToken) {
    userTokenStore.set(sessionId, accessToken);
}

/**
 * Get a user's access token
 */
function getUserToken(sessionId) {
    return userTokenStore.get(sessionId);
}

/**
 * Clear a user's token on logout
 */
function clearUserToken(sessionId) {
    userTokenStore.delete(sessionId);
}

/**
 * Creates an Octokit instance for the given authentication context.
 * Priority:
 * 1. User's OAuth token (per-user auth)
 * 2. GitHub App credentials (fallback for server-side operations)
 * 3. Personal Access Token (legacy fallback)
 * 
 * @param {string} [userToken] - OAuth access token from user session
 * @returns {Octokit} Configured Octokit instance
 */
function getOctokit(userToken) {
    // Priority 1: Use user's OAuth token if provided
    if (userToken) {
        return new Octokit({ auth: userToken });
    }

    // Priority 2: Use GitHub App if configured
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;
    let installationId = process.env.GITHUB_INSTALLATION_ID;

    if (installationId && installationId.includes('/')) {
        const match = installationId.match(/\/(\d+)$/);
        if (match) installationId = match[1];
    }

    if (appId && privateKey && installationId && createAppAuth) {
        return new Octokit({
            authStrategy: createAppAuth,
            auth: { appId, privateKey, installationId }
        });
    }

    // Priority 3: Use PAT if configured
    if (process.env.GHUB_TOKEN) {
        return new Octokit({ auth: process.env.GHUB_TOKEN });
    }

    // No authentication - limited API access
    console.warn('[GitHub] No authentication configured!');
    return new Octokit();
}

// For backward compatibility, create a default client for server boot
// This is only used for initial status checks, not per-user operations
let defaultOctokit = null;
function getDefaultOctokit() {
    if (!defaultOctokit) {
        defaultOctokit = getOctokit();
    }
    return defaultOctokit;
}

// Log which auth methods are available
const hasAppAuth = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY);
const hasOAuth = !!(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET);
console.log(`[GitHub] Auth methods available: OAuth=${hasOAuth}, GitHubApp=${hasAppAuth}`);
if (hasOAuth) {
    console.log('[GitHub] Per-user OAuth authentication enabled');
}

// Module-level active token - set by server when user logs in
let activeToken = null;

/**
 * Set the active OAuth token for all GitHub operations.
 * Called by server.js when user logs in.
 */
function setActiveToken(token) {
    activeToken = token;
    if (token) {
        console.log('[GitHub] Active user token set - all operations will use OAuth');
    } else {
        console.log('[GitHub] Active user token cleared');
    }
}

/**
 * Get the current active token (for inspection/debugging)
 */
function getActiveToken() {
    return activeToken;
}

// Dynamic getter for octokit that uses active token
// This allows all existing functions to automatically use the logged-in user's token
function getClient() {
    return getOctokit(activeToken);
}

// For functions that use the module-level octokit directly,
// we create a proxy that always uses the current active token
const octokit = new Proxy({}, {
    get(target, prop) {
        const client = getClient();
        return client[prop];
    }
});

/**
 * Generates a default Dockerfile content based on language.
 */
function generateDockerfile(language, opts = {}) {
    if (language === 'node') {
        return `FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]`;
    }
    if (language === 'python') {
        return `FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "app.py"]`;
    }
    if (language === 'dotnet') {
        return `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "App.dll"]`;
    }
    if (language === 'java') {
        const useWrapper = opts.hasMavenWrapper ? './mvnw' : 'mvn';
        return `FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app
COPY . .
RUN ${useWrapper} clean package -DskipTests

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]`;
    }
    return `# No default Dockerfile for ${language}`;
}

/**
 * Generates a GitHub Actions YAML string based on service details.
 * @param {object} config - The configuration object.
 * @param {string} config.language - 'node' | 'python' | 'dotnet'
 * @param {string} config.repoName - The repository name
 * @param {string} config.buildCommand - The build command
 * @param {string} config.testCommand - The test command
 * @param {string} [config.deployTarget] - 'azure-webapp' | 'docker'
 * @param {string} [config.defaultBranch] - Default branch name (e.g. 'main', 'master')
 * @returns {string} The generated YAML content.
 */
function generateWorkflowFile({ language, repoName, buildCommand, testCommand, deployTarget, defaultBranch = 'main' }) {

    // Safe defaults to avoid invalid YAML when commands are missing
    buildCommand = buildCommand || 'npm run build';
    testCommand = testCommand || 'npm test';

    // Language-specific setup steps
    const languageSteps = {
        'node': `            - name: Setup Node.js
                uses: actions/setup-node@v4
                with:
                    node-version: '20'
                    cache: 'npm'
            - name: Install dependencies
                run: npm ci
            - name: Running NPM Audit
                shell: bash
                run: |
                    if [ -f "package-lock.json" ]; then
                        echo "Using npm for dependency checks"
                        npm audit --production --json || true
                    fi`,

        'python': `            - name: Set up Python
                            uses: actions/setup-python@v4
                            with:
                                python-version: '3.10'
                        - name: Install dependencies
                            run: pip install -r requirements.txt`,

        'dotnet': `            - name: Set up .NET
                            uses: actions/setup-dotnet@v4
                            with:
                                dotnet-version: '8.0.x'
                        - name: Restore dependencies
                            run: dotnet restore`,

        'java': `            - name: Set up JDK 17
                            uses: actions/setup-java@v4
                            with:
                                java-version: '17'
                                distribution: 'temurin'
                                cache: maven
                        - name: Build with Maven
                            run: ./mvnw clean package`
    };

    // Default to node if language not found
    const setupSteps = languageSteps[language] || languageSteps['node'];

    // --- Security Job (CodeQL) ---
    const codeqlMap = {
        'node': 'javascript',
        'python': 'python',
        'dotnet': 'csharp',
        'java': 'java'
    };
    const codeqlLang = codeqlMap[language] || 'javascript';

    const securityJob = `  # -------------------------------------------------
    # JOB 2: SECURITY SCANS
    security-scan:
        runs-on: ubuntu-latest
        needs: build
        permissions:
            security-events: write
            actions: read
            contents: read
        steps:
            - uses: actions/checkout@v4
            - name: Initialize CodeQL
                uses: github/codeql-action/init@v3
                with:
                    languages: \${{ env.CODEQL_LANGUAGE }}
            - name: Autobuild
                uses: github/codeql-action/autobuild@v3
            - name: Perform CodeQL Analysis
                uses: github/codeql-action/analyze@v3`;



    // --- Docker Build Job (Container Ready) ---
    let dockerJob = '';
    if (deployTarget === 'docker') {
        dockerJob = `  # -------------------------------------------------
    # JOB 3: DOCKER BUILD & PUSH
    docker-build:
        runs-on: ubuntu-latest
        needs: [build, security-scan]
        permissions:
            contents: read
        env:
            ACR_LOGIN_SERVER: \${{ secrets.ACR_LOGIN_SERVER }}
            ACR_USERNAME: \${{ secrets.ACR_USERNAME }}
            ACR_PASSWORD: \${{ secrets.ACR_PASSWORD }}
        steps:
            - uses: actions/checkout@v4
            - name: Compute lowercase repo name
                run: echo "REPO_LOWER=\$(echo '\${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV
            - name: Log in to Azure Container Registry
                if: env.ACR_LOGIN_SERVER != ''
                uses: docker/login-action@v3
                with:
                    registry: \${{ env.ACR_LOGIN_SERVER }}
                    username: \${{ env.ACR_USERNAME }}
                    password: \${{ env.ACR_PASSWORD }}
            - name: Build and push
                if: env.ACR_LOGIN_SERVER != ''
                uses: docker/build-push-action@v5
                with:
                    context: .
                    push: true
                    tags: |
                        \${{ env.ACR_LOGIN_SERVER }}/\${{ env.REPO_LOWER }}:latest
                        \${{ env.ACR_LOGIN_SERVER }}/\${{ env.REPO_LOWER }}:\${{ github.sha }}`;
    }

    // --- Azure Deployment Job (code-based deploy) ---
    let deployJob = '';
    if (deployTarget === 'azure-webapp') {
        deployJob = `  # -------------------------------------------------
    # JOB 4: DEPLOYMENT
    deploy:
        runs-on: ubuntu-latest
        needs: [build, security-scan]
        environment: 'Production'
        env:
            AZURE_WEBAPP_PUBLISH_PROFILE: \${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
            AZURE_WEBAPP_APP_NAME: \${{ secrets.AZURE_WEBAPP_APP_NAME }}
            AZURE_WEBAPP_SLOT_NAME: \${{ secrets.AZURE_WEBAPP_SLOT_NAME }}
        steps:
            - uses: actions/checkout@v4
            - name: Setup Node.js
                uses: actions/setup-node@v4
                with:
                    node-version: 20
            - name: Deploy to Azure Web App
                if: env.AZURE_WEBAPP_PUBLISH_PROFILE != ''
                uses: azure/webapps-deploy@v2
                with:
                    app-name: \${{ env.AZURE_WEBAPP_APP_NAME }}
                    publish-profile: \${{ env.AZURE_WEBAPP_PUBLISH_PROFILE }}
                    package: .
                    slot-name: \${{ env.AZURE_WEBAPP_SLOT_NAME }}`;
    }

    const yamlContent = `name: CI Pipeline - ${repoName}
on:
    workflow_dispatch:
    push:
        branches: ["${defaultBranch}"]
    pull_request:
        branches: ["${defaultBranch}"]
env:
    CI: true
    BUILD_COMMAND: ${buildCommand}
    TEST_COMMAND: ${testCommand}
    CODEQL_LANGUAGE: ${codeqlLang}
jobs:
    # JOB 1: BUILD & TEST
    build:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
${setupSteps}
            - name: Build
                run: \${{ env.BUILD_COMMAND }}
            - name: Test
                run: \${{ env.TEST_COMMAND }}
            - name: Upload build logs
                if: always()
                uses: actions/upload-artifact@v4
                with:
                    name: build-logs
                    path: npm-debug.log*
                    retention-days: 7
                    if-no-files-found: ignore

${securityJob}

${dockerJob}

${deployJob}
`;

    return yamlContent.trim();
}

// --- Helper Functions ---

/**
 * Ensures a feature branch exists, based on the default branch.
 */
async function ensureFeatureBranch({ owner, repo, defaultBranch, featureBranch, userToken }) {
    const client = getOctokit(userToken);
    console.log(`Ensuring branch ${featureBranch} exists...`);

    // 1. Get default branch ref
    const { data: baseRef } = await client.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
    });

    // 2. Try to get feature branch
    try {
        await client.git.getRef({
            owner,
            repo,
            ref: `heads/${featureBranch}`,
        });
        console.log(`Branch ${featureBranch} already exists.`);
        return;
    } catch (err) {
        if (err.status !== 404) throw err;
    }

    // 3. Create feature branch from default branch tip
    await client.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${featureBranch}`,
        sha: baseRef.object.sha,
    });
    console.log(`Created branch ${featureBranch}.`);
}

/**
 * Creates or Updates a file on a specific branch.
 * safe for re-runs.
 */
async function upsertWorkflowFileOnBranch({ owner, repo, branch, message, contentBase64, filePath, userToken }) {
    const client = getOctokit(userToken);
    console.log(`Upserting file ${filePath} on branch ${branch}...`);
    let sha;

    // 1. Check if file exists to get SHA (for update)
    try {
        const { data } = await client.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref: branch,
        });

        if (!Array.isArray(data)) {
            sha = data.sha;
        }
    } catch (err) {
        if (err.status !== 404) throw err;
    }

    // 2. Create or update
    const body = {
        owner,
        repo,
        path: filePath,
        message,
        content: contentBase64,
        branch,
    };

    if (sha) {
        body.sha = sha;
    }

    await client.repos.createOrUpdateFileContents(body);
    console.log(`File upserted successfully.`);
}

/**
 * Opens a Pull Request from feature -> default.
 * SAFELY checks if it exists first.
 */
async function createWorkflowPR({ owner, repo, featureBranch, defaultBranch, title, body, userToken }) {
    const client = getOctokit(userToken);
    console.log(`Checking for existing Pull Request...`);

    // 1. Check if PR already exists
    const { data: openPRs } = await client.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${featureBranch}`,
        base: defaultBranch,
    });

    if (openPRs.length > 0) {
        console.log('PR already exists.');
        return { pr: openPRs[0], isNew: false };
    }

    // 2. Create new PR
    console.log(`Creating new Pull Request...`);
    const { data: pr } = await client.pulls.create({
        owner,
        repo,
        head: featureBranch,
        base: defaultBranch,
        title,
        body,
    });
    console.log('PR created: ' + pr.html_url);
    return { pr, isNew: true };
}

/**
 * Generates the Copilot Prompt (Comment Body).
 * Uses context-aware prompts with secret placeholders instead of hardcoded YAML.
 */
function generateCopilotPrompt({ issueKey, summary, description, repoConfig, repoName, defaultBranch, language, fixStrategy, hasExistingWorkflow, availableSecrets }) {
    // Build secret placeholder list (never expose actual values)
    const secretPlaceholders = availableSecrets?.length
        ? availableSecrets.map(s => `\${{ secrets.${s} }}`).join(', ')
        : 'None configured';

    // Build command context
    const buildCommand = repoConfig?.buildCommand || 'npm run build';
    const testCommand = repoConfig?.testCommand || 'npm test';

    // Conditional workflow guidance
    const workflowGuidance = hasExistingWorkflow
        ? `> **Note:** This repository already has a CI/CD workflow. Review and enhance it if the task requires.`
        : `> **Action Required:** Create a new CI/CD workflow file at \`.github/workflows/ci.yml\` if needed for this task.`;

    return `@copilot /fix **${issueKey}: ${summary}**

${description || ''}

---

## 🤖 AI Analysis
${fixStrategy || 'Analyze the repository and implement the requirements above.'}

---

## Repository Context
| Property | Value |
|----------|-------|
| **Repo** | ${repoName} |
| **Language** | ${language} |
| **Default Branch** | ${defaultBranch} |
| **Build Command** | \`${buildCommand}\` |
| **Test Command** | \`${testCommand}\` |
| **Available Secrets** | ${secretPlaceholders} |

${workflowGuidance}

## Guidelines
1. **Read the entire repository first** before making changes
2. **Use secret placeholders** like \`\${{ secrets.SECRET_NAME }}\` - never hardcode values
3. **Only create/modify workflows if needed** for this specific task
4. **Follow ${language} best practices** for code quality
`;
}

/**
 * Orchestrates the PR Workflow.
 */
async function createPullRequestForWorkflow({ repoName, filePath, content, language, issueKey, deployTarget, defaultBranch, repoConfig, ticketData, aiAnalysis }) {
    try {
        const [owner, repo] = repoName.split('/');

        // 1. Get Repo Default Branch (if not provided)
        if (!defaultBranch) {
            const { data: repoData } = await octokit.repos.get({ owner, repo });
            defaultBranch = repoData.default_branch;
        }
        console.log(`Detected default branch: ${defaultBranch}`);

        // 2. Define Feature Branch Name
        // Stable name based on Ticket Key so we don't create duplicates
        const featureBranch = `chore/${issueKey}-workflow-setup`;
        console.log(`Using feature branch: ${featureBranch}`);

        // 3. Ensure Branch Exists
        await ensureFeatureBranch({ owner, repo, defaultBranch, featureBranch });

        // 3a. Handle Dockerfile for Docker Deployment OR Azure Web App (Container Ready)
        if (deployTarget === 'docker' || deployTarget === 'azure-webapp') {
            const dockerfilePath = 'Dockerfile';
            try {
                // Check if it exists on the feature branch (or default if brand new branch copy)
                // We check feature branch because we might have just created it.
                await octokit.repos.getContent({ owner, repo, path: dockerfilePath, ref: featureBranch });
                console.log('Dockerfile already exists.');
            } catch (err) {
                if (err.status === 404) {
                    console.log('Dockerfile missing, creating one...');
                    let hasMavenWrapper = false;
                    if (language === 'java') {
                        try {
                            hasMavenWrapper = await fileExists(owner, repo, 'mvnw');
                        } catch (_) { /* noop */ }
                    }
                    const dockerContent = generateDockerfile(language, { hasMavenWrapper });
                    await upsertWorkflowFileOnBranch({
                        owner,
                        repo,
                        branch: featureBranch,
                        message: `feat: Add Dockerfile for ${language}`,
                        contentBase64: Buffer.from(dockerContent).toString('base64'),
                        filePath: dockerfilePath
                    });
                } else {
                    throw err;
                }
            }
        }

        // 4. Upsert Workflow File (conditionally if none exists)
        let skipWorkflowUpsert = false;
        let existingWorkflowFile = null;
        try {
            const existing = await hasExistingWorkflow(repoName, language);
            if (existing && existing.exists) {
                skipWorkflowUpsert = true;
                existingWorkflowFile = existing.workflowFile;
                console.log(`Existing workflow detected: ${existingWorkflowFile}. Skipping new workflow file.`);
            }
        } catch (e) {
            console.warn(`Workflow check failed: ${e.message}. Proceeding to upsert new workflow file.`);
        }

        if (!skipWorkflowUpsert) {
            await upsertWorkflowFileOnBranch({
                owner,
                repo,
                branch: featureBranch,
                message: `feat: Add ${language} CI workflow`,
                contentBase64: Buffer.from(content).toString('base64'),
                filePath
            });
        } else {
            // Ensure at least one commit exists on the feature branch to allow PR creation
            const markerPath = `.github/automation/${issueKey}.json`;
            const markerContent = JSON.stringify({ issueKey, timestamp: new Date().toISOString(), note: 'Automation marker to enable PR without altering existing workflow.' }, null, 2);
            await upsertWorkflowFileOnBranch({
                owner,
                repo,
                branch: featureBranch,
                message: `chore: add automation marker for ${issueKey}`,
                contentBase64: Buffer.from(markerContent).toString('base64'),
                filePath: markerPath
            });
        }




        // 6. Create PR
        const aiSection = aiAnalysis?.fixStrategy
            ? `\n\n## 🤖 AI Analysis\n\n**Jira Ticket:** ${issueKey}\n\n**Fix Strategy:**\n${aiAnalysis.fixStrategy}\n\n**Repository Context:**\n${aiAnalysis.repoSummary || 'N/A'}\n\n**Secrets Available:** ${aiAnalysis.availableSecrets?.length ? aiAnalysis.availableSecrets.join(', ') : 'None detected'}`
            : '';

        const { pr, isNew } = await createWorkflowPR({
            owner,
            repo,
            featureBranch,
            defaultBranch,
            title: `${issueKey}: Enable CI/CD for ${language}`,
            body: `This PR was automatically generated by Sentinel for Jira Ticket **${issueKey}**.${aiSection}\n\n✅ **Analysis Complete**: Detailed requirements posted below for @copilot.${deployTarget === 'docker' ? '\n\n📦 Also added Dockerfile for containerization.' : ''}`
        });

        // 6a. If we skipped adding a new workflow, attempt to trigger existing workflow on feature branch
        if (skipWorkflowUpsert && existingWorkflowFile) {
            try {
                console.log(`Triggering existing workflow ${existingWorkflowFile} on ref ${featureBranch}...`);
                await triggerExistingWorkflow({ repoName, workflowFile: existingWorkflowFile, ref: featureBranch });
            } catch (e) {
                console.warn(`Failed to trigger existing workflow: ${e.message}`);
            }
        }

        // 7. [NEW] Copilot Prompt Automation (Direct Comment)
        if (ticketData) {
            console.log('Generating Copilot Prompt for PR Comment...');
            const promptBody = generateCopilotPrompt({
                issueKey,
                summary: ticketData.summary,
                description: ticketData.description,
                repoConfig,
                repoName,
                defaultBranch,
                language,
                fixStrategy: aiAnalysis?.fixStrategy,
                hasExistingWorkflow: skipWorkflowUpsert,  // From line 481
                availableSecrets: aiAnalysis?.availableSecrets  // Secret names as placeholders
            });

            await octokit.issues.createComment({
                owner,
                repo,
                issue_number: pr.number,
                body: promptBody
            });
            console.log('Copilot Prompt posted to PR #' + pr.number);
        }

        return { prUrl: pr.html_url, prNumber: pr.number, headSha: pr.head.sha, branch: featureBranch, isNew };

    } catch (error) {
        console.error('Workflow Automation Failed:', error);
        throw error;
    }
}

/**
 * Gets the latest check runs for a specific ref (branch/sha).
 */
async function getPullRequestChecks({ repoName, ref }) {
    try {
        const [owner, repo] = repoName.split('/');
        const { data } = await octokit.checks.listForRef({
            owner,
            repo,
            ref
        });
        return data.check_runs.map(run => ({
            name: run.name,
            status: run.status,
            conclusion: run.conclusion, // success, failure, neutral, cancelled, skipped, timed_out, action_required
            url: run.html_url
        }));
    } catch (error) {
        console.error('Failed to get checks:', error.message);
        return [];
    }
}

/**
 * Detects the primary language of the repo based on file structure.
 * Returns: 'node' | 'python' | 'dotnet'
 */
async function detectRepoLanguage(repoName) {
    console.log(`Detecting language for ${repoName}...`);
    try {
        const [owner, repo] = repoName.split('/');
        const { data: files } = await octokit.repos.getContent({
            owner,
            repo,
            path: ''
        });

        if (!Array.isArray(files)) return 'node'; // Should be array for root dir

        const fileNames = files.map(f => f.name);

        if (fileNames.some(f => f.endsWith('.csproj') || f.endsWith('.sln'))) {
            console.log('Detected .NET project.');
            return 'dotnet';
        }
        if (fileNames.includes('package.json')) {
            console.log('Detected Node.js project.');
            return 'node';
        }
        if (fileNames.includes('requirements.txt') || fileNames.includes('setup.py') || fileNames.includes('Pipfile')) {
            console.log('Detected Python project.');
            return 'python';
        }
        if (fileNames.includes('pom.xml') || fileNames.includes('build.gradle') || fileNames.includes('build.gradle.kts')) {
            console.log('Detected Java project.');
            return 'java';
        }

        console.log('No specific marker found, defaulting to node.');
        return 'node';

    } catch (error) {
        console.error(`Language detection failed for ${repoName}: ${error.message}`);
        return 'node'; // Safe default
    }
}

/**
 * Fetches and parses repository instructions to tailor build commands.
 * Priority: .github/instructions.md -> .github/agents.md -> README.md
 */
async function getRepoInstructions(repoName) {
    console.log(`Analyzing repository ${repoName} for instructions...`);
    const [owner, repo] = repoName.split('/');

    const possibleFiles = ['.github/instructions.md', '.github/agents.md', 'README.md'];

    for (const path of possibleFiles) {
        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path
            });

            // Content is base64 encoded
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            console.log(`Found instructions in: ${path}`);

            // Simple parsing logic (Case insensitive)
            // Looks for "Build Command: `npm run build`" or "Test Command: 'npm test'"
            const buildMatch = content.match(/Build Command:\s*(`[^`]+`|"[^"]+"|'[^']+'|[^\n]+)/i);
            const testMatch = content.match(/Test Command:\s*(`[^`]+`|"[^"]+"|'[^']+'|[^\n]+)/i);

            const result = {};

            if (buildMatch) {
                // Remove backticks or quotes if present
                result.buildCommand = buildMatch[1].replace(/[`"']/g, '').trim();
                console.log(`Discovered Build Command: ${result.buildCommand}`);
            }
            if (testMatch) {
                result.testCommand = testMatch[1].replace(/[`"']/g, '').trim();
                console.log(`Discovered Test Command: ${result.testCommand}`);
            }

            if (result.buildCommand || result.testCommand) {
                return result;
            }

        } catch (error) {
            // File not found, continue
        }
    }

    return {};
}

/**
 * Deep scan of repo configuration to infer build/test commands.
 * Reads package.json, pom.xml, .sln, requirements.txt, etc.
 */
async function analyzeRepoStructure(repoName) {
    console.log(`Deep analyzing repository structure for ${repoName}...`);
    const [owner, repo] = repoName.split('/');
    const result = {};

    try {
        const { data: files } = await octokit.repos.getContent({ owner, repo, path: '' });
        const fileNames = files.map(f => f.name);

        // --- Node.js (package.json) ---
        if (fileNames.includes('package.json')) {
            try {
                const { data } = await octokit.repos.getContent({ owner, repo, path: 'package.json' });
                const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));

                if (content.scripts) {
                    if (content.scripts.build) result.buildCommand = 'npm run build';
                    else if (content.scripts.compile) result.buildCommand = 'npm run compile';

                    if (content.scripts.test) result.testCommand = 'npm test';
                    if (content.scripts.start) result.runCommand = 'npm start';
                }
                console.log('Analyzed package.json:', result);
            } catch (e) {
                console.error('Failed to parse package.json', e);
            }
        }

        // --- Java (Maven/Gradle) ---
        if (fileNames.includes('pom.xml')) {
            // Check for wrapper
            const hasWrapper = await fileExists(owner, repo, 'mvnw');
            result.buildCommand = hasWrapper ? './mvnw clean package' : 'mvn clean package';
            result.testCommand = hasWrapper ? './mvnw test' : 'mvn test';
            // Heuristic for Spring Boot run
            result.runCommand = hasWrapper ? './mvnw spring-boot:run' : 'mvn spring-boot:run';
            console.log('Analyzed pom.xml (Maven):', result);
        }
        else if (fileNames.includes('build.gradle') || fileNames.includes('build.gradle.kts')) {
            const hasWrapper = await fileExists(owner, repo, 'gradlew');
            result.buildCommand = hasWrapper ? './gradlew build' : 'gradle build';
            result.testCommand = hasWrapper ? './gradlew test' : 'gradle test';
            result.runCommand = hasWrapper ? './gradlew bootRun' : 'gradle bootRun';
            console.log('Analyzed build.gradle:', result);
        }

        // --- .NET (.sln / .csproj) ---
        const slnFile = fileNames.find(f => f.endsWith('.sln'));
        const csprojFile = fileNames.find(f => f.endsWith('.csproj'));

        if (slnFile) {
            result.buildCommand = `dotnet build ${slnFile}`;
            result.testCommand = 'dotnet test';
            result.runCommand = 'dotnet run';
            console.log(`Analyzed .sln (${slnFile}):`, result);
        }
        else if (csprojFile) {
            result.buildCommand = `dotnet build ${csprojFile}`;
            result.testCommand = 'dotnet test';
            result.runCommand = 'dotnet run';
            console.log(`Analyzed .csproj (${csprojFile}):`, result);
        }

        // --- Python (requirements.txt / app.py) ---
        // We check for python files even if requirements.txt is missing to detect run command
        if (fileNames.includes('requirements.txt') || fileNames.some(f => f.endsWith('.py'))) {
            // Build/Test defaults
            if (fileNames.includes('requirements.txt')) {
                result.buildCommand = 'pip install -r requirements.txt';
            }
            result.testCommand = 'pytest';

            // Run Command Inference
            if (fileNames.includes('manage.py')) {
                result.runCommand = 'python manage.py runserver'; // Django
            } else if (fileNames.includes('app.py')) {
                result.runCommand = 'python app.py'; // Flask/Generic
            } else if (fileNames.includes('main.py')) {
                result.runCommand = 'python main.py'; // Generic
            }

            console.log('Analyzed Python structure:', result);
        }

        // --- Docker ---
        if (fileNames.includes('Dockerfile')) {
            result.dockerBuildCommand = 'docker build .';
            console.log('Detected Dockerfile. Added dockerBuildCommand.');
        }

    } catch (error) {
        console.error(`Deep analysis failed for ${repoName}: ${error.message}`);
    }

    return result;
}

// Helper to check file existence without fetching content
async function fileExists(owner, repo, path) {
    try {
        await octokit.repos.getContent({ owner, repo, path });
        return true;
    } catch (e) { return false; }
}

/**
 * Gets the default branch of the repo.
 */
async function getDefaultBranch(repoName) {
    console.log(`Getting default branch for ${repoName}...`);
    try {
        const [owner, repo] = repoName.split('/');
        const { data: repoData } = await octokit.repos.get({ owner, repo });
        return repoData.default_branch;
    } catch (error) {
        console.error(`Failed to get default branch for ${repoName}: ${error.message}`);
        return 'main'; // Safe default
    }
}

/**
 * Checks if a repo has an existing workflow in .github/workflows and returns a best-match file.
 */
async function hasExistingWorkflow(repoName, language) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: '.github/workflows' });
        if (!Array.isArray(data)) return { exists: false };
        const yamlFiles = data.filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')));
        if (yamlFiles.length === 0) return { exists: false };
        const preferred = yamlFiles.find(f => f.name.toLowerCase().includes('ci'))
            || (language ? yamlFiles.find(f => f.name.toLowerCase().includes(language)) : null)
            || yamlFiles[0];
        return { exists: true, workflowFile: preferred.name };
    } catch (e) {
        if (e.status === 404) return { exists: false };
        throw e;
    }
}

/**
 * Triggers an existing GitHub Actions workflow via workflow_dispatch.
 */
async function triggerExistingWorkflow({ repoName, workflowFile, ref, inputs }) {
    const [owner, repo] = repoName.split('/');
    await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflowFile,
        ref,
        inputs: inputs || {}
    });
}

/**
 * Attempts to detect a Copilot-generated sub PR linked from comments on the main PR.
 * Fallback: scan open PRs for likely Copilot PRs.
 */
async function findCopilotSubPR({ repoName, mainPrNumber }) {
    const [owner, repo] = repoName.split('/');
    try {
        // 0. Get Main PR to know its "Head" (Feature Branch)
        const { data: mainPr } = await octokit.pulls.get({ owner, repo, pull_number: mainPrNumber });
        const featureBranch = mainPr.head.ref;

        // 1. Scan PR comments for a PR URL (Explicit linking)
        const { data: comments } = await octokit.issues.listComments({ owner, repo, issue_number: mainPrNumber });
        const prUrlRegex = new RegExp(`https://github.com/${owner}/${repo}/pull/\\d+`, 'i');
        for (const c of comments) {
            const m = c.body && c.body.match(prUrlRegex);
            if (m) {
                const url = m[0];
                const num = parseInt(url.split('/').pop(), 10);
                const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: num });
                // Verify it targets our branch
                if (pr.base.ref === featureBranch) return pr;
            }
        }

        // 2. Robust Fallback: List open PRs targeting the Feature Branch
        const { data: openPRs } = await octokit.pulls.list({ owner, repo, state: 'open', base: featureBranch });

        // Return the most recent one if multiple (unlikely)
        if (openPRs.length > 0) {
            console.log(`Found ${openPRs.length} PRs targeting ${featureBranch}. Using #${openPRs[0].number}`);
            return openPRs[0];
        }

        // 3. Last Resort: Name/User match (if it targets something else? Unlikely useful)
        // Kept for backward compat if base logic fails
        const { data: allOpen } = await octokit.pulls.list({ owner, repo, state: 'open' });
        const likely = allOpen.find(p =>
            ((p.user && /copilot|github-actions/i.test(p.user.login || '')) ||
                /copilot|automation|suggest/i.test(p.title || '')) &&
            p.number !== mainPrNumber // Don't pick self
        );
        return likely || null;

    } catch (e) {
        console.warn('findCopilotSubPR failed:', e.message);
        return null;
    }
}

/**
 * Merge the head branch of a sub PR into a base branch (feature branch of the main PR).
 * Uses the GitHub merge endpoint to create a merge commit.
 */
async function mergeSubPRIntoBranch({ repoName, baseBranch, subPr }) {
    const [owner, repo] = repoName.split('/');
    try {
        const headBranch = subPr.head.ref;
        const commitMessage = `chore: merge Copilot PR #${subPr.number} (${headBranch}) into ${baseBranch}`;
        await octokit.repos.merge({ owner, repo, base: baseBranch, head: headBranch, commit_message: commitMessage });
        return { merged: true };
    } catch (e) {
        if (e.status === 409) {
            // Merge conflict
            return { merged: false, conflict: true, message: e.message };
        }
        console.warn('mergeSubPRIntoBranch failed:', e.message);
        return { merged: false, message: e.message };
    }
}

/**
 * Delete a branch from the repository.
 */
async function deleteBranch({ repoName, branchName }) {
    const [owner, repo] = repoName.split('/');
    try {
        await octokit.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
        return { deleted: true };
    } catch (e) {
        console.warn(`Failed to delete branch ${branchName}:`, e.message);
        return { deleted: false, error: e.message };
    }
}

/**
 * Marks a PR as Ready for Review (undraft).
 */
async function markPullRequestReadyForReview({ repoName, pullNumber }) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
        const nodeId = pr.node_id;
        const mutation = `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest { id isDraft }\n  }\n}`;
        const result = await octokit.graphql(mutation, { pullRequestId: nodeId });
        return { ok: true, result };
    } catch (e) {
        console.warn('markPullRequestReadyForReview failed:', e.message);
        return { ok: false, message: e.message };
    }
}

/**
 * Merges a Pull Request using the high-level API.
 */
async function mergePullRequest({ repoName, pullNumber, method = 'squash' }) {
    const [owner, repo] = repoName.split('/');
    try {
        await octokit.pulls.merge({
            owner,
            repo,
            pull_number: pullNumber,
            merge_method: method
        });
        return { merged: true };
    } catch (e) {
        return { merged: false, message: e.message };
    }
}

// Enable auto-merge for a PR via GraphQL
async function enablePullRequestAutoMerge({ repoName, pullNumber, mergeMethod = 'SQUASH' }) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
        const nodeId = pr.node_id;
        const mutation = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {\n  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {\n    pullRequest { id number state }\n  }\n}`;
        const result = await octokit.graphql(mutation, { pullRequestId: nodeId, mergeMethod });
        return { ok: true, result };
    } catch (e) {
        console.warn('enablePullRequestAutoMerge failed:', e.message);
        return { ok: false, message: e.message };
    }
}

// Check if a PR is merged
async function isPullRequestMerged({ repoName, pullNumber }) {
    const [owner, repo] = repoName.split('/');
    try {
        await octokit.pulls.checkIfMerged({ owner, repo, pull_number: pullNumber });
        return { merged: true };
    } catch (e) {
        // 404 if not merged
        return { merged: false };
    }
}

/**
 * Get details for a PR by number.
 */
async function getPullRequestDetails({ repoName, pull_number }) {
    const [owner, repo] = repoName.split('/');
    const { data } = await octokit.pulls.get({ owner, repo, pull_number });
    return data;
}

/**
 * Approves a sub-PR (e.g., Copilot-generated PR) that targets the main PR's feature branch.
 * This auto-approves the sub-PR so it can be merged into the feature branch.
 */
async function approvePullRequest({ repoName, pullNumber }) {
    const [owner, repo] = repoName.split('/');
    try {
        await octokit.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            event: 'APPROVE',
            body: '✅ Auto-approved by Sentinel.'
        });
        return { approved: true };
    } catch (e) {
        console.warn(`Failed to approve PR #${pullNumber}:`, e.message);
        return { approved: false, message: e.message };
    }
}

/**
 * Get the latest workflow run for a given ref (branch or SHA).
 */
async function getLatestWorkflowRunForRef({ repoName, ref }) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 20 });
        // Prefer exact ref match; fall back to most recent overall
        const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
        const onRef = runs.filter(r => (r.head_branch === ref || r.head_sha === ref));
        const latest = (onRef.length > 0 ? onRef : runs).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
        return latest;
    } catch (e) {
        console.warn('getLatestWorkflowRunForRef failed:', e.message);
        return null;
    }
}

/**
 * Get the latest deployment URL (environment_url) from GitHub Deployments for a given ref.
 */
async function getLatestDeploymentUrl({ repoName, ref }) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data: deployments } = await octokit.repos.listDeployments({ owner, repo, per_page: 20 });
        const filtered = deployments.filter(d => (d.ref === ref));
        const latest = (filtered.length ? filtered : deployments).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        if (!latest) return null;
        const { data: statuses } = await octokit.repos.listDeploymentStatuses({ owner, repo, deployment_id: latest.id });
        const latestStatus = statuses.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        return latestStatus && latestStatus.environment_url ? latestStatus.environment_url : null;
    } catch (e) {
        console.warn('getLatestDeploymentUrl failed:', e.message);
        return null;
    }
}

/**
 * List jobs for a workflow run.
 */
async function getJobsForRun({ repoName, runId }) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
        return Array.isArray(data.jobs) ? data.jobs : [];
    } catch (e) {
        console.warn('getJobsForRun failed:', e.message);
        return [];
    }
}

/**
 * Summarize a failure from a run and its jobs.
 */
function summarizeFailureFromRun({ run, jobs }) {
    const failedJobs = jobs.filter(j => j.conclusion === 'failure');
    const names = failedJobs.map(j => j.name).join(', ') || 'unknown';
    const runUrl = run && run.html_url ? run.html_url : null;
    const jobLinks = failedJobs.map(j => (j.html_url || runUrl)).filter(Boolean);
    const lines = [];
    lines.push(`Deployment failed. Failed job(s): ${names}.`);
    if (jobLinks.length) {
        lines.push('Logs:');
        jobLinks.forEach(l => lines.push(`- ${l}`));
    }
    // Simple hints
    lines.push('Common fixes:');
    lines.push('- Verify required secrets (AZURE_WEBAPP_* or ACR_*).');
    lines.push('- Fix build/test errors and rerun.');
    lines.push('- Ensure deploy job conditions are met and not skipped.');
    const azureFailed = failedJobs.some(j => {
        const name = j.name || '';
        const steps = Array.isArray(j.steps) ? j.steps : [];
        const stepHit = steps.some(s => /azure|webapp|deploy/i.test((s && s.name) || ''));
        return /azure|webapp|deploy/i.test(name) || stepHit;
    });
    if (azureFailed) {
        lines.push('Azure Web App hints:');
        lines.push('- Confirm AZURE_WEBAPP_PUBLISH_PROFILE secret contains valid XML from Azure portal.');
        lines.push('- Verify AZURE_WEBAPP_APP_NAME matches the exact Web App name.');
        lines.push('- If using slots, set AZURE_WEBAPP_SLOT_NAME correctly or omit for production.');
        lines.push('- Check that the workflow has permissions to use GITHUB_TOKEN and secrets.');
    }
    return lines.join('\n');
}

// --- Org-level PR discovery & Jira key mapping ---

// Extract a Jira key like ABC-123 from text
function extractJiraKeyFromText(text) {
    if (!text) return null;
    const match = String(text).match(/([A-Z][A-Z0-9]+-\d+)/);
    return match ? match[1] : null;
}

// List open PRs across an organization using the Search API
async function listOpenOrgPullRequests({ org, perPage = 50, page = 1 }) {
    const { data } = await octokit.search.issuesAndPullRequests({
        q: `org:${org} is:pr is:open`,
        per_page: perPage,
        page
    });
    return data.items.map(item => {
        const repoFullName = item.repository_url && item.repository_url.includes('/repos/')
            ? item.repository_url.split('/repos/')[1]
            : null;
        return {
            repoFullName,
            number: item.number,
            title: item.title,
            html_url: item.html_url
        };
    });
}

// Get full PR details (including head SHA and branch) for a repo PR number
async function getPullRequestDetailsByRepo({ repoFullName, number }) {
    const [owner, repo] = repoFullName.split('/');
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: number });
    return data;
}

// Get open org PRs with inferred Jira keys and head sha for reconciliation
async function getActiveOrgPRsWithJiraKeys({ org, maxPages = 4 }) {
    const results = [];
    for (let page = 1; page <= maxPages; page++) {
        const items = await listOpenOrgPullRequests({ org, page });
        if (!items.length) break;
        for (const item of items) {
            if (!item.repoFullName) continue;
            try {
                const pr = await getPullRequestDetailsByRepo({ repoFullName: item.repoFullName, number: item.number });
                const keyFromTitle = extractJiraKeyFromText(pr.title);
                const keyFromBody = extractJiraKeyFromText(pr.body);
                const keyFromBranch = extractJiraKeyFromText(pr.head && pr.head.ref);
                const jiraKey = keyFromTitle || keyFromBody || keyFromBranch;
                results.push({
                    repoName: item.repoFullName,
                    prNumber: pr.number,
                    prUrl: pr.html_url,
                    branch: pr.head && pr.head.ref,
                    headSha: pr.head && pr.head.sha,
                    jiraKey
                });
            } catch (e) {
                console.warn('Failed to fetch PR details for', item.repoFullName, item.number, e.message);
            }
        }
    }
    // Filter to those we could infer a Jira key for
    return results.filter(r => !!r.jiraKey);
}


/**
 * Gets branch protection rules. 
 * Returns null if no protection or 404.
 */
async function getBranchProtection(repoName, branch) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.repos.getBranchProtection({
            owner,
            repo,
            branch
        });
        return data;
    } catch (error) {
        // 404 means no protection usually
        if (error.status === 404) return null;
        // 403 might mean we don't have permission to view settings, assume unknown/null
        console.warn(`Failed to get branch protection for ${repoName}/${branch}:`, error.message);
        return null;
    }
}

/**
 * Lists releases for a repo.
 */
async function getReleases(repoName) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.repos.listReleases({
            owner,
            repo,
            per_page: 5
        });
        return data;
    } catch (error) {
        console.warn(`Failed to list releases for ${repoName}:`, error.message);
        return [];
    }
}

// NOTE: module.exports is defined at the end of the file

/**
 * Lists accessible repositories. 
 * If ALLOWED_ORGS is set, lists for that org. 
 * Otherwise lists for authenticated user.
 */
async function listAccessibleRepos() {
    try {
        const allowedOrgsStr = process.env.ALLOWED_ORGS;
        let repos = [];

        if (allowedOrgsStr) {
            const orgs = allowedOrgsStr.split(',').map(s => s.trim());
            for (const org of orgs) {
                try {
                    console.log(`[GitHub Service] Fetching repos for org: ${org}`);
                    const { data } = await octokit.repos.listForOrg({
                        org,
                        sort: 'updated',
                        direction: 'desc',
                        per_page: 100
                    });
                    repos = repos.concat(data);
                } catch (orgError) {
                    console.warn(`[GitHub Service] Failed to list repos for org '${org}': ${orgError.message}`);
                    // Continue to next org or fallback
                }
            }
        }

        // If we found nothing from orgs (or didn't try), try authenticated user
        if (repos.length === 0) {
            console.log('[GitHub Service] Fetching repositories for authenticated user...');
            try {
                const { data } = await octokit.repos.listForAuthenticatedUser({
                    sort: 'updated',
                    direction: 'desc',
                    per_page: 100,
                    visibility: 'all'
                });
                repos = data;
            } catch (userError) {
                console.error('[GitHub Service] Failed to list user repos:', userError.message);
            }
        }

        return repos.map(r => ({
            full_name: r.full_name,
            private: r.private,
            description: r.description
        }));
    } catch (error) {
        console.error('Failed to list repositories:', error.message);
        return [];
    }
}

/**
 * Verifies if the PAT can access the repo.
 */


/**
 * Lists files in the root directory of the repo.
 */
async function getRepoRootFiles(repoName) {
    return getRepoDirectoryFiles(repoName, '');
}

/**
 * Lists files in a specific directory.
 */
async function getRepoDirectoryFiles(repoName, path = '') {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        return Array.isArray(data) ? data.map(f => f.name) : [];
    } catch (error) {
        if (error.status === 404) return [];
        console.error(`Failed to get files for ${repoName}/${path}:`, error.message);
        return [];
    }
}

/**
 * Lists all workflows in the repository with their status.
 */
async function listRepoWorkflows(repoName) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.actions.listRepoWorkflows({
            owner,
            repo
        });
        return data.workflows || [];
    } catch (error) {
        console.error(`Failed to list workflows for ${repoName}:`, error.message);
        return [];
    }
}

/**
 * Fetches the content of a specific file. Returns null if not found.
 */
async function getRepoFileContent(repoName, path) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        if (data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
    } catch (error) {
        if (error.status === 404) return null;
        console.error(`Failed to get file content for ${repoName}/${path}:`, error.message);
        throw error;
    }
}

/**
 * Lists all secrets in the repository.
 */
async function listRepoSecrets(repoName) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.actions.listRepoSecrets({
            owner,
            repo
        });
        return data.secrets.map(s => s.name);
    } catch (error) {
        // If secrets listing fails (e.g. 403), return empty
        // console.error(`Failed to list secrets for ${repoName}:`, error.message);
        return [];
    }
}

/**
 * Lists all branches in the repository.
 * @param {string} repoName 
 * @returns {Promise<Array<{name: string, protected: boolean}>>}
 */
async function listBranches(repoName) {
    const [owner, repo] = repoName.split('/');
    try {
        const { data } = await octokit.repos.listBranches({
            owner,
            repo,
            per_page: 100 // Limit to 100 for now
        });
        return data.map(b => ({
            name: b.name,
            protected: b.protected
        }));
    } catch (error) {
        console.error(`Failed to list branches for ${repoName}:`, error.message);
        return [];
    }
}

/**
 * Check if the current user has push access to the repository
 * @param {string} repoName - The repository name (owner/repo)
 * @param {string} [token] - Optional token override
 * @returns {Promise<boolean>} - True if user has push access
 */
async function checkRepoAccess(repoName, token = null) {
    try {
        const client = token ? getOctokit(token) : getOctokit();
        const [owner, repo] = repoName.split('/');

        const { data } = await client.repos.get({
            owner,
            repo
        });

        // Check for push permission (collaborator or owner)
        return data.permissions && data.permissions.push === true;
    } catch (error) {
        console.warn(`[GitHub] Access check failed for ${repoName}: ${error.message}`);
        return false;
    }
}

module.exports = {
    // Auth functions for per-user tokens
    getOctokit,
    checkRepoAccess, // [NEW]
    setUserToken,
    getUserToken,
    clearUserToken,
    setActiveToken,
    getActiveToken,

    // Workflow generation
    generateWorkflowFile,
    createPullRequestForWorkflow,
    getPullRequestChecks,
    detectRepoLanguage,
    generateDockerfile,
    getRepoInstructions,
    analyzeRepoStructure,
    getDefaultBranch,
    findCopilotSubPR,
    mergeSubPRIntoBranch,
    getPullRequestDetails,
    hasExistingWorkflow,
    triggerExistingWorkflow,
    deleteBranch,
    markPullRequestReadyForReview,
    mergePullRequest,
    enablePullRequestAutoMerge,
    isPullRequestMerged,
    approvePullRequest,
    getLatestWorkflowRunForRef,
    getJobsForRun,
    summarizeFailureFromRun,
    getLatestDeploymentUrl,
    getActiveOrgPRsWithJiraKeys,
    getRepoRootFiles,
    getRepoFileContent,
    getRepoDirectoryFiles,
    listRepoSecrets,
    listAccessibleRepos,
    // checkRepoAccess, // Removed duplicate
    listRepoWorkflows,
    getReleases,
    getBranchProtection,
    listBranches
};

