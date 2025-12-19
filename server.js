const express = require('express');
const fs = require('fs');
const path = require('path');
const {
    generateWorkflowFile,
    createPullRequestForWorkflow,
    getPullRequestChecks,
    detectRepoLanguage,
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
    approvePullRequest
} = require('./githubService');
const { getPendingTickets, transitionIssue, addComment } = require('./jiraService');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 30000; // Poll every 30 seconds
const USE_GH_COPILOT = process.env.USE_GH_COPILOT === 'true';
const { execFile } = require('child_process');

// In-memory store for UI
let systemStatus = {
    activeTickets: [],
    monitoredTickets: [], // Tickets we are watching for CI updates
    processedCount: 0,
    scanHistory: [],
    currentPhase: 'Initializing', // 'Scanning', 'Processing', 'Waiting'
    currentTicketKey: null,
    currentTicketLogs: [],     // New: Array of log strings for the active ticket
    currentJiraUrl: null,      // New: URL to Jira ticket
    currentPrUrl: null,        // New: URL to created PR
    currentPayload: null,      // New: Generated YAML content
    nextScanTime: Date.now() + 1000
};

const repoLanguageCache = new Map();

// Ensure logs directory exists
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

function writeLog(message) {
    const logFile = path.join(LOG_DIR, 'server.log');
    const timestamp = new Date().toISOString();
    const cleanMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logFile, cleanMessage, (err) => {
        if (err) console.error('Failed to write to log file:', err);
    });
}

app.use(express.json());
app.use(express.static('public')); // Serve UI

// --- Optional: GH Copilot Suggest Integration ---
app.post('/api/copilot/suggest', async (req, res) => {
    if (!USE_GH_COPILOT) {
        return res.status(400).json({ error: 'GH Copilot integration disabled. Set USE_GH_COPILOT=true' });
    }

    const { filename, message, commit } = req.body || {};
    // gh copilot suggest does not support --message/--filename; call plain suggest
    const args = ['copilot', 'suggest'];

    execFile('gh', args, { cwd: process.cwd() }, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: error.message, stderr });
        }
        res.json({ output: stdout, stderr });
    });
});

// --- API for UI ---
app.get('/api/status', (req, res) => {
    res.json(systemStatus);
});

