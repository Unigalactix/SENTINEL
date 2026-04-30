const https = require('https');
require('dotenv').config();

const GITHUB_ISSUES_REPO = process.env.GITHUB_ISSUES_REPO;
const GITHUB_ISSUES_LABEL = process.env.GITHUB_ISSUES_LABEL || 'sentinel:todo';

/**
 * Resolve the GitHub token to use for API calls.
 * Mirrors the token resolution pattern used in githubService.js.
 */
function getToken() {
    return process.env.GHUB_TOKEN || null;
}

/**
 * Helper to make GitHub REST API requests.
 */
async function githubRequest(path, method = 'GET', body = null) {
    const token = getToken();
    return new Promise((resolve, reject) => {
        const url = new URL(`https://api.github.com${path}`);

        const headers = {
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'SENTINEL-Agent/1.0',
            'X-GitHub-Api-Version': '2022-11-28'
        };

        if (token) {
            headers['Authorization'] = `token ${token}`;
        }

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: method,
            headers
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch (e) {
                        reject(new Error(`Failed to parse GitHub response: ${e.message}`));
                    }
                } else if (res.statusCode === 204) {
                    resolve({});
                } else {
                    reject(new Error(`GitHub API Error: ${res.statusCode} ${data}`));
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

/**
 * Parse directives from issue body.
 * Supports both bold (**key:** value) and plain (key: value) formats.
 */
function parseBodyDirective(body, key) {
    if (!body || typeof body !== 'string') return null;
    // Match **key:** value or key: value at the start of a line
    const pattern = new RegExp(`^\\*{0,2}${key}\\*{0,2}:\\s*(.+)$`, 'im');
    const match = body.match(pattern);
    return match ? match[1].trim() : null;
}

/**
 * Derive priority name from issue labels.
 */
function derivePriority(labels) {
    if (!Array.isArray(labels)) return 'Medium';
    const names = labels.map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase());
    if (names.some(n => n === 'priority:critical' || n === 'priority:highest')) return 'Highest';
    if (names.some(n => n === 'priority:high')) return 'High';
    if (names.some(n => n === 'priority:low')) return 'Low';
    return 'Medium';
}

/**
 * Map a raw GitHub issue to the shape that server.js understands.
 */
function mapIssue(issue) {
    const body = issue.body || '';
    const labels = issue.labels || [];

    return {
        id: issue.number,
        key: `GH-${issue.number}`,
        fields: {
            summary: issue.title,
            description: body,
            priority: { name: derivePriority(labels) },
            repo: parseBodyDirective(body, 'repo') || parseBodyDirective(body, 'repoName'),
            language: parseBodyDirective(body, 'language'),
            build: parseBodyDirective(body, 'build'),
            test: parseBodyDirective(body, 'test'),
            deploy: parseBodyDirective(body, 'deploy')
        }
    };
}

/**
 * Extract issue number from a "GH-123" key.
 */
function parseIssueNumber(issueKey) {
    const match = String(issueKey).match(/^GH-(\d+)$/i);
    if (!match) throw new Error(`Invalid issue key format: "${issueKey}". Expected GH-<number>.`);
    return parseInt(match[1], 10);
}

/**
 * Fetch open issues with the sentinel:todo label, ordered by priority label then creation date.
 */
async function getPendingTickets() {
    if (!GITHUB_ISSUES_REPO) {
        console.warn('[GitHub Issue Service] GITHUB_ISSUES_REPO is not set. Returning empty list.');
        return [];
    }

    try {
        const label = encodeURIComponent(GITHUB_ISSUES_LABEL);
        const issues = await githubRequest(
            `/repos/${GITHUB_ISSUES_REPO}/issues?state=open&labels=${label}&per_page=50&sort=created&direction=asc`
        );

        if (!Array.isArray(issues)) return [];

        const mapped = issues.map(mapIssue);

        // Sort by priority then creation order (already by creation from API)
        const priorityOrder = { Highest: 0, High: 1, Medium: 2, Low: 3 };
        mapped.sort((a, b) => {
            const pa = priorityOrder[a.fields.priority.name] ?? 2;
            const pb = priorityOrder[b.fields.priority.name] ?? 2;
            return pa - pb;
        });

        return mapped;
    } catch (error) {
        console.error('[GitHub Issue Service] Error fetching pending issues:', error.message);
        return [];
    }
}

/**
 * Transition issue state by manipulating labels:
 * - 'In Progress': remove sentinel:todo, add sentinel:in-progress
 * - 'Done':        remove sentinel:in-progress, close the issue
 * - 'To Do':       remove sentinel:in-progress, add sentinel:todo, reopen if closed
 */
async function transitionIssue(issueKey, targetStatusName) {
    if (!GITHUB_ISSUES_REPO) return;

    const issueNumber = parseIssueNumber(issueKey);

    try {
        // Fetch current labels
        const issue = await githubRequest(`/repos/${GITHUB_ISSUES_REPO}/issues/${issueNumber}`);
        const currentLabels = (issue.labels || []).map(l => l.name);

        let newLabels = [...currentLabels];
        let newState = null;

        if (targetStatusName === 'In Progress') {
            newLabels = newLabels.filter(l => l !== 'sentinel:todo');
            if (!newLabels.includes('sentinel:in-progress')) {
                newLabels.push('sentinel:in-progress');
            }
        } else if (targetStatusName === 'Done') {
            newLabels = newLabels.filter(l => l !== 'sentinel:in-progress' && l !== 'sentinel:todo');
            newState = 'closed';
        } else if (targetStatusName === 'To Do') {
            newLabels = newLabels.filter(l => l !== 'sentinel:in-progress');
            if (!newLabels.includes('sentinel:todo')) {
                newLabels.push('sentinel:todo');
            }
            newState = 'open';
        }

        const updateBody = { labels: newLabels };
        if (newState) updateBody.state = newState;

        await githubRequest(`/repos/${GITHUB_ISSUES_REPO}/issues/${issueNumber}`, 'PATCH', updateBody);
        console.log(`[GitHub Issue Service] Transitioned ${issueKey} to "${targetStatusName}"`);
    } catch (error) {
        console.error(`[GitHub Issue Service] Error transitioning ${issueKey}:`, error.message);
    }
}

/**
 * Post a comment to a GitHub issue.
 * issueKey is in the format "GH-123".
 */
async function addComment(issueKey, body) {
    if (!GITHUB_ISSUES_REPO) return;

    const issueNumber = parseIssueNumber(issueKey);

    try {
        await githubRequest(
            `/repos/${GITHUB_ISSUES_REPO}/issues/${issueNumber}/comments`,
            'POST',
            { body }
        );
        console.log(`[GitHub Issue Service] Added comment to ${issueKey}`);
    } catch (error) {
        console.error(`[GitHub Issue Service] Error commenting on ${issueKey}:`, error.message);
    }
}

/**
 * Return a list of unique repos referenced across all open sentinel:todo issues.
 * Used to replace /api/projects (Jira project list).
 */
async function getProjects() {
    try {
        const issues = await getPendingTickets();
        const repos = new Set();

        if (GITHUB_ISSUES_REPO) {
            repos.add(GITHUB_ISSUES_REPO);
        }

        for (const issue of issues) {
            const repo = issue.fields.repo;
            if (repo) repos.add(repo);
        }

        return Array.from(repos).map(r => ({ key: r, name: r }));
    } catch (error) {
        console.error('[GitHub Issue Service] Failed to fetch projects:', error.message);
        return GITHUB_ISSUES_REPO ? [{ key: GITHUB_ISSUES_REPO, name: GITHUB_ISSUES_REPO }] : [];
    }
}

/**
 * Return GITHUB_ISSUES_REPO for backwards compat with getAllProjectKeys.
 */
async function getAllProjectKeys() {
    return GITHUB_ISSUES_REPO || '';
}

/**
 * Fetch full details of a single issue by key ("GH-123").
 * Returns the same shape as getPendingTickets() items.
 */
async function getIssueDetails(issueKey) {
    if (!GITHUB_ISSUES_REPO) throw new Error('GITHUB_ISSUES_REPO is not set');

    const issueNumber = parseIssueNumber(issueKey);

    try {
        console.log(`[GitHub Issue Service] Fetching details for ${issueKey}...`);
        const issue = await githubRequest(`/repos/${GITHUB_ISSUES_REPO}/issues/${issueNumber}`);
        return mapIssue(issue);
    } catch (error) {
        console.error(`[GitHub Issue Service] Error fetching issue ${issueKey}:`, error.message);
        throw error;
    }
}

/**
 * Search issues by a text query (title/body match).
 */
async function searchIssues(query) {
    if (!GITHUB_ISSUES_REPO) return [];

    try {
        const q = encodeURIComponent(`${query} repo:${GITHUB_ISSUES_REPO} is:issue`);
        const result = await githubRequest(`/search/issues?q=${q}&per_page=10`);
        const items = result.items || [];
        return items.map(mapIssue);
    } catch (error) {
        console.error('[GitHub Issue Service] Error searching issues:', error.message);
        return [];
    }
}

/**
 * Create a new GitHub issue in the issues repo.
 */
async function createIssue(repo, title, body, options = {}) {
    const targetRepo = repo || GITHUB_ISSUES_REPO;
    if (!targetRepo) throw new Error('No target repo specified for createIssue');

    try {
        const issueBody = {
            title,
            body: body || '',
        };

        if (options.labels && Array.isArray(options.labels)) {
            issueBody.labels = options.labels;
        } else {
            issueBody.labels = [GITHUB_ISSUES_LABEL];
        }

        if (options.priorityName) {
            const priorityLabel = `priority:${options.priorityName.toLowerCase()}`;
            if (!issueBody.labels.includes(priorityLabel)) {
                issueBody.labels.push(priorityLabel);
            }
        }

        const result = await githubRequest(`/repos/${targetRepo}/issues`, 'POST', issueBody);
        console.log(`[GitHub Issue Service] Created issue: GH-${result.number}`);
        return mapIssue(result);
    } catch (error) {
        console.error('[GitHub Issue Service] Error creating issue:', error.message);
        throw error;
    }
}

/**
 * Update title/body of an existing issue.
 */
async function updateIssue(issueKey, fields) {
    if (!GITHUB_ISSUES_REPO) throw new Error('GITHUB_ISSUES_REPO is not set');

    const issueNumber = parseIssueNumber(issueKey);

    try {
        const updateBody = {};
        if (fields.summary !== undefined) updateBody.title = fields.summary;
        if (fields.description !== undefined) updateBody.body = fields.description;

        await githubRequest(
            `/repos/${GITHUB_ISSUES_REPO}/issues/${issueNumber}`,
            'PATCH',
            updateBody
        );
        console.log(`[GitHub Issue Service] Updated issue: ${issueKey}`);
        return true;
    } catch (error) {
        console.error(`[GitHub Issue Service] Error updating issue ${issueKey}:`, error.message);
        throw error;
    }
}

/**
 * Fetch recent closed issues (equivalent of getInspectionTickets).
 * Returns last 10 issues with label sentinel:failed or recently closed.
 */
async function getInspectionTickets() {
    if (!GITHUB_ISSUES_REPO) return [];

    try {
        // Try to get issues labeled sentinel:failed first
        const failedLabel = encodeURIComponent('sentinel:failed');
        let issues = [];

        try {
            const failedIssues = await githubRequest(
                `/repos/${GITHUB_ISSUES_REPO}/issues?state=all&labels=${failedLabel}&per_page=10&sort=updated&direction=desc`
            );
            if (Array.isArray(failedIssues)) {
                issues = failedIssues;
            }
        } catch (e) {
            // label may not exist yet
        }

        // If fewer than 10, pad with recently closed
        if (issues.length < 10) {
            try {
                const closedIssues = await githubRequest(
                    `/repos/${GITHUB_ISSUES_REPO}/issues?state=closed&per_page=10&sort=updated&direction=desc`
                );
                if (Array.isArray(closedIssues)) {
                    // Merge, deduplicate by number
                    const existing = new Set(issues.map(i => i.number));
                    for (const ci of closedIssues) {
                        if (!existing.has(ci.number)) {
                            issues.push(ci);
                            existing.add(ci.number);
                        }
                        if (issues.length >= 10) break;
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        return issues.slice(0, 10).map(mapIssue);
    } catch (error) {
        console.error('[GitHub Issue Service] Error fetching inspection tickets:', error.message);
        return [];
    }
}

module.exports = {
    getPendingTickets,
    transitionIssue,
    addComment,
    getAllProjectKeys,
    getIssueDetails,
    createIssue,
    getProjects,
    searchIssues,
    updateIssue,
    getInspectionTickets
};
