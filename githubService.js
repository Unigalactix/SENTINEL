const { Octokit } = require('@octokit/rest');
require('dotenv').config();

// Initialize Octokit with the token from .env
const octokit = new Octokit({
    auth: process.env.GHUB_TOKEN
});

/**
 * Generates a GitHub Actions YAML string based on service details.
 * @param {object} config - The configuration object.
 * @param {string} config.language - 'node' | 'python' | 'dotnet'
 * @param {string} config.repoName - The repository name
 * @param {string} config.buildCommand - The build command
 * @param {string} config.testCommand - The test command
 * @param {string} [config.deployTarget] - Optional deployment target
 * @returns {string} The generated YAML content.
 */
function generateWorkflowFile({ language, repoName, buildCommand, testCommand, deployTarget }) {

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
        run: dotnet restore`
    };

    // Default to node if language not found
    const setupSteps = languageSteps[language] || languageSteps['node'];

    // Optional Deployment Job Construction
    let deployJob = '';
    if (deployTarget === 'azure-webapp') {
        deployJob = `
  deploy:
    runs-on: ubuntu-latest
    needs: build
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
    branches: [ "main" ]
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
async function createPullRequestForWorkflow({ repoName, filePath, content, language, issueKey }) {
    try {
        const [owner, repo] = repoName.split('/');

        // 1. Get Repo Default Branch
        const { data: repoData } = await octokit.repos.get({ owner, repo });
        const defaultBranch = repoData.default_branch;
        console.log(`Detected default branch: ${defaultBranch}`);

        // 2. Define Feature Branch Name
        // Stable name based on Ticket Key so we don't create duplicates
        const featureBranch = `chore/${issueKey}-workflow-setup`;
        console.log(`Using feature branch: ${featureBranch}`);

        // 3. Ensure Branch Exists
        await ensureFeatureBranch({ owner, repo, defaultBranch, featureBranch });

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
            body: `This PR was automatically generated by the DevOps Automation Service for Jira Ticket ${issueKey}.\n\nAdding ${language} workflow.`
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

        console.log('No specific marker found, defaulting to node.');
        return 'node';

    } catch (error) {
        console.error(`Language detection failed for ${repoName}: ${error.message}`);
        return 'node'; // Safe default
    }
}

module.exports = { generateWorkflowFile, createPullRequestForWorkflow, getPullRequestChecks, detectRepoLanguage };
