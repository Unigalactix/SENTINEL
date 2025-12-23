const https = require('https');
require('dotenv').config();

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEYS = process.env.JIRA_PROJECT_KEY || 'NDE';

const authHeader = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

/**
 * Helper to make Jira API requests
 */
async function jiraRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${JIRA_BASE_URL}${path}`);

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Authorization': authHeader,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch (e) {
                        reject(new Error(`Failed to parse Jira response: ${e.message}`));
                    }
                } else {
                    reject(new Error(`Jira API Error: ${res.statusCode} ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Cache for dynamic project keys to avoid fetching on every poll
let cachedProjectKeys = null;
let lastProjectFetch = 0;
const PROJECT_CACHE_TTL = 1000 * 60 * 60; // Refresh project list every hour

async function getAllProjectKeys() {
    // Return cached keys if valid
    if (cachedProjectKeys && (Date.now() - lastProjectFetch < PROJECT_CACHE_TTL)) {
        return cachedProjectKeys;
    }

    try {
        console.log('[Jira Service] Fetching all available projects...');
        const result = await jiraRequest('/rest/api/3/project');
        if (Array.isArray(result)) {
            const keys = result.map(p => p.key);
            console.log(`[Jira Service] Discovered ${keys.length} projects: ${keys.join(', ')}`);
            cachedProjectKeys = keys.join(',');
            lastProjectFetch = Date.now();
            return cachedProjectKeys;
        }
        return '';
    } catch (error) {
        console.error('[Jira Service] Failed to fetch projects:', error.message);
        return 'NDE'; // Safe fallback
    }
}

/**
 * Fetch pending tickets (Status = 'To Do')
 */
async function getPendingTickets() {
    // Use ENV if available, otherwise fetch dynamically
    let projectKeys = process.env.JIRA_PROJECT_KEY;

    if (!projectKeys) {
        projectKeys = await getAllProjectKeys();
    }

    // JQL: Broad scope for any 'New'/'To Do' items
    const jql = `project IN (${projectKeys}) AND statusCategory = "To Do" ORDER BY priority DESC`;

    try {
        const result = await jiraRequest('/rest/api/3/search/jql', 'POST', {
            jql: jql,
            fields: [
                'summary',
                'description',
                'priority',
                'customfield_repo',
                'customfield_language',
                'customfield_build',
                'customfield_test',
                'customfield_deploy'
            ],
            maxResults: 50
        });
        return result.issues || [];
    } catch (error) {
        console.error('Error fetching Jira tickets:', error.message);
        return [];
    }
}

/**
 * Transition ticket status
 */
async function transitionIssue(issueKey, targetStatusName) {
    try {
        const transitionsData = await jiraRequest(`/rest/api/3/issue/${issueKey}/transitions`);
        const transitions = transitionsData.transitions || [];

        const aliases = {
            'To Do': ['To Do', 'Open', 'Backlog', 'New', 'Reopen'],
            'In Progress': ['In Progress', 'In Dev', 'Active'],
            'Done': ['Done', 'Closed', 'Resolved']
        };
        const targetAliases = aliases[targetStatusName] || [targetStatusName];

        const transition = transitions.find(t =>
            targetAliases.some(alias => t.name.toLowerCase() === alias.toLowerCase())
        );

        if (!transition) {
            console.warn(`Transition "${targetStatusName}" not found for issue ${issueKey}.`);
            return;
        }

        await jiraRequest(`/rest/api/3/issue/${issueKey}/transitions`, 'POST', {
            transition: { id: transition.id }
        });
        console.log(`Transitioned ${issueKey} to "${targetStatusName}"`);
    } catch (error) {
        console.error(`Error transitioning ${issueKey}:`, error.message);
    }
}

/**
 * Add a comment to the issue
 */
async function addComment(issueKey, body) {
    try {
        const adfBody = {
            "version": 1,
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": body
                        }
                    ]
                }
            ]
        };

        await jiraRequest(`/rest/api/3/issue/${issueKey}/comment`, 'POST', {
            body: adfBody
        });
        console.log(`Added comment to ${issueKey}`);
    } catch (error) {
        console.error(`Error commenting on ${issueKey}:`, error.message);
    }
}

/**
 * Fetch full details of a single issue
 */
async function getIssueDetails(issueKey) {
    try {
        console.log(`[Jira Service] Fetching details for ${issueKey}...`);
        const result = await jiraRequest(`/rest/api/3/issue/${issueKey}`);
        return result;
    } catch (error) {
        console.error(`[Jira Service] Error fetching issue ${issueKey}:`, error.message);
        throw error;
    }
}

module.exports = {
    getPendingTickets,
    transitionIssue,
    addComment,
    getAllProjectKeys,
    getIssueDetails
};
