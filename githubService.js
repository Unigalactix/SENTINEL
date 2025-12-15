const { Octokit } = require('@octokit/rest');
require('dotenv').config();

// Initialize Octokit with the token from .env
const octokit = new Octokit({
    auth: process.env.GHUB_TOKEN
});

/**
/**
 * Generates a default Dockerfile content based on language.
 */
function generateDockerfile(language) {
    if (language === 'node') {
        return `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]`;
    }
    if (language === 'python') {
        return `FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
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
        return `FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app
COPY . .
RUN ./mvnw clean package -DskipTests

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

    // Language-specific setup steps
    const languageSteps = {
        'node': `
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
      - name: Running NPM Audit
        run: |
          if [ -f "package-lock.json" ]; then
            echo "Using npm for dependency checks"
            npm install
            npm audit --production --json || true
          fi`,

        'python': `
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      - name: Install dependencies
        run: pip install -r requirements.txt`,

        'dotnet': `
      - name: Set up .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'
      - name: Restore dependencies
        run: dotnet restore`,

        'java': `
      - name: Set up JDK 17
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

    const securityJob = `
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
          languages: ${codeqlLang}
      - name: Autobuild
        uses: github/codeql-action/autobuild@v3
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3`;

    // --- Docker Build Job (Container Ready) ---
    let dockerJob = '';
    // Generate Docker build for 'docker' AND 'azure-webapp' (unless explicitly opted out, which we don't support yet)
    if (deployTarget === 'docker' || deployTarget === 'azure-webapp') {
        dockerJob = `
  docker-build:
    runs-on: ubuntu-latest
    needs: [build, security-scan]
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/\${{ github.repository }}:latest
      - name: Run Trivy Vulnerability Scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'ghcr.io/\${{ github.repository }}:latest'
          format: 'table'
          exit-code: '1'
          ignore-unfixed: true
          vuln-type: 'os,library'
          severity: 'CRITICAL,HIGH'
        env:
          TRIVY_USERNAME: \${{ github.actor }}
          TRIVY_PASSWORD: \${{ secrets.GITHUB_TOKEN }}`;
    }

    // --- Azure Deployment Job ---
    let deployJob = '';
    if (deployTarget === 'azure-webapp') {
        deployJob = `
  deploy:
    runs-on: ubuntu-latest
    needs: [build, security-scan] # Can also depend on docker-build if we were deploying the container
    environment: Production
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4
      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v2
        with:
          app-name: 'payment-service-prod' 
          publish-profile: \${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
          package: .`;
    }

    const yamlContent = `
name: CI Pipeline - ${repoName}
on:
    push:
        branches: [ "${defaultBranch}" ]
    pull_request:
        branches: [ "${defaultBranch}" ]
env:
  CI: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupSteps}
      - name: Build
        run: ${buildCommand}
      - name: Test
        run: ${testCommand}

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
    return { pr, isNew: true };
}


/**
 * Orchestrates the PR Workflow.
 */
async function createPullRequestForWorkflow({ repoName, filePath, content, language, issueKey, deployTarget, defaultBranch }) {
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
                    const dockerContent = generateDockerfile(language);
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

        // 4. Upsert File
        await upsertWorkflowFileOnBranch({
            owner,
            repo,
            branch: featureBranch,
            message: `feat: Add ${language} CI workflow`,
            contentBase64: Buffer.from(content).toString('base64'),
            filePath
        });

        // 5. Create PR
        const { pr, isNew } = await createWorkflowPR({
            owner,
            repo,
            featureBranch,
            defaultBranch,
            title: `${issueKey}: Enable CI/CD for ${language}`,
            body: `This PR was automatically generated by the DevOps Automation Service for Jira Ticket ${issueKey}.\n\nAdding ${language} workflow.${deployTarget === 'docker' ? '\n\nAlso added Dockerfile for containerization.' : ''}`
        });

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

        if (fileNames.some(f => f.endsWith('.names') || f.endsWith('.csproj') || f.endsWith('.sln'))) {
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

module.exports = {
    generateWorkflowFile, createPullRequestForWorkflow, getPullRequestChecks,
    detectRepoLanguage,
    generateDockerfile,
    getDefaultBranch
};

