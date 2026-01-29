const {
    getRepoFileContent,
    getRepoDirectoryFiles,
    getBranchProtection,
    getReleases,
    getDefaultBranch
} = require('./githubService');

/**
 * Perform a deep scan for DevOps "smells".
 * @param {string} repoName 
 * @param {string[]} rootFiles - List of files in root, cached from main inspector
 * @returns {Promise<Array<{summary: string, description: string}>>} List of findings
 */
async function runDevOpsScan(repoName, rootFiles) {
    const findings = [];
    const lowerFiles = rootFiles.map(f => f.toLowerCase());

    // Parallel Execution of Checks
    const [containerResults, ciResults, governanceResults, qualityResults] = await Promise.all([
        checkContainerization(repoName, rootFiles),
        checkPipelines(repoName, rootFiles),
        checkGovernance(repoName, rootFiles),
        checkQuality(repoName, rootFiles)
    ]);

    return [
        ...containerResults,
        ...ciResults,
        ...governanceResults,
        ...qualityResults
    ];
}

// --- 1. Containerization Checks ---
async function checkContainerization(repoName, rootFiles) {
    const findings = [];
    const dockerfile = rootFiles.find(f => f === 'Dockerfile');

    if (!dockerfile) return []; // No Docker, no container checks needed (or could suggest adding one?)

    const content = await getRepoFileContent(repoName, 'Dockerfile');
    if (!content) return [];

    // Check 1: Base Image Safety (latest tag)
    const fromLine = content.match(/^FROM\s+(.+)$/m);
    if (fromLine) {
        const image = fromLine[1].trim();
        if (image.endsWith(':latest') || !image.includes(':')) {
            findings.push({
                summary: `Unsafe Base Image in Dockerfile`,
                description: `The Dockerfile uses \`${image}\`. Using 'latest' tag is risky for production reproducibility. Pin to a specific version or SHA.`
            });
        }
    }

    // Check 2: Root User Detection
    if (!content.match(/^USER\s+/m)) {
        findings.push({
            summary: `Container Running as Root`,
            description: `The Dockerfile does not specify a USER instruction. By default, containers run as root, which is a security risk.`
        });
    }

    // Check 3: Context Optimization (.dockerignore)
    if (!rootFiles.includes('.dockerignore')) {
        findings.push({
            summary: `Missing .dockerignore`,
            description: `A Dockerfile exists but no .dockerignore found. This may lead to bloated build contexts (e.g. uploading node_modules).`
        });
    }

    return findings;
}

// --- 2. CI/CD Pipeline Checks ---
async function checkPipelines(repoName, rootFiles) {
    const findings = [];

    // Check for workflows
    // We need to list .github/workflows. 
    // Optimization: If .github not in root, skip.
    if (!rootFiles.includes('.github')) return [];

    const workflowFiles = await getRepoDirectoryFiles(repoName, '.github/workflows');
    if (workflowFiles.length === 0) return [];

    for (const file of workflowFiles) {
        if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;

        const content = await getRepoFileContent(repoName, `.github/workflows/${file}`);
        if (!content) continue;

        // Check 1: Timeouts
        // Simple heuristic: Does it contain "timeout-minutes:"? 
        // A robust check would parse YAML, but regex is faster and sufficient for "smell".
        if (!content.includes('timeout-minutes:')) {
            findings.push({
                summary: `Missing Job Timeouts in ${file}`,
                description: `The workflow ${file} usually lacks 'timeout-minutes'. Default timeouts (6h) can waste credits if jobs hang.`
            });
        }

        // Check 2: Hardcoded Secrets
        // Look for common patterns like "password: " followed by plain text, not ${{ ... }}
        // This is tricky with regex, but we can catch obvious ones.
        // We trigger if we see "password:" or "token:" NOT followed by '${{'
        const secretLeaks = content.match(/(password|token|secret|key)\s*:\s*(?!.*\$\{\{)[^\s]+[a-zA-Z0-9]/i);
        if (secretLeaks) {
            findings.push({
                summary: `Possible Hardcoded Secret in ${file}`,
                description: `Found potential hardcoded secret pattern: \`${secretLeaks[0]}\`. verify and use GitHub Secrets instead.`
            });
        }
    }

    // Check 3: Lock File Integrity
    const hasPackageJson = rootFiles.includes('package.json');
    const hasLock = rootFiles.includes('package-lock.json') || rootFiles.includes('yarn.lock') || rootFiles.includes('pnpm-lock.yaml');

    if (hasPackageJson && !hasLock) {
        findings.push({
            summary: `Missing Lock File`,
            description: `package.json exists but no lock file (package-lock.json/yarn.lock) found. Deterministic builds are not guaranteed.`
        });
    }

    return findings;
}

// --- 3. Governance & Security ---
async function checkGovernance(repoName, rootFiles) {
    const findings = [];

    // Check 1: Branch Protection
    const defaultBranch = await getDefaultBranch(repoName);
    const protection = await getBranchProtection(repoName, defaultBranch);

    // If protection is null, it's disabled.
    // Note: Some APIs return different structures. 
    // Ideally, we consider it "Missing" if 404 or null.
    if (!protection) {
        findings.push({
            summary: `Branch Protection Disabled`,
            description: `The default branch '${defaultBranch}' is not protected. Enable Branch Protection to prevent force pushes and ensure reviews.`
        });
    } else {
        // We could inspect details (e.g. required_pull_request_reviews)
        // For now, existence is good enough.
    }

    // Check 2: Dependabot
    // Check existence of .github/dependabot.yml
    const githubFiles = await getRepoDirectoryFiles(repoName, '.github');
    if (!githubFiles.includes('dependabot.yml') && !githubFiles.includes('dependabot.yaml')) {
        findings.push({
            summary: `Dependabot Not Configured`,
            description: `Missing .github/dependabot.yml. Automated dependency updates (SCA) are not enabled.`
        });
    }

    // Check 3: CODEOWNERS
    if (!githubFiles.includes('CODEOWNERS') && !rootFiles.includes('CODEOWNERS')) { // (sometimes in root too)
        findings.push({
            summary: `Missing CODEOWNERS`,
            description: `No CODEOWNERS file found. Define code ownership to automatically assign reviewers.`
        });
    }

    return findings;
}

// --- 4. Code Quality & Standards ---
async function checkQuality(repoName, rootFiles) {
    const findings = [];

    // Check 1: Linter Config
    const linters = ['.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', 'tslint.json', '.pylintrc', 'pyproject.toml'];
    const hasLinter = rootFiles.some(f => linters.includes(f) || linters.some(sub => f.includes(sub)));

    if (!hasLinter) {
        findings.push({
            summary: `Missing Linter/Formatter Config`,
            description: `No standard linter configuration found (e.g. .eslintrc, .prettierrc). Enforce code style consistency.`
        });
    }

    // Check 2: Semantic Versioning (Releases)
    const releases = await getReleases(repoName);
    if (!releases || releases.length === 0) {
        findings.push({
            summary: `No Releases Published`,
            description: `The repository has no GitHub Releases. Implement a Release process (e.g. Semantic Release) for versioning.`
        });
    }

    return findings;
}

module.exports = { runDevOpsScan };
