const { Octokit } = require('@octokit/rest');
require('dotenv').config();

// Initialize Octokit with the token from .env
const octokit = new Octokit({
    auth: process.env.GHUB_TOKEN
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
    # -------------------------------------------------
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
    # -------------------------------------------------
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
    # -------------------------------------------------
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
    # -------------------------------------------------
    # JOB 1: BUILD & TEST
    # -------------------------------------------------
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
async function ensureFeatureBranch({ owner, repo, defaultBranch, featureBranch }) {
    console.log(`Ensuring branch ${featureBranch} exists...`);

    // 1. Get default branch ref
    const { data: baseRef } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
    });

    // 2. Try to get feature branch
    try {
        await octokit.git.getRef({
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
    await octokit.git.createRef({
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
async function upsertWorkflowFileOnBranch({ owner, repo, branch, message, contentBase64, filePath }) {
    console.log(`Upserting file ${filePath} on branch ${branch}...`);
    let sha;

    // 1. Check if file exists to get SHA (for update)
    try {
        const { data } = await octokit.repos.getContent({
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

    await octokit.repos.createOrUpdateFileContents(body);
    console.log(`File upserted successfully.`);
}

/**
 * Opens a Pull Request from feature -> default.
 * SAFELY checks if it exists first.
 */
async function createWorkflowPR({ owner, repo, featureBranch, defaultBranch, title, body }) {
    console.log(`Checking for existing Pull Request...`);

    // 1. Check if PR already exists
    const { data: openPRs } = await octokit.pulls.list({
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
    const { data: pr } = await octokit.pulls.create({
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
 */
function generateCopilotPrompt({ issueKey, summary, description, repoConfig, repoName, defaultBranch, language }) {

    // Map Dynamic Variables
    const REPO_NAME = repoName;
    const DEFAULT_BRANCH = defaultBranch;
    const BUILD_COMMAND = repoConfig && repoConfig.buildCommand ? repoConfig.buildCommand : 'npm run build';
    const TEST_COMMAND = repoConfig && repoConfig.testCommand ? repoConfig.testCommand : 'npm test';

    // CodeQL Language Mapping
    let CODEQL_LANGUAGE = 'javascript';
    if (language === 'python') CODEQL_LANGUAGE = 'python';
    if (language === 'dotnet') CODEQL_LANGUAGE = 'csharp';
    if (language === 'java') CODEQL_LANGUAGE = 'java';

    return `@copilot /fix This issue **${issueKey}: ${summary}**

${description || ''}

Read the whole repository first
        & then please generate a CI / CD pipeline file based on this repo using the format below(ignore if already exists and working):
    \`\`\`yaml
name: CI Pipeline - ${REPO_NAME}

on:
  push:
    branches: ["main"]
  pull_request:
    branches: ["main"]
 
env:
  CI: true
  BUILD_COMMAND: npm run build
  TEST_COMMAND: npm test
  CODEQL_LANGUAGE: javascript
 
jobs:
 
  # -------------------------------------------------
  # JOB 1: BUILD & TEST
  # -------------------------------------------------
  build:
    runs-on: ubuntu-latest
 
    steps:
      - name: Checkout source
        uses: actions/checkout@v4
 
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
 
      - name: Install dependencies
        run: npm ci
 
      - name: Build
        run: \${{ env.BUILD_COMMAND }}
 
      - name: Test
        run: \${{ env.TEST_COMMAND }}
 
  # -------------------------------------------------
  # JOB 2: SECURITY SCANS
  # -------------------------------------------------
  security-scan:
    runs-on: ubuntu-latest
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
        uses: github/codeql-action/analyze@v3
 
  # -------------------------------------------------
  # JOB 3: DOCKER BUILD & PUSH
  # -------------------------------------------------
  docker-build:
    runs-on: ubuntu-latest
    needs: [build, security-scan]
 
    steps:
      - uses: actions/checkout@v4
 
      - name: Compute lowercase repo name
        run: |
          echo "REPO_LOWER=$(echo '\${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV
 
      - name: Login to ACR
        uses: docker/login-action@v3
        with:
          registry: \${{ secrets.ACR_LOGIN_SERVER }}
          username: \${{ secrets.ACR_USERNAME }}
          password: \${{ secrets.ACR_PASSWORD }}
 
      - name: Build and push image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            \${{ secrets.ACR_LOGIN_SERVER }}/\${{ env.REPO_LOWER }}:latest
            \${{ secrets.ACR_LOGIN_SERVER }}/\${{ env.REPO_LOWER }}:\${{ github.sha }}
 
  # -------------------------------------------------
  # JOB 4: DEPLOY (Publish Profile, Image-based)
  # -------------------------------------------------
  deploy:
    runs-on: ubuntu-latest
    needs: docker-build
    environment: 'Production'
 
    steps:
      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v2
        with:
          app-name: \${{ secrets.AZURE_WEBAPP_APP_NAME }}
          publish-profile: \${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
          images: \${{ secrets.ACR_LOGIN_SERVER }}/\${{ env.REPO_LOWER }}:\${{ github.sha }}
\`\`\`

    Additional Guidance for Static Website (HTML/CSS/JS):

    1. Only deploy necessary files: index.html, *.html, *.css, *.js, and asset folders (assets/, static/, images/, fonts/).
    2. Prefer deploying the public/ folder if present; otherwise create a deploy/ folder with only static site files.
    3. Validate that \${{ env.PACKAGE_DIR }}/index.html exists before deploy; fail fast if missing.
    4. Use package: \${{ env.PACKAGE_DIR }} in the deploy step to avoid uploading .github/, node_modules/, etc.
    5. Optionally add .zipignore to exclude non-site content if packaging repository root (not recommended here).

    This ensures Azure Web App Zip Deploy receives a minimal, correct package for static sites and reduces deployment failures.
`;
}

/**
 * Orchestrates the PR Workflow.
 */
async function createPullRequestForWorkflow({ repoName, filePath, content, language, issueKey, deployTarget, defaultBranch, repoConfig, ticketData }) {
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
        const { pr, isNew } = await createWorkflowPR({
            owner,
            repo,
            featureBranch,
            defaultBranch,
            title: `${issueKey}: Enable CI/CD for ${language}`,
            body: `This PR was automatically generated by the DevOps Automation Service for Jira Ticket ${issueKey}.\n\n✅ **Analysis Complete**: Detailed Requirements posted below for Copilot.\n\nAdding ${language} workflow.${deployTarget === 'docker' ? '\n\nAlso added Dockerfile for containerization.' : ''}`
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
                language
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
 * Mark a draft Pull Request as Ready for Review using GitHub GraphQL API.
 */
async function approvePullRequest({ repoName, pullNumber }) {
    const [owner, repo] = repoName.split('/');
    try {
        await octokit.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            event: 'APPROVE',
            body: '✅ Auto-approved by Jira Autopilot.'
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

module.exports = {
    generateWorkflowFile,
    createPullRequestForWorkflow,
    getPullRequestChecks,
    detectRepoLanguage,
    generateDockerfile,
    analyzeRepoStructure,
    getRepoInstructions,
    getDefaultBranch,
    hasExistingWorkflow,
    triggerExistingWorkflow,
    findCopilotSubPR,
    mergeSubPRIntoBranch,
    getPullRequestDetails,
    deleteBranch,
    markPullRequestReadyForReview,
    mergePullRequest,
    enablePullRequestAutoMerge,
    isPullRequestMerged,
    approvePullRequest,
    getLatestWorkflowRunForRef,
    getJobsForRun,
    summarizeFailureFromRun
    , getLatestDeploymentUrl
    , extractJiraKeyFromText
    , listOpenOrgPullRequests
    , getActiveOrgPRsWithJiraKeys
};