// --- Helper: Log Progress ---
function logProgress(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message} `;
    console.log(logEntry);
    systemStatus.currentTicketLogs.push(logEntry);
    writeLog(message);
}

// --- Core Logic ---
async function processTicketData(issue) {
    if (!issue || !issue.fields) return;

    const issueKey = issue.key;
    const priority = issue.fields.priority?.name || 'Medium';

    // Reset Live Status for new ticket
    systemStatus.currentPhase = 'Processing';
    systemStatus.currentTicketKey = issueKey;
    systemStatus.currentTicketLogs = [];
    systemStatus.currentJiraUrl = `${process.env.JIRA_BASE_URL} /browse/${issueKey} `;
    systemStatus.currentPrUrl = null;
    systemStatus.currentPayload = null;

    logProgress(`Starting processing for ${issueKey}(Priority: ${priority})`);

    // Update Queue Status
    const queueItem = systemStatus.activeTickets.find(t => t.key === issueKey);
    if (queueItem) {
        queueItem.status = 'Processing...';
    } else {
        systemStatus.activeTickets.push({ key: issueKey, priority, status: 'Processing...' });
    }

    const ticketData = issue.fields;

    // --- Helper: Parse Jira ADF to Markdown ---
    function parseJiraADF(node) {
        if (!node) return '';
        if (typeof node === 'string') return node;

        if (node.type === 'text') return node.text;

        if (node.content) {
            return node.content.map(child => {
                let text = parseJiraADF(child);
                if (child.type === 'paragraph') return text + '\n\n';
                if (child.type === 'hardBreak') return '\n';
                if (child.type === 'listItem') {
                    // remove extra newlines from paragraph inside list item
                    return '- ' + text.trim() + '\n';
                }
                return text;
            }).join('');
        }
        return '';
    }

    // Normalize Description (Jira Cloud uses ADF objects)
    if (ticketData.description) {
        if (typeof ticketData.description === 'string') {
            // Already string
        } else {
            // It's an ADF object, parse it
            ticketData.description = parseJiraADF(ticketData.description);
        }
    } else {
        ticketData.description = '';
    }

    // Determine Project Key from Issue Key (e.g. NDE-123 -> NDE)
    const projectKey = issueKey.split('-')[0];

    // Dynamic Default Repo Lookup
    const defaultRepoEnvVar = `DEFAULT_REPO_${projectKey}`;
    const projectDefaultRepo = process.env[defaultRepoEnvVar];

    // Debug: Log repo lookup attempts
    console.log(`[Repo Lookup] ProjectKey: ${projectKey}, EnvVar: ${defaultRepoEnvVar}, Value: ${projectDefaultRepo}`);

    // Resolve repo from fields, then description/summary, then env default
    function extractOwnerRepo(txt) {
        if (!txt || typeof txt !== 'string') return null;
        const m = txt.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
        return m ? `${m[1]}/${m[2]}` : null;
    }

    const fieldRepo = (ticketData.customfield_repo || ticketData.repoName || '').trim();
    const descRepo = extractOwnerRepo(ticketData.description) || extractOwnerRepo(ticketData.summary);
    const repoName = fieldRepo || descRepo || projectDefaultRepo || 'Unigalactix/sample-node-project';

    // Pre-validate repo access and cache default branch
    let resolvedDefaultBranch = null;

    // Enforce allowed orgs scope
    const defaultOwner = (projectDefaultRepo || process.env.DEFAULT_REPO || 'Unigalactix/sample-node-project').split('/')[0];
    const allowedOrgs = (process.env.ALLOWED_ORGS ? process.env.ALLOWED_ORGS.split(',') : [defaultOwner])
        .map(s => s.trim())
        .filter(Boolean);
    const targetOwner = (repoName.split('/')[0] || '').trim();
    if (targetOwner && allowedOrgs.length && !allowedOrgs.includes(targetOwner)) {
        const msg = `Org out of scope: "${targetOwner}". Allowed orgs: ${allowedOrgs.join(', ')}`;
        logProgress(msg);
        if (issueKey) {
            await addComment(issueKey, `❌ ${msg}`);
            await transitionIssue(issueKey, 'To Do');
        }
        // Stop processing this ticket
        systemStatus.activeTickets = systemStatus.activeTickets.filter(t => t.key !== issueKey);
        return;
    }

    // Validate repo existence/access early
    try {
        resolvedDefaultBranch = await getDefaultBranch(repoName);
        logProgress(`Validated repository access for ${repoName}. Default branch: ${resolvedDefaultBranch}`);
    } catch (e) {
        const reason = e?.message || 'Unknown error';
        const msg = `Repository not accessible: ${repoName}. Reason: ${reason}. Ensure GHUB_TOKEN has repo access and the repo exists.`;
        logProgress(msg);
        if (issueKey) {
            await addComment(issueKey, `❌ ${msg}`);
            await transitionIssue(issueKey, 'To Do');
        }
        systemStatus.activeTickets = systemStatus.activeTickets.filter(t => t.key !== issueKey);
        return;
    }

    // Smart Language Detection
    let language = ticketData.customfield_language || ticketData.language;

    // 1. Description Parsing
    if (!language && ticketData.description) {
        // Ensure desc is a string (Jira ADF can be an object)
        const descStr = (typeof ticketData.description === 'string')
            ? ticketData.description
            : JSON.stringify(ticketData.description);

        const desc = descStr.toLowerCase();

        if (desc.match(/\b(node|nodejs|javascript|js)\b/)) language = 'node';
        else if (desc.match(/\b(python|django|flask)\b/)) language = 'python';
        else if (desc.match(/\b(dotnet|\.net|c#|csharp)\b/)) language = 'dotnet';
        else if (desc.match(/\b(java|spring|maven|gradle)\b/)) language = 'java';

        if (language) logProgress(`Detected language from description: ${language} `);
    }

    // 2. Repo Inspection (Cache or Live)
    let repoInstructions = {};
    let repoConfig = {};

    if (!language || true) { // Always analyze for deep config even if language is known
        // Status Update: Analyzing
        // updateStatus(issue.key, 'Analyzing Repository...', currentTicket); // currentTicket is not defined here

        // A. Check for specific instructions file (Markdown)
        try {
            repoInstructions = await getRepoInstructions(repoName);
            if (repoInstructions.buildCommand) logProgress(`Found build command in instructions: ${repoInstructions.buildCommand} `);
        } catch (e) { console.error(e); }

        // B. Deep Analyze Config Files (Code)
        try {
            repoConfig = await analyzeRepoStructure(repoName);
            if (repoConfig.buildCommand) logProgress(`Infered build command from config: ${repoConfig.buildCommand} `);
        } catch (e) { console.error(e); }

        if (!language) {
            if (repoLanguageCache.has(repoName)) {
                language = repoLanguageCache.get(repoName);
            } else {
                // New repo found, detect language
                logProgress(`Detecting language for ${repoName}...`);
                language = await detectRepoLanguage(repoName);
                repoLanguageCache.set(repoName, language);
                logProgress(`Detected language: ${language} `);
            }
        }
    }

    // Default commands based on language (if not specified)
    // Priority: Jira Field > Repo Instructions (MD) > Repo Config (Code) > Language Default
    let buildCommand = ticketData.customfield_build || repoInstructions.buildCommand || repoConfig.buildCommand || ticketData.buildCommand;
    let testCommand = ticketData.customfield_test || repoInstructions.testCommand || repoConfig.testCommand || ticketData.testCommand;

    if (!buildCommand) {
        if (language === 'node') buildCommand = 'npm run build';
        if (language === 'dotnet') buildCommand = 'dotnet build';
        if (language === 'python') buildCommand = 'pip install -r requirements.txt';
        if (language === 'java') buildCommand = './mvnw clean package';
    }
    if (!testCommand) {
        if (language === 'node') testCommand = 'npm test';
        if (language === 'dotnet') testCommand = 'dotnet test';
        if (language === 'python') testCommand = 'pytest';
        if (language === 'java') testCommand = './mvnw test';
    }

    const deployTarget = ticketData.customfield_deploy || ticketData.deployTarget || 'azure-webapp';

    try {
        // 1. Move to In Progress
        logProgress(`Transitioning Jira ticket to "In Progress"...`);
        if (issueKey) await transitionIssue(issueKey, 'In Progress');

        // 1b. Get Default Branch (Dynamic)
        const defaultBranch = resolvedDefaultBranch || await getDefaultBranch(repoName);
        logProgress(`Targeting default branch: ${defaultBranch} `);

        // 2.1 Optional: Apply ticket-specific Copilot fixes to target files before PR
        const ticketFiles = Array.isArray(ticketData.customfield_files) ? ticketData.customfield_files : [];
        if (USE_GH_COPILOT && ticketFiles.length > 0) {
            const fixPrompt = `Address Jira ticket ${issueKey} requirements. Context: Language=${language}, Build=${buildCommand}, Test=${testCommand}. Make minimal, safe changes.`;
            logProgress(`Applying Copilot fixes to ${ticketFiles.length} file(s)...`);
            await applyCopilotFixes({ files: ticketFiles, prompt: fixPrompt });
        }

        // 2.2 Pre-PR AI Generation (Hybrid CLI) for workflow content
        let workflowYml;
        if (USE_GH_COPILOT) {
            logProgress(`Running gh copilot suggest for pre-PR generation...`);
            const targetFile = `.github/workflows/${repoName.split('/')[1] || 'repo'}-ci.yml`;
            const promptParts = [
                `Jira Ticket: ${issueKey}`,
                `Repo: ${repoName}`,
                `Default Branch: ${defaultBranch}`,
                `Language: ${language}`,
                `Build Command: ${buildCommand}`,
                `Test Command: ${testCommand}`,
                repoConfig.runCommand ? `Run Command: ${repoConfig.runCommand}` : null,
                repoConfig.dockerBuildCommand ? `Docker: ${repoConfig.dockerBuildCommand}` : null,
                deployTarget ? `Deploy Target: ${deployTarget}` : null
            ].filter(Boolean);
            const message = `Generate CI workflow based on repo analysis. Details -> ${promptParts.join(' | ')}`;

            // Call plain suggest without unsupported flags
            const args = ['copilot', 'suggest'];
            const ghOutput = await new Promise((resolve) => {
                execFile('gh', args, { cwd: process.cwd() }, (error, stdout, stderr) => {
                    if (error) {
                        logProgress(`Copilot CLI failed: ${error.message}. Falling back.`);
                        resolve(null);
                        return;
                    }
                    // Basic parse: use stdout as proposed file content
                    if (stdout && stdout.trim().length > 0) {
                        resolve(stdout);
                    } else {
                        logProgress(`Copilot CLI produced no content. Falling back.`);
                        resolve(null);
                    }
                });
            });

            if (ghOutput) {
                workflowYml = ghOutput;
                logProgress(`Using Copilot-generated workflow content.`);
            }
        }

        // Fallback: deterministic generator
        if (!workflowYml) {
            logProgress(`Generating ${language} workflow for ${repoName}...`);
            workflowYml = generateWorkflowFile({ language, repoName, buildCommand, testCommand, deployTarget, defaultBranch });
        }
        systemStatus.currentPayload = workflowYml;

        // 3. Create Pull Request (with detailed logs inside githubService -> or we log steps here)
        logProgress(`Initiating Pull Request creation sequence...`);
        const result = await createPullRequestForWorkflow({
            repoName,
            filePath: `.github/workflows/ci.yml`,
            content: workflowYml,
            language,
            issueKey, // Pass issueKey for stable branching
            deployTarget, // Pass deploy target for Dockerfile generation logic
            defaultBranch,
            repoConfig, // [NEW] Pass deep analysis results
            ticketData: { ...ticketData, buildCommand, testCommand }
        });

        systemStatus.currentPrUrl = result.prUrl;

        if (result.isNew) {
            logProgress(`PR Created Successfully: ${result.prUrl} `);

            // 4. Comment Success & Move to Done
            if (issueKey) {
                logProgress(`Posting Success comment to Jira...`);
                await addComment(issueKey, `SUCCESS: Workflow PR created! \nLink: ${result.prUrl} `);
                await transitionIssue(issueKey, 'Done');
                logProgress(`Ticket moved to "Done".`);
            }
        } else {
            logProgress(`PR already exists: ${result.prUrl} `);
            if (issueKey) {
                logProgress(`Updates verified.Moving to Done.`);
                await addComment(issueKey, `VERIFIED: Workflow PR already exists.\nLink: ${result.prUrl} `);
                await transitionIssue(issueKey, 'Done');
            }
        }

        // Update UI History & Start Monitoring
        systemStatus.processedCount++;
        const historyItem = {
            key: issueKey,
            priority,
            result: 'Success',
            time: new Date().toLocaleTimeString(),
            jiraUrl: systemStatus.currentJiraUrl,
            prUrl: result.prUrl,
            repoName,
            branch: result.branch, // Needed for check monitoring
            payload: workflowYml, // Store payload for UI
            language, // [NEW] for UI
            deployTarget, // [NEW] for UI
            checks: [],
            copilotPrUrl: null,
            copilotMerged: false,
            copilotCreatedAt: null, // [NEW]
            copilotMergedAt: null,   // [NEW]
            toolUsed: null           // [NEW]
        };
        systemStatus.scanHistory.unshift(historyItem);
        // Add to monitored list
        systemStatus.monitoredTickets.push(historyItem);

    } catch (error) {
        logProgress(`ERROR: ${error.message} `);
        console.error(`Failed to process ${issueKey}: `, error.message);
        if (issueKey) {
            await addComment(issueKey, `FAILURE: Could not create workflow.Error: ${error.message} `);
            logProgress(`Transitioning ticket back to "To Do"...`);
            await transitionIssue(issueKey, 'To Do');
        }
        systemStatus.scanHistory.unshift({ key: issueKey, priority, result: 'Failed', time: new Date().toLocaleTimeString() });
    } finally {
        // Clear active state after a short delay so user can see 'Done' state if watching closely? 
        // Or immediately clear. Let's clear immediately but logs persist until next ticket?
        // Actually, we remove from activeTickets, but we might want to keep currentTicketKey/logs visible until next poll
        // But for queue management, we must remove it.
        systemStatus.activeTickets = systemStatus.activeTickets.filter(t => t.key !== issueKey);
        // Note: We leave currentTicketKey/Logs populated until the *next* ticket starts or polling cycle ends
    }
}

// --- Helper: Apply Copilot fixes across multiple files before PR ---
async function applyCopilotFixes({ files = [], prompt = '' }) {
    if (!USE_GH_COPILOT) return [];
    const results = [];
    for (const f of files) {
        await new Promise((resolve) => {
            // Basic suggest only; flags like --filename/--message are unsupported
            const args = ['copilot', 'suggest'];
            execFile('gh', args, { cwd: process.cwd() }, (error, stdout, stderr) => {
                results.push({ file: f, ok: !error, stdout, stderr, error: error ? error.message : null });
                resolve();
            });
        });
    }
    return results;
}

// --- Polling Loop (Autopilot Mode) ---
async function startPolling() {
    console.log('--- Starting Jira Autopilot Polling ---');

    const poll = async () => {
        try {
            // PHASE: Scanning
            systemStatus.currentPhase = 'Scanning';
            systemStatus.nextScanTime = null;
            // Clear logs if we are starting a fresh scan and nothing is active
            if (!systemStatus.currentTicketKey) {
                // systemStatus.currentTicketLogs = []; // Optional: clear logs between scans
            }

            console.log('Polling for new tickets...');

            let issues = await getPendingTickets();

            if (issues.length > 0) {
                console.log(`Found ${issues.length} pending tickets.`);

                // Populate Queue
                systemStatus.activeTickets = issues.map(i => ({
                    key: i.key,
                    priority: i.fields.priority?.name || 'Medium',
                    status: 'Queued'
                }));

                // PHASE: Processing loop
                systemStatus.currentPhase = 'Processing';
                for (const issue of issues) {
                    await processTicketData(issue);
                }
            } else {
                console.log('No tickets found.');
            }
        } catch (error) {
            console.error('Polling error:', error.message);
        } finally {
            // PHASE: Waiting
            systemStatus.currentPhase = 'Waiting';
            systemStatus.currentTicketKey = null; // Reset info display when waiting
            systemStatus.nextScanTime = Date.now() + POLL_INTERVAL_MS;

            // Schedule next poll
            setTimeout(poll, POLL_INTERVAL_MS);
        }
    };

    const monitorChecks = async () => {
        try {
            if (systemStatus.monitoredTickets.length > 0) {
                // console.log('Checking CI status for monitored tickets...');
                for (const ticket of systemStatus.monitoredTickets) {
                    if (!ticket.branch) continue;
                    const checks = await getPullRequestChecks({
                        repoName: ticket.repoName,
                        ref: ticket.branch
                    });

                    // Update the check status in history
                    // We need to find the history item and update it (ticket is a reference to history item if pushed directly)
                    ticket.checks = checks;

                    // Attempt to detect and merge Copilot sub PR into our feature branch
                    if (!ticket.copilotMerged && ticket.prUrl) {
                        try {
                            const mainPrNumber = parseInt(ticket.prUrl.split('/').pop(), 10);
                            const mainPr = await getPullRequestDetails({ repoName: ticket.repoName, pull_number: mainPrNumber });
                            const subPr = await findCopilotSubPR({ repoName: ticket.repoName, mainPrNumber });
                            if (subPr) {
                                ticket.copilotPrUrl = subPr.html_url;
                                // [NEW] Capture Creation Time for Timer
                                if (!ticket.copilotCreatedAt) {
                                    ticket.copilotCreatedAt = subPr.created_at;
                                }

                                const hasWipLabel = Array.isArray(subPr.labels) && subPr.labels.some(l => /\bWIP\b/i.test(l.name || ''));
                                const isWipTitle = /\bWIP\b/i.test(subPr.title || '');
                                // const isDraft = !!subPr.draft; // User Requested to ignore Draft as a blocker

                                // Only block if explicit WIP title
                                const isWorkInProgress = isWipTitle; // (or hasWipLabel if we wanted to be stricter, but user said 'marked WIP' check title)

                                if (!isWorkInProgress) {
                                    // If it's a draft, we must undraft it before merging (using pulls.merge)
                                    if (subPr.draft) {
                                        console.log(`[Autopilot] SubPR #${subPr.number} is Draft. Mark as Ready for Review...`);
                                        await markPullRequestReadyForReview({ repoName: ticket.repoName, pullNumber: subPr.number });
                                        ticket.toolUsed = "Autopilot + Undraft"; // [NEW] Track tool usage
                                    } else {
                                        ticket.toolUsed = "Autopilot"; // [NEW] Track tool usage
                                    }

                                    // [NEW] Auto-Approve the PR
                                    console.log(`[Autopilot] Auto-approving SubPR #${subPr.number}...`);
                                    await approvePullRequest({ repoName: ticket.repoName, pullNumber: subPr.number });

                                    // Enable GitHub Auto-Merge on the sub PR
                                    const autoRes = await enablePullRequestAutoMerge({ repoName: ticket.repoName, pullNumber: subPr.number, mergeMethod: 'SQUASH' });
                                    if (autoRes.ok) {
                                        ticket.autoMergeEnabled = true;
                                        logProgress(`Auto-merge enabled for Copilot SubPR #${subPr.number} on ${ticket.key}.`);
                                        await addComment(ticket.key, `🤖 **Copilot Update**: Auto-merge has been enabled for the sub-PR #${subPr.number}.\n\nIt will merge once all required checks pass.`);
                                        // Opportunistic check: mark merged flag if already merged
                                        const mergedCheck = await isPullRequestMerged({ repoName: ticket.repoName, pullNumber: subPr.number });
                                        if (mergedCheck.merged) {
                                            ticket.copilotMerged = true;
                                            ticket.copilotMergedAt = new Date().toISOString();
                                        }
                                    } else {
                                        console.log(`[Autopilot] ⚠️ Auto-merge enable failed for SubPR #${subPr.number}: ${autoRes.message}`);

                                        // Fallback: If Auto-Merge fails (e.g. "clean status" which implies ready, or not protected), try immediate merge
                                        console.log(`[Autopilot] Attempting immediate merge for SubPR #${subPr.number} as fallback...`);
                                        const mergeRes = await mergePullRequest({ repoName: ticket.repoName, pullNumber: subPr.number, method: 'squash' });

                                        if (mergeRes.merged) {
                                            ticket.copilotMerged = true;
                                            ticket.copilotMergedAt = new Date().toISOString();
                                            logProgress(`Successfully merged Copilot SubPR #${subPr.number} (Fallback).`);
                                            await addComment(ticket.key, `🤖 **Copilot Update**: PR #${subPr.number} was merged successfully.`);
                                        } else {
                                            console.log(`[Autopilot] ❌ Immediate merge also failed: ${mergeRes.message}`);
                                        }
                                    }
                                } else {
                                    console.log(`[Autopilot] ⏳ SubPR #${subPr.number} detected but marked WIP. Waiting... (Title: "${subPr.title}")`);
                                }
                            }
                        } catch (e) {
                            // Non-blocking; continue monitoring
                            console.error(`[Autopilot] ⚠️ Error in monitorChecks for ${ticket.key}:`, e.message);
                        }
                    }

                    // Check for Deployment Success
                    if (!ticket.deploymentPosted && ticket.checks && ticket.checks.length > 0) {
                        const deployCheck = ticket.checks.find(c => c.name === 'deploy' && c.conclusion === 'success');
                        if (deployCheck) {
                            ticket.deploymentPosted = true;
                            logProgress(`Deployment detected for ${ticket.key}. Posting comment...`);
                            // Hardcoded app name for now as per plan
                            const appUrl = 'https://mvdemoapp.azurewebsites.net';
                            await addComment(ticket.key, `🚀 **Deployment Successful!**\n\nThe application is live at: [${appUrl}](${appUrl})\n\n[View Deployment Logs](${deployCheck.url})`);

                            // Cleanup: Delete Copilot Branch if it was merged
                            if (ticket.copilotMerged && ticket.copilotPrUrl) {
                                // Extract branch name from PR URL? No, we didn't store branch name explicitly.
                                // But we can get it from the cached PR URL or by fetching the PR again.
                                // Optimally, we should have stored it. Let's try to fetch it quickly.
                                try {
                                    const prNum = parseInt(ticket.copilotPrUrl.split('/').pop(), 10);
                                    if (!isNaN(prNum)) {
                                        const subPrDetails = await getPullRequestDetails({ repoName: ticket.repoName, pull_number: prNum });
                                        if (subPrDetails && subPrDetails.head && subPrDetails.head.ref) {
                                            const branchToDelete = subPrDetails.head.ref;
                                            logProgress(`Cleaning up: Deleting Copilot branch ${branchToDelete}...`);
                                            await deleteBranch({ repoName: ticket.repoName, branchName: branchToDelete });
                                        }
                                    }
                                } catch (cleanupErr) {
                                    console.error('Cleanup failed:', cleanupErr.message);
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Monitoring error:', error.message);
        } finally {
            setTimeout(monitorChecks, 10000); // Check every 10s
        }
    };

    poll();
    monitorChecks();
}

// Start Server & Polling
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} `);
    console.log(`GitHub Token present: ${!!process.env.GHUB_TOKEN} `);
    console.log(`Jira Project: ${process.env.JIRA_PROJECT_KEY} `);
    console.log(`GH Copilot enabled: ${USE_GH_COPILOT} `);

    setTimeout(startPolling, 1000);
});
