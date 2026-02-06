const fs = require('fs');
const path = require('path');
const {
    checkRepoAccess,
    getRepoRootFiles,
    getRepoDirectoryFiles,
    listAccessibleRepos,
    getRepoFileContent,
    listRepoWorkflows,
    listBranches // [NEW]
} = require('../src/services/githubService');
const llmService = require('../src/services/llmService');
const { runDevOpsScan } = require('../src/services/devopsChecks');
const {
    createIssue,
    getProjects,
    searchIssues,
    updateIssue,
    addComment
} = require('../src/services/jiraService');
const dotenv = require('dotenv');
dotenv.config();

const { JIRA_PROJECT_KEY } = process.env;

if (!JIRA_PROJECT_KEY) {
    if (require.main === module) {
        console.error('❌ Error: JIRA_PROJECT_KEY is not defined in .env file.');
        process.exit(1);
    }
}

// --- Config Loading ---
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'repo-inspector.config.json');
let config = {};

try {
    if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        config = JSON.parse(raw);
    } else {
        config = {
            basicFiles: ['readme.md', 'license', '.gitignore'],
            readmeChecks: { minLength: 100 },
            workflowChecks: {
                deprecatedActions: ['actions/checkout@v2', 'actions/setup-node@v1']
            }
        };
        // console.warn('⚠️  Config file not found. Using defaults.');
    }
} catch (e) {
    console.error('❌ Failed to load config:', e.message);
    if (require.main === module) process.exit(1);
}

// Helper to flatten config arrays for easy checking
const ALL_BASIC_FILES = config.basicFiles || [];

// --- Interactive Input Setup ---
const readline = require('readline');

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(query, (ans) => {
        rl.close();
        resolve(ans);
    }));
}


// --- Logic ---

