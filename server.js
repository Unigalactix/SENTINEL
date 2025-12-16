const express = require('express');
const {
    generateWorkflowFile,
    createPullRequestForWorkflow,
    getPullRequestChecks,
    detectRepoLanguage,
    getRepoInstructions,
    analyzeRepoStructure,
    getDefaultBranch
} = require('./githubService');
const { getPendingTickets, transitionIssue, addComment } = require('./jiraService');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 30000; // Poll every 30 seconds

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

app.use(express.json());
app.use(express.static('public')); // Serve UI

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

    // Determine Project Key from Issue Key (e.g. NDE-123 -> NDE)
    const projectKey = issueKey.split('-')[0];

    // Dynamic Default Repo Lookup
    const defaultRepoEnvVar = `DEFAULT_REPO_${projectKey}`;
    const projectDefaultRepo = process.env[defaultRepoEnvVar];

    // Debug: Log repo lookup attempts
    console.log(`[Repo Lookup] ProjectKey: ${projectKey}, EnvVar: ${defaultRepoEnvVar}, Value: ${projectDefaultRepo}`);

    const repoName = ticketData.customfield_repo || ticketData.repoName || projectDefaultRepo || 'Unigalactix/sample-node-project';

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
        const defaultBranch = await getDefaultBranch(repoName);
        logProgress(`Targeting default branch: ${defaultBranch} `);

        // 2. Generate Workflow
        logProgress(`Generating ${language} workflow for ${repoName}...`);
        const workflowYml = generateWorkflowFile({ language, repoName, buildCommand, testCommand, deployTarget, defaultBranch });
        systemStatus.currentPayload = workflowYml;

        // 3. Create Pull Request (with detailed logs inside githubService -> or we log steps here)
        logProgress(`Initiating Pull Request creation sequence...`);
        const result = await createPullRequestForWorkflow({
            repoName,
            filePath: `.github/workflows/${repoName.split('/')[1] || 'repo'}-ci.yml`,
            content: workflowYml,
            language,
            issueKey, // Pass issueKey for stable branching
            deployTarget, // Pass deploy target for Dockerfile generation logic
            defaultBranch,
            ticketData: { ...ticketData, buildCommand, testCommand, description }
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
            checks: []
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
                    const checks = await getPullRequestChecks({
                        repoName: ticket.repoName,
                        ref: ticket.branch
                    });

                    // Update the check status in history
                    // We need to find the history item and update it (ticket is a reference to history item if pushed directly)
                    ticket.checks = checks;
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

    setTimeout(startPolling, 1000);
});
