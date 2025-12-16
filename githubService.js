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

    return `@copilot /fix **${issueKey}: ${summary}**

${description || ''}

Please generate a CI/CD pipeline file for this repo in the format below:

\`\`\`yaml
name: CI Pipeline - ${REPO_NAME}
on:
  push:
    branches: [ "${DEFAULT_BRANCH}" ]
  pull_request:
    branches: [ "${DEFAULT_BRANCH}" ]
env:
  CI: true
jobs:

  --- JOB 1: BUILD & TEST ---
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

      # [DYNAMIC] Setup Logic based on Language Detected
      # Language: ${language}
      
      # [DYNAMIC] Commands injected from Repo Analysis (package.json/pom.xml) or Defaults
      - name: Build
        run: ${BUILD_COMMAND}
      - name: Test
        run: ${TEST_COMMAND}

  --- JOB 2: SECURITY SCANS ---
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
        languages: ${CODEQL_LANGUAGE}
    - name: Autobuild
      uses: github/codeql-action/autobuild@v3
    - name: Perform CodeQL Analysis
      uses: github/codeql-action/analyze@v3

  --- JOB 3: CONTAINERIZATION (Conditional) ---
  # Generates if deploy target is 'docker' OR 'azure-webapp'
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
        TRIVY_PASSWORD: \${{ secrets.GITHUB_TOKEN }}

  --- JOB 4: DEPLOYMENT (Conditional) ---
  # Generates if deploy target is 'azure-webapp'
  deploy:
    runs-on: ubuntu-latest
    needs: [build, security-scan]
    environment: Production
    steps:
    - uses: actions/checkout@v4
    - name: Deploy to Azure Web App
      uses: azure/webapps-deploy@v2
      with:
        app-name: 'payment-service-prod'
        publish-profile: \${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
        package: .
\`\`\`
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

        // 4. Upsert Workflow File
        await upsertWorkflowFileOnBranch({
            owner,
            repo,
            branch: featureBranch,
            message: `feat: Add ${language} CI workflow`,
            contentBase64: Buffer.from(content).toString('base64'),
            filePath
        });




        // 6. Create PR
        const { pr, isNew } = await createWorkflowPR({
            owner,
            repo,
            featureBranch,
            defaultBranch,
            title: `${issueKey}: Enable CI/CD for ${language}`,
            body: `This PR was automatically generated by the DevOps Automation Service for Jira Ticket ${issueKey}.\n\n✅ **Analysis Complete**: Detailed Requirements posted below for Copilot.\n\nAdding ${language} workflow.${deployTarget === 'docker' ? '\n\nAlso added Dockerfile for containerization.' : ''}`
        });

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

module.exports = {
    generateWorkflowFile, createPullRequestForWorkflow, getPullRequestChecks,
    detectRepoLanguage,
    generateDockerfile,
    analyzeRepoStructure,
    getRepoInstructions,
    getDefaultBranch
};