async function processRepo(repoName, autoFix = false, logger = console.log) {
    const log = (msg) => { if (logger) logger(msg); };
    const error = (msg) => { if (logger) logger(msg); };

    if (!repoName.match(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-._]+$/)) {
        error(`❌ Invalid repo format: ${repoName}`);
        return;
    }

    log(`\n🔍 Verifying access to ${repoName}...`);
    const accessCheck = await checkRepoAccess(repoName);

    if (!accessCheck.accessible) {
        error(`\n❌ Error: Repository ${repoName} not found or PAT does not have access.`);
        return;
    }

    log(`✅ Access confirmed for ${repoName}. Starting Deep Inspection...`);

    const rootFiles = await getRepoRootFiles(repoName);
    const lowerFiles = rootFiles.map(f => f.toLowerCase());
    const findings = [];

    // --- 1. Basic File Checks ---
    const hasReadme = lowerFiles.some(f => f.startsWith('readme'));
    if (!hasReadme) {
        findings.push({
            summary: `Missing README in ${repoName}`,
            description: `The repository [${repoName}|https://github.com/${repoName}] is missing a README file.`
        });
        log('   ❌ Missing README');
    }

    const hasLicense = lowerFiles.some(f => f.includes('license') || f.includes('copying'));
    if (!hasLicense) {
        findings.push({
            summary: `Missing LICENSE in ${repoName}`,
            description: `The repository [${repoName}|https://github.com/${repoName}] is missing a LICENSE file.`
        });
        log('   ❌ Missing LICENSE');
    }

    if (!lowerFiles.includes('.gitignore')) {
        findings.push({
            summary: `Missing .gitignore in ${repoName}`,
            description: `The repository [${repoName}|https://github.com/${repoName}] is missing a .gitignore file.`
        });
        log('   ❌ Missing .gitignore');
    }

    // --- 2. README Quality Check ---
    if (hasReadme) {
        const readmeFile = rootFiles.find(f => f.toLowerCase().startsWith('readme'));
        const content = await getRepoFileContent(repoName, readmeFile);
        const minLen = config.readmeChecks?.minLength || 100;

        if (content && content.length < minLen) {
            findings.push({
                summary: `Poor Quality README in ${repoName}`,
                description: `The README file in [${repoName}|https://github.com/${repoName}] is too short (< ${minLen} characters). Please expand it.`
            });
            log(`   ⚠️  README is too short (${content.length} chars)`);
        } else {
            log('   ✅ README quality check passed');
        }
    }

    // --- 3. Language/Framework Detection ---
    let detectedLanguage = 'Unknown';
    if (lowerFiles.includes('package.json')) detectedLanguage = 'Node.js';
    else if (lowerFiles.includes('pom.xml')) detectedLanguage = 'Java';
    else if (lowerFiles.includes('requirements.txt') || lowerFiles.includes('pyproject.toml')) detectedLanguage = 'Python';

    if (detectedLanguage !== 'Unknown') {
        log(`   ℹ️  Detected ${detectedLanguage}`);
    }

    // --- 4. Workflow Validation ---
    const workflowFiles = await getRepoDirectoryFiles(repoName, '.github/workflows');

    if (workflowFiles.length === 0) {
        findings.push({
            summary: `Missing CI/CD Workflows in ${repoName}`,
            description: `The repository does not have any workflows in .github/workflows.`
        });
        log('   ❌ Missing CI/CD Workflows');
    } else {
        log(`   Found ${workflowFiles.length} workflow file(s). Analyzing...`);
        const workflows = await listRepoWorkflows(repoName);
        workflows.forEach(w => {
            if (w.state !== 'active') {
                findings.push({
                    summary: `Workflow Disabled: ${w.name}`,
                    description: `The workflow "${w.name}" in ${repoName} is currently disabled. Please review.`
                });
                log(`       ❌ Workflow "${w.name}" is ${w.state}`);
            }
        });

        const deprecatedList = config.workflowChecks?.deprecatedActions || [];
        for (const file of workflowFiles) {
            if (file.endsWith('.yml') || file.endsWith('.yaml')) {
                const content = await getRepoFileContent(repoName, `.github/workflows/${file}`);
                if (content) {
                    for (const dep of deprecatedList) {
                        if (content.includes(dep)) {
                            findings.push({
                                summary: `Deprecated Action in ${file}`,
                                description: `The workflow file ${file} uses a deprecated action "${dep}". Please upgrade.`
                            });
                            log(`       ⚠️  Deprecated action "${dep}" in ${file}`);
                        }
                    }
                }
            }
        }
    }

    // --- 5. Deep DevOps Scan (New Module) ---
    log('   🚀 Running Deep DevOps Checks...');
    try {
        const deepFindings = await runDevOpsScan(repoName, rootFiles);
        if (deepFindings.length > 0) {
            log(`   Found ${deepFindings.length} DevOps issues.`);
            findings.push(...deepFindings);
        } else {
            log('   ✅ No DevOps smells found.');
        }
    } catch (e) {
        error(`   ⚠️  Deep scan failed: ${e.message}`);
    }

    // --- Report Findings ---
    if (findings.length === 0) {
        log('   🎉 No issues found!');
    } else {
        log(`   Found ${findings.length} issue(s). Aggregating into a single ticket...`);

        // 1. Calculate Payload data once
        let buildCmd = 'N/A';
        let testCmd = 'N/A';
        if (detectedLanguage === 'Node.js') { buildCmd = 'npm build'; testCmd = 'test'; } // corrected 'npm test' to 'test' if strictly following prev logic, but 'npm test' is safer. Let's stick to safe defaults.
        if (detectedLanguage === 'Node.js') { buildCmd = 'npm build'; testCmd = 'npm test'; }
        if (detectedLanguage === 'Java') { buildCmd = 'mvn package'; testCmd = 'mvn test'; }
        if (detectedLanguage === 'Python') { buildCmd = 'pip install'; testCmd = 'pytest'; }

        const payload = `Payload:\n- Language: ${detectedLanguage}\n- Build: ${buildCmd}\n- Test: ${testCmd}`;

        // 1.5 Fetch Branch Info
        log('   🌿 Fetching branch structure...');
        const branches = await listBranches(repoName);
        log(`   Found ${branches.length} branches.`);

        // 2. Generate Report (LLM or Static Fallback)
        let fullDescription = "";

        log('   🤖 Asking AI to generate Audit Report...');

        // Get README content for context (reuse if already fetched, or fetch now)
        let readmeContent = "";
        const readmeFile = rootFiles.find(f => f.toLowerCase().startsWith('readme'));
        if (readmeFile) {
            readmeContent = await getRepoFileContent(repoName, readmeFile);
        }

        const llmReport = await llmService.analyzeInspectionResults(repoName, readmeContent, findings, branches);

        if (llmReport) {
            fullDescription = llmReport;
            // Append payload at the end for machine readablity if needed, or trust the human report
            fullDescription += `\n\n----\n${payload}`;
            log('   ✅ AI Report Generated.');
        } else {
            log('   ⚠️ AI Generation failed. Using static template.');
            // Fallback to static
            fullDescription = `Repository Inspection Results for ${repoName}\n\n`;
            fullDescription += `The following issues were detected during the automated health scan:\n\n`;
            findings.forEach((f, idx) => {
                fullDescription += `${idx + 1}. ${f.summary}\n`;
                fullDescription += `   ${f.description}\n\n`;
            });
            fullDescription += `----\n${payload}`;
        }

        const ticketSummary = `Repo Health Remediation: ${repoName}`;

        try {
            // Determine JIRA Project - prioritize INS for inspection results
            const JIRA_KEY = 'INS';

            // Search for existing ticket (Open only)
            const safeSummary = ticketSummary.replace(/"/g, '\\"');
            // JQL: Find tickets with same summary in this project that are NOT Done
            // We assume "Done" category covers Closed/Resolved.
            const jql = `project = "${JIRA_KEY}" AND summary ~ "${safeSummary}" AND statusCategory != Done`;

            const existingIssues = await searchIssues(jql);

            if (existingIssues.length > 0) {
                const issueKey = existingIssues[0].key;
                log(`       🔄 Found open ticket ${issueKey}. Updating...`);

                // Update description with latest findings
                await updateIssue(issueKey, {
                    description: fullDescription
                });

                // Add a comment to notify
                await addComment(issueKey, `🔄 Automated Scan Updated\nScan found ${findings.length} issues. Ticket description updated.`);
                log(`       ✅ Updated ${issueKey}`);
            } else {
                // Create New (Project INS requires 'Initiative' type)
                const ticket = await createIssue(JIRA_KEY, ticketSummary, fullDescription, 'Initiative');
                log(`       ✅ Created Master Ticket ${ticket.key}`);
            }

        } catch (err) {
            error(`       ❌ Orchestration failed: ${err.message}`);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const batchIndex = args.indexOf('--batch');
    const hasBatch = batchIndex !== -1;
    const cleanArgs = args.filter(a => !a.startsWith('--'));

    if (hasBatch) {
        console.log('🚀 Starting Batch Inspector...');
        let targetRepos = [];
        const possibleFile = args[batchIndex + 1];

        if (possibleFile && !possibleFile.startsWith('--')) {
            console.log(`Reading repositories from file: ${possibleFile}`);
            try {
                const content = fs.readFileSync(possibleFile, 'utf8');
                if (possibleFile.endsWith('.json')) {
                    targetRepos = JSON.parse(content);
                } else {
                    targetRepos = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                }
            } catch (e) {
                console.error(`Failed to read batch file: ${e.message}`);
                process.exit(1);
            }
        } else {
            console.log('Fetching all accessible repositories from GitHub...');
            const repos = await listAccessibleRepos();
            targetRepos = repos.map(r => r.full_name);
        }

        console.log(`\n📋 Found ${targetRepos.length} repositories to scan.\n`);
        for (const repo of targetRepos) {
            await processRepo(repo);
            console.log('---');
        }
        console.log('\n🏁 Batch Scan Complete.');
        process.exit(0);

    } else if (cleanArgs.length > 0) {
        const repoName = cleanArgs[0];
        await processRepo(repoName);
        console.log('\n🏁 Single Scan Complete.');
        process.exit(0);

    } else {
        console.log('--- GitHub Repo Health Inspector (Interactive) ---');
        console.log(`Target Jira Project: ${process.env.JIRA_PROJECT_KEY}`);

        const repos = await listAccessibleRepos();
        let repoName = '';

        if (repos.length > 0) {
            console.log('\nFound Repositories:');
            repos.slice(0, 15).forEach((r, i) => {
                console.log(`[${i + 1}] ${r.full_name}`);
            });
            if (repos.length > 15) console.log(`... and ${repos.length - 15} more.`);

            const answer = await askQuestion('\nSelect repository number or type "owner/repo": ');
            const choice = answer.trim();
            const num = parseInt(choice);

            if (!isNaN(num) && num > 0 && num <= repos.length) {
                repoName = repos[num - 1].full_name;
            } else {
                repoName = choice;
            }
        } else {
            const answer = await askQuestion('Enter repository (owner/repo): ');
            repoName = answer.trim();
        }

        await processRepo(repoName);
        console.log('\n🏁 interactive Scan Complete.');
    }
}

module.exports = { processRepo };

if (require.main === module) {
    main();
}
