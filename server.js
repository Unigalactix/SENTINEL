const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    generateWorkflowFile,
    createPullRequestForWorkflow,
    detectRepoLanguage,
    getRepoInstructions,
    analyzeRepoStructure,
    getDefaultBranch,
    findCopilotSubPR,
    markPullRequestReadyForReview,
    enablePullRequestAutoMerge,
    approvePullRequest,
    getActiveOrgPRsWithGHKeys,
    listRepoSecrets,
    // Per-user auth functions
    getOctokit,
    checkAppInstallation, // [NEW]
    checkCopilotStatus    // [NEW]
} = require('./src/services/githubService');
const githubService = require('./src/services/githubService');
const { getPendingTickets, transitionIssue, addComment, getIssueDetails, getInspectionTickets, createIssue } = require('./src/services/githubIssueService');
const llmService = require('./src/services/llmService'); // [NEW]
const { runWithUserToken } = require('./src/services/tokenContext');
const { isRepoAllowed } = require('./src/utils/repoPolicy');
require('dotenv').config();

// Fail closed: a production deployment must never run with the well-known
// fallback session secret (or a weak/missing one), because anyone who knows
// it can forge session cookies.
if (process.env.NODE_ENV === 'production') {
    const sessionSecret = process.env.SESSION_SECRET || '';
    if (!sessionSecret || sessionSecret === 'sentinel-dev-secret-change-in-prod' || sessionSecret.length < 16) {
        console.error('[Security] SESSION_SECRET is missing, set to the known fallback value, or shorter than 16 characters. Refusing to start in production. Set a strong SESSION_SECRET environment variable.');
        process.exit(1);
    }
}

// Load optional per-board POST_PR_STATUS mapping
const BOARD_POST_PR_STATUS_PATH = path.join(__dirname, 'config', 'board_post_pr_status.json');
let boardPostPrStatus = {};
try {
    if (fs.existsSync(BOARD_POST_PR_STATUS_PATH)) {
        boardPostPrStatus = JSON.parse(fs.readFileSync(BOARD_POST_PR_STATUS_PATH, 'utf8'));
        console.log('[Config] Loaded board_post_pr_status.json');
    }
} catch (e) {
    console.warn('[Config] Failed to load board_post_pr_status.json:', e.message);
    boardPostPrStatus = {};
}

function getPostPrStatusForIssue(issue) {
    // Allow operators to override the post-PR status per repo via the
    // optional config file (config/board_post_pr_status.json), which is
    // keyed by target repo full name (owner/repo) — looked up first from
    // the issue.fields.repo value, then the GITHUB_ISSUES_REPO env var.
    const repoFromIssue = issue?.fields?.repo;
    const repoFromEnv = process.env.GITHUB_ISSUES_REPO;
    const keys = [repoFromIssue, repoFromEnv].filter(Boolean);
    for (const k of keys) {
        if (boardPostPrStatus && Object.prototype.hasOwnProperty.call(boardPostPrStatus, k)) {
            return boardPostPrStatus[k];
        }
    }
    return process.env.POST_PR_STATUS || 'In Progress';
}

const app = express();
const PORT = process.env.PORT || 3000;
const USE_GH_COPILOT = process.env.USE_GH_COPILOT === 'true';
const { execFile, spawn } = require('child_process');

// In-memory store for UI
let systemStatus = {
    activeTickets: [],
    monitoredTickets: [], // Tickets we are watching for CI updates
    processedCount: 0,
    scanHistory: [],
    currentPhase: 'Initializing', // 'Scanning', 'Processing', 'Waiting'
    currentTicketKey: null,
    currentTicketLogs: [],     // New: Array of log strings for the active ticket
    currentIssueUrl: null,      // URL to the current GitHub Issue
    currentPrUrl: null,        // New: URL to created PR
    currentPayload: null,      // New: Generated YAML content
    nextScanTime: null,
    paused: false,             // Pause state (kept for compatibility)
    systemLogs: []             // Global system log stream for UI terminal
    // NOTE: OAuth tokens must NEVER be stored on systemStatus — this object
    // backs API responses. Per-user tokens live only on the server-side
    // agent objects in activeAgents (see registerAgent).
};

// --- MULTI-TENANT AGENT SYSTEM ---
// Map of userId -> agent context
const activeAgents = new Map();

/**
 * Register or update an agent for a logged-in user
 * @param {object} user - User object with id, login, name, avatar_url
 * @param {string} token - OAuth access token
 * @param {boolean} hasCopilot - Whether user has Copilot access
 * @param {object} [options] - Server-side-only auth material
 * @param {string|null} [options.refreshToken] - OAuth refresh token (never serialized to clients)
 * @param {number|null} [options.tokenExpiresAt] - Access-token expiry (ms since epoch)
 * @returns {object} The agent object
 */
function registerAgent(user, token, hasCopilot = false, options = {}) {
    const existing = activeAgents.get(user.id);
    const agent = {
        userId: user.id,
        token: token,
        // Server-side only: refresh material for background token refresh.
        // The sanitized DTO builders for /api/status must never spread the
        // raw agent object, so these fields cannot leak to clients.
        refreshToken: options.refreshToken !== undefined ? options.refreshToken : (existing?.refreshToken || null),
        tokenExpiresAt: options.tokenExpiresAt !== undefined ? options.tokenExpiresAt : (existing?.tokenExpiresAt || null),
        user: {
            id: user.id,
            login: user.login,
            name: user.name,
            avatar_url: user.avatar_url,
            copilot_enabled: hasCopilot
        },
        tickets: existing?.tickets || [],      // Preserve tickets if refreshing
        logs: existing?.logs || [],           // Preserve logs if refreshing
        lastActivity: Date.now(),
        registeredAt: existing?.registeredAt || Date.now()
    };
    activeAgents.set(user.id, agent);
    console.log(`[Agents] Registered agent for ${user.login} (${activeAgents.size} total agents)`);
    return agent;
}

/**
 * Remove an agent when user logs out
 * @param {string|number} userId 
 */
function removeAgent(userId) {
    const agent = activeAgents.get(userId);
    if (agent) {
        console.log(`[Agents] Removed agent for ${agent.user.login}`);
        activeAgents.delete(userId);
    }
}

/**
 * Get agent for a user ID
 * @param {string|number} userId 
 * @returns {object|null}
 */
function getAgent(userId) {
    return activeAgents.get(userId) || null;
}

/**
 * Cleanup stale agents (no activity for 1 hour)
 */
function cleanupStaleAgents() {
    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    for (const [userId, agent] of activeAgents) {
        if (now - agent.lastActivity > ONE_HOUR) {
            console.log(`[Agents] Cleaning up stale agent for ${agent.user.login}`);
            activeAgents.delete(userId);
        }
    }
}

// Run stale agent cleanup every 15 minutes
setInterval(cleanupStaleAgents, 15 * 60 * 1000);

// Cache for detected repository languages
const repoLanguageCache = new Map();


// Ensure logs directory exists
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

// --- State persistence (Fix #13) -----------------------------------------
// Survive a restart so `monitoredTickets`, `scanHistory`, and `paused` aren't
// silently dropped while jobs are in flight. We persist a small JSON document
// next to the log file with a short debounce.
const STATE_FILE = path.join(LOG_DIR, 'sentinel-state.json');
let _stateSaveTimer = null;

function loadPersistedState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.monitoredTickets)) {
            systemStatus.monitoredTickets = data.monitoredTickets;
        }
        if (Array.isArray(data.scanHistory)) {
            systemStatus.scanHistory = data.scanHistory;
        }
        if (typeof data.paused === 'boolean') {
            systemStatus.paused = data.paused;
        }
        if (typeof data.processedCount === 'number') {
            systemStatus.processedCount = data.processedCount;
        }
        console.log(`[State] Restored ${systemStatus.monitoredTickets.length} monitored / ${systemStatus.scanHistory.length} history entries from ${STATE_FILE}`);
    } catch (e) {
        console.warn('[State] Failed to load persisted state:', e.message);
    }
}

function persistStateNow() {
    try {
        const snapshot = {
            monitoredTickets: systemStatus.monitoredTickets || [],
            scanHistory: (systemStatus.scanHistory || []).slice(0, 100), // cap to last 100
            paused: !!systemStatus.paused,
            processedCount: systemStatus.processedCount || 0,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (e) {
        console.warn('[State] Failed to persist state:', e.message);
    }
}

function schedulePersistState() {
    // Debounce — collapse rapid mutations into one disk write.
    if (_stateSaveTimer) return;
    _stateSaveTimer = setTimeout(() => {
        _stateSaveTimer = null;
        persistStateNow();
    }, 1500);
}

// Persist on shutdown so in-flight state survives a normal restart.
process.on('SIGINT', () => { persistStateNow(); process.exit(0); });
process.on('SIGTERM', () => { persistStateNow(); process.exit(0); });

// Also flush periodically as a safety net for crashes.
setInterval(persistStateNow, 30_000).unref();

function writeLog(message) {
    const logFile = path.join(LOG_DIR, 'server.log');
    const timestamp = new Date().toISOString();
    const cleanMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logFile, cleanMessage, (err) => {
        if (err) console.error('Failed to write to log file:', err);
    });

    // Also keep an in-memory rolling buffer for the UI terminal
    try {
        if (!Array.isArray(systemStatus.systemLogs)) {
            systemStatus.systemLogs = [];
        }
        systemStatus.systemLogs.push(cleanMessage.trimEnd());
        // Keep last 200 lines to avoid unbounded growth
        if (systemStatus.systemLogs.length > 200) {
            systemStatus.systemLogs.splice(0, systemStatus.systemLogs.length - 200);
        }
    } catch (e) {
        // Never let logging crash the app
    }
}

const session = require('express-session');
const authService = require('./src/services/authService');

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// --- Security headers ---
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// --- Simple in-memory rate limiter for POST /api/* ---
// Max 300 POST requests per 15 minutes per IP; 429 JSON beyond that.
const postRateLimitBuckets = new Map();
const POST_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const POST_RATE_LIMIT_MAX = 300;
app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.path.startsWith('/api/')) return next();
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let bucket = postRateLimitBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= POST_RATE_LIMIT_WINDOW_MS) {
        bucket = { windowStart: now, count: 0 };
        postRateLimitBuckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > POST_RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
});

// Trust the first proxy hop (Heroku, Azure App Service, NGINX, etc.) so the
// secure cookie flag works correctly when terminating TLS upstream.
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}
app.use(session({
    secret: process.env.SESSION_SECRET || 'sentinel-dev-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
        // Honor a trusted reverse proxy in production (req.secure works after app.set('trust proxy'))
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// --- Authorization helpers ---
/**
 * Constant-time comparison for the internal-token header. Returns false
 * unless both values are non-empty strings of equal length.
 */
function internalTokenMatches(provided) {
    const expected = process.env.SENTINEL_INTERNAL_TOKEN || '';
    if (!provided || !expected) return false;
    const providedBuf = Buffer.from(String(provided), 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Shared authorization test used by requireAuth and by /api/status (which
 * must degrade gracefully instead of returning 401).
 */
function isAuthorizedRequest(req) {
    if (req.session?.user) return true;
    try {
        if (authService.getAuthConfig().hasGitHubApp) return true;
    } catch (_) { /* treat config errors as unauthenticated */ }
    if (internalTokenMatches(req.get('x-sentinel-internal-token'))) return true;
    if (process.env.NODE_ENV !== 'production') return true;
    return false;
}

/**
 * Auth guard for API routes. Allows: a logged-in session user, GitHub App
 * (server-credential) mode, a valid x-sentinel-internal-token header, or
 * any request in non-production (dev) mode.
 */
function requireAuth(req, res, next) {
    if (isAuthorizedRequest(req)) return next();
    return res.status(401).json({ error: 'Authentication required' });
}

// --- OAuth Token Refresh Helpers ---
/**
 * Ensure the current session's access token is fresh.
 * Returns the (possibly refreshed) access token string.
 */
async function getFreshSessionAccessToken(req) {
    if (!req.session) return null;

    const currentToken = req.session.accessToken;
    const refreshToken = req.session.refreshToken;
    const expiresAt = req.session.accessTokenExpiresAt;

    if (!currentToken) return null;

    // If we don't have expiry metadata or a refresh token, just return what we have
    if (!expiresAt || !refreshToken) {
        return currentToken;
    }

    const now = Date.now();
    // Refresh if token is expired or about to expire within 60 seconds
    if (now < expiresAt - 60000) {
        return currentToken;
    }

    try {
        const refreshed = await authService.refreshAccessToken(refreshToken);
        const newExpiresAt = refreshed.expiresIn
            ? Date.now() + (refreshed.expiresIn * 1000)
            : null;

        req.session.accessToken = refreshed.accessToken;
        req.session.refreshToken = refreshed.refreshToken || refreshToken;
        req.session.accessTokenExpiresAt = newExpiresAt;

        // Keep this user's server-side agent in sync so background work
        // uses the refreshed token too.
        if (req.session.user) {
            registerAgent(req.session.user, refreshed.accessToken, req.session.user.copilot_enabled, {
                refreshToken: refreshed.refreshToken || refreshToken,
                tokenExpiresAt: newExpiresAt
            });
        }

        console.log('[Auth] Access token refreshed successfully for current session');
        return refreshed.accessToken;
    } catch (e) {
        console.error('[Auth] Failed to refresh access token:', e.message);
        return currentToken;
    }
}

/**
 * Refresh one agent's access token if it is expired or about to expire,
 * using the refresh token stored on the agent at login. Safe no-op when
 * the agent has no refresh material or its token is still valid. Call
 * this for each agent before background work runs under its token.
 * @param {object} agent - Agent object from activeAgents
 */
async function refreshAgentToken(agent) {
    if (!agent || !agent.token || !agent.refreshToken || !agent.tokenExpiresAt) return;

    const now = Date.now();
    if (now < agent.tokenExpiresAt - 60000) {
        return; // still valid
    }

    try {
        const refreshed = await authService.refreshAccessToken(agent.refreshToken);
        const newExpiresAt = refreshed.expiresIn
            ? Date.now() + (refreshed.expiresIn * 1000)
            : null;

        registerAgent(agent.user, refreshed.accessToken, agent.user.copilot_enabled, {
            refreshToken: refreshed.refreshToken || agent.refreshToken,
            tokenExpiresAt: newExpiresAt
        });

        console.log(`[Auth] Access token refreshed successfully for agent ${agent.user.login}`);
    } catch (e) {
        console.error(`[Auth] Failed to refresh access token for agent ${agent.user?.login || agent.userId}:`, e.message);
    }
}

app.use(express.static('public')); // Serve UI

// --- Authentication Endpoints ---
app.get('/api/auth/status', (req, res) => {
    const config = authService.getAuthConfig();
    if (req.session && req.session.user) {
        return res.json({
            authenticated: true,
            user: req.session.user,
            authMethod: req.session.authMethod || 'oauth',
            hasOAuth: config.hasOAuth,
            hasGitHubApp: config.hasGitHubApp
        });
    }
    // Check if GitHub App is configured (no login needed)
    if (config.hasGitHubApp) {
        return res.json({
            authenticated: true,
            authMethod: 'github-app',
            user: { login: 'Sentinel [bot]', type: 'Bot' },
            hasOAuth: config.hasOAuth,
            hasGitHubApp: config.hasGitHubApp
        });
    }
    return res.json({
        authenticated: false,
        hasOAuth: config.hasOAuth,
        hasGitHubApp: config.hasGitHubApp
    });
});

app.get('/api/auth/login', (req, res) => {
    const config = authService.getAuthConfig();
    if (!config.hasOAuth) {
        return res.status(400).json({ error: 'OAuth not configured. Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.' });
    }
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
    // CSRF protection: generate a fresh state, keep it in the session, and
    // require the callback to present the same value.
    const state = authService.generateState();
    if (req.session) {
        req.session.oauthState = state;
    }
    const authUrl = authService.getAuthorizationUrl(redirectUri, state);
    res.redirect(authUrl);
});

app.get('/api/auth/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (error) {
        return res.redirect('/?error=' + encodeURIComponent(error));
    }

    if (!code) {
        return res.redirect('/?error=missing_code');
    }

    // Verify the OAuth state against the value stored at login (CSRF check).
    const expectedState = req.session?.oauthState;
    if (req.session) {
        delete req.session.oauthState;
    }
    if (!state || !expectedState || state !== expectedState) {
        console.warn('[Auth] OAuth callback rejected: state mismatch');
        return res.redirect('/?error=invalid_state');
    }

    try {
        const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
        const tokenData = await authService.exchangeCodeForToken(code, redirectUri);
        const user = await authService.getGitHubUser(tokenData.accessToken);

        // Compute expiry timestamp if GitHub provided expiresIn
        const accessTokenExpiresAt = tokenData.expiresIn
            ? Date.now() + (tokenData.expiresIn * 1000)
            : null;

        // Store in session
        req.session.user = {
            id: user.id,
            login: user.login,
            name: user.name,
            avatar_url: user.avatar_url
        };
        req.session.accessToken = tokenData.accessToken;
        req.session.refreshToken = tokenData.refreshToken || null;
        req.session.accessTokenExpiresAt = accessTokenExpiresAt;
        req.session.authMethod = 'oauth';

        // [NEW] Check if the user has installed the GitHub App
        const isInstalled = await checkAppInstallation(tokenData.accessToken);

        // [NEW] Check for Copilot Plan
        const hasCopilot = await checkCopilotStatus(tokenData.accessToken);

        console.log(`[Auth] User ${user.login} logged in via OAuth (App Installed: ${isInstalled}, Copilot: ${hasCopilot})`);

        // Store Copilot status in session
        req.session.user.copilot_enabled = hasCopilot;

        // Register the agent in the multi-tenant system. The access token
        // lives on the session and on this server-side agent object only —
        // never on systemStatus, which backs API responses.
        const agent = registerAgent(user, tokenData.accessToken, hasCopilot, {
            refreshToken: tokenData.refreshToken || null,
            tokenExpiresAt: accessTokenExpiresAt
        });
        req.session.agentId = agent.userId;

        console.log(`[DEBUG] isInstalled type: ${typeof isInstalled}, value: ${isInstalled}`);

        if (isInstalled === false) {
            console.log('[DEBUG] User has NOT installed the app. Redirecting to installation...');
            // Redirect to App Installation page
            const installUrl = authService.getInstallationUrl();
            console.log(`[DEBUG] Install URL: ${installUrl}`);
            return res.redirect(installUrl);
        }

        console.log('[DEBUG] App is installed (or check passed). Redirecting to Dashboard.');
        res.redirect('/');
    } catch (err) {
        console.error('[Auth] OAuth callback error:', err.message);
        res.redirect('/?error=' + encodeURIComponent(err.message));
    }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
    if (req.session) {
        const userId = req.session.user?.id;
        const userLogin = req.session.user?.login || 'Unknown';

        // [NEW] Remove agent from multi-tenant system
        if (userId) {
            removeAgent(userId);
        }

        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to logout' });
            }
            // Only this user's agent was removed above; other users'
            // agents and tokens are unaffected.
            console.log(`[Auth] User ${userLogin} logged out - agent removed`);
            res.json({ message: 'Logged out successfully' });
        });
    } else {
        res.json({ message: 'No session to destroy' });
    }
});

app.get('/api/auth/install', (req, res) => {
    res.redirect(authService.getInstallationUrl());
});

// --- Optional: GH Copilot Suggest Integration ---
app.post('/api/copilot/suggest', requireAuth, async (req, res) => {
    if (!USE_GH_COPILOT) {
        return res.status(400).json({ error: 'GH Copilot integration disabled. Set USE_GH_COPILOT=true' });
    }

    // gh copilot suggest does not support --message/--filename; call plain suggest
    const args = ['copilot', 'suggest'];

    // Use the current session's token only (refreshed if needed) — never
    // another user's token.
    const userToken = await getFreshSessionAccessToken(req);
    const env = { ...process.env };
    if (userToken) {
        env.GITHUB_TOKEN = userToken;
    }

    execFile('gh', args, { cwd: process.cwd(), env }, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: error.message, stderr });
        }
        res.json({ output: stdout, stderr });
    });
});

// --- API for UI ---
// Sanitized agent DTO builders. These pick explicit fields only — the raw
// agent object carries OAuth tokens and must never be spread or serialized.
function sanitizeAgentUser(agent) {
    if (!agent?.user) return null;
    return {
        id: agent.user.id,
        login: agent.user.login,
        name: agent.user.name,
        avatar_url: agent.user.avatar_url,
        copilot_enabled: agent.user.copilot_enabled
    };
}

function sanitizeMyAgent(agent) {
    if (!agent) return null;
    return {
        userId: agent.userId,
        user: sanitizeAgentUser(agent),
        tickets: agent.tickets,
        logs: agent.logs,
        lastActivity: agent.lastActivity
    };
}

function sanitizeAllAgents() {
    const allAgents = [];
    for (const agent of activeAgents.values()) {
        allAgents.push({
            userId: agent.userId,
            login: agent.user.login,
            name: agent.user.name,
            avatar_url: agent.user.avatar_url,
            copilot_enabled: agent.user.copilot_enabled,
            ticketCount: agent.tickets?.length || 0,
            lastActivity: agent.lastActivity
        });
    }
    return allAgents;
}

app.get('/api/status', (req, res) => {
    // The public page polls this endpoint, so it must not 401. Authorized
    // callers get the full status; unauthenticated production callers get
    // the same shape with empty/default values. Neither variant ever
    // contains a token or refresh token.
    if (!isAuthorizedRequest(req)) {
        return res.json({
            authenticated: false,
            currentPhase: 'Ready',
            currentTicketKey: null,
            currentTicketLogs: [],
            currentIssueUrl: null,
            currentPrUrl: null,
            currentPayload: null,
            nextScanTime: null,
            paused: false,
            processedCount: 0,
            activeTickets: [],
            monitoredTickets: [],
            scanHistory: [],
            systemLogs: [],
            activeUser: null,
            myAgent: null,
            allAgents: [],
            activeAgentsCount: 0
        });
    }

    // Get the current user's agent if logged in
    const userId = req.session?.user?.id;
    const myAgent = userId ? getAgent(userId) : null;

    // Update agent's last activity timestamp
    if (myAgent) {
        myAgent.lastActivity = Date.now();
    }

    // The active user for the UI: prefer the session user's agent, then the
    // session user itself. Sanitized either way — no tokens.
    const sessionUser = req.session?.user || null;
    const activeUser = myAgent
        ? sanitizeAgentUser(myAgent)
        : (sessionUser ? {
            id: sessionUser.id,
            login: sessionUser.login,
            name: sessionUser.name,
            avatar_url: sessionUser.avatar_url,
            copilot_enabled: sessionUser.copilot_enabled
        } : null);

    // Explicit DTO — never spread systemStatus (it must stay free of
    // secrets, and an allowlist keeps it that way if fields are added).
    res.json({
        currentPhase: systemStatus.currentPhase,
        currentTicketKey: systemStatus.currentTicketKey,
        currentTicketLogs: systemStatus.currentTicketLogs,
        currentIssueUrl: systemStatus.currentIssueUrl,
        currentPrUrl: systemStatus.currentPrUrl,
        currentPayload: systemStatus.currentPayload,
        nextScanTime: systemStatus.nextScanTime,
        paused: systemStatus.paused,
        processedCount: systemStatus.processedCount,
        activeTickets: systemStatus.activeTickets,
        monitoredTickets: systemStatus.monitoredTickets,
        scanHistory: systemStatus.scanHistory,
        systemLogs: systemStatus.systemLogs,
        activeUser,
        myAgent: sanitizeMyAgent(myAgent),
        allAgents: sanitizeAllAgents(),
        activeAgentsCount: activeAgents.size
    });
});

// Return GitHub Issues source info to the frontend
app.get('/api/issues-source', requireAuth, (req, res) => {
    res.json({ source: 'github', repo: process.env.GITHUB_ISSUES_REPO });
});

// Deprecated alias for /api/jira-base-url — kept for backwards compat
app.get('/api/jira-base-url', requireAuth, (req, res) => {
    res.json({ source: 'github', repo: process.env.GITHUB_ISSUES_REPO });
});

// List monitored GitHub repositories (from GitHub Issues)
app.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const { getProjects } = require('./src/services/githubIssueService');
        const freshToken = await getFreshSessionAccessToken(req);
        const projectList = freshToken
            ? await runWithUserToken(freshToken, () => getProjects())
            : await getProjects();
        const projects = projectList.map(p => p.key || p);
        res.json({ projects });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual Poll Trigger
app.post('/api/poll', requireAuth, (req, res) => {
    console.log('[API] Manual scan triggered...');
    if (global.forcePoll && typeof global.forcePoll === 'function') {
        // Don't allow concurrent scans
        if (systemStatus.currentPhase === 'Scanning' || systemStatus.currentPhase === 'Processing') {
            return res.json({ message: 'Scan already in progress', phase: systemStatus.currentPhase });
        }
        global.forcePoll();
        return res.json({ message: 'Scan triggered successfully' });
    } else {
        return res.status(503).json({ message: 'Scan function not ready yet' });
    }
});

// --- API for Config (Secrets) ---
// Only these keys may be written through the runtime config endpoint.
const CONFIG_ALLOWLIST = new Set([
    'GITHUB_ISSUES_REPO',
    'ISSUE_LABEL',
    'DEFAULT_REPO',
    'ALLOWED_ORGS',
    'ALLOWED_REPOS',
    'GHUB_ORG',
    'GHUB_TOKEN',
    'LLM_API_KEY',
    'LLM_ENDPOINT',
    'LLM_MODEL',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
    'USE_GH_COPILOT',
    'POST_PR_STATUS'
]);

app.post('/api/config', requireAuth, (req, res) => {
    // Editing .env at runtime is only supported in non-production environments.
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Runtime config editing is disabled in production.' });
    }

    const secrets = req.body; // Expect { GITHUB_ISSUES_REPO: "...", ... }

    if (!secrets || typeof secrets !== 'object' || Object.keys(secrets).length === 0) {
        return res.status(400).json({ error: 'No configuration provided' });
    }

    // Reject unknown keys — this endpoint must not become a generic
    // environment-variable writer.
    const unknownKeys = Object.keys(secrets).filter(k => !CONFIG_ALLOWLIST.has(k));
    if (unknownKeys.length > 0) {
        return res.status(400).json({ error: `Configuration keys not allowed: ${unknownKeys.join(', ')}` });
    }

    // Reject values that could break out of the double-quoted .env format
    // (embedded quotes, backslashes, or newlines would corrupt/inject
    // entries). Accepted values are written wrapped in double quotes.
    for (const [key, value] of Object.entries(secrets)) {
        const str = String(value);
        if (str.includes('"') || str.includes('\\') || str.includes('\n') || str.includes('\r')) {
            return res.status(400).json({ error: `Invalid value for ${key}: values must not contain double quotes, backslashes, or newlines` });
        }
        secrets[key] = str;
    }

    try {
        const envPath = path.join(__dirname, '.env');
        let envContent = '';

        // Read existing .env if it exists
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        const lines = envContent.split('\n');
        const newLines = [];
        const keysUpdated = new Set();

        // Update existing keys
        lines.forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                if (secrets[key] !== undefined) {
                    newLines.push(`${key}="${secrets[key]}"`); // wrap in quotes for safety
                    keysUpdated.add(key);
                } else {
                    newLines.push(line);
                }
            } else {
                newLines.push(line);
            }
        });

        // Append new keys
        Object.keys(secrets).forEach(key => {
            if (!keysUpdated.has(key)) {
                newLines.push(`${key}="${secrets[key]}"`);
            }
            // Update process.env in memory immediately
            process.env[key] = secrets[key];
        });

        fs.writeFileSync(envPath, newLines.join('\n'));
        console.log('[Config] Secrets updated and saved to .env');
        res.json({ message: 'Configuration saved successfully' });
    } catch (e) {
        console.error('[Config] Failed to save .env:', e);
        res.status(500).json({ error: `Failed to save config: ${e.message}` });
    }
});

// --- API for Pause/Resume ---
app.post('/api/pause', requireAuth, (req, res) => {
    const { paused } = req.body;
    if (typeof paused !== 'boolean') {
        return res.status(400).json({ error: 'paused boolean is required' });
    }
    systemStatus.paused = paused;
    console.log(`[API] System ${paused ? 'PAUSED' : 'RESUMED'}`);
    logProgress(`System ${paused ? 'PAUSED' : 'RESUMED'} by user.`);
    schedulePersistState();
    res.json({ message: `System ${paused ? 'paused' : 'resumed'}`, paused: systemStatus.paused });
});

// --- On-Demand MCP Inspector ---
app.post('/api/inspector', requireAuth, (req, res) => {
    // The MCP Inspector is a developer tool that shells out to npx and
    // attempts to open a browser. This is not suitable for production
    // container environments, so we guard it behind NODE_ENV.
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'MCP Inspector is disabled in production.' });
    }

    console.log('[API] Launching MCP Inspector on demand...');
    try {
        const { spawn } = require('child_process');

        // Use npx.cmd on windows, npx on linux/mac
        const npmCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const nodeExe = process.execPath;
        const serverPath = require('path').join(__dirname, 'mcpServer.js');

        // Note: shell:false is safer if we don't need shell features. 
        // npx.cmd is an executable (batch) so it runs fine.
        // We pass arguments as array.
        // We do NOT use 'inherit' for stdio because we want to capture it or just let it run detached?
        // Actually, if we want the user to see the URL in server console, inherit is good.
        // But npx will open the browser automatically, so the user sees the UI.

        const inspector = spawn(npmCmd, ['-y', '@modelcontextprotocol/inspector', nodeExe, serverPath], {
            cwd: __dirname,
            shell: false, // Try false to avoid quoting hell, npx.cmd should handle it
            stdio: 'inherit',
            env: { ...process.env } // Don't force PORT, let it find a free one and open browser
        });

        inspector.on('error', (err) => {
            console.error('[MCP] Failed to launch inspector:', err);
        });

        res.json({ message: 'Inspector launched. Check your browser.' });
    } catch (e) {
        console.error('[MCP] Error triggering inspector:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Download Logs Endpoint ---
app.get('/api/logs/download', requireAuth, (req, res) => {
    const logFile = path.join(LOG_DIR, 'server.log');
    if (fs.existsSync(logFile)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `server_${timestamp}.log`;
        res.download(logFile, filename, (err) => {
            if (err) {
                console.error('[API] Error downloading log file:', err);
                if (!res.headersSent) {
                    res.status(500).send('Error downloading file');
                }
            }
        });
    } else {
        res.status(404).send('Log file not found');
    }
});

// --- Helper: Log Progress ---
function logProgress(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message} `;
    console.log(logEntry);
    systemStatus.currentTicketLogs.push(logEntry);
    writeLog(message);
}

// --- API for Repos (Per-User) ---
app.get('/api/repos', requireAuth, async (req, res) => {
    try {
        // Use user's OAuth token if logged in (refreshing if needed), otherwise fallback to app auth
        const userToken = await getFreshSessionAccessToken(req);
        const octokit = getOctokit(userToken);

        // Fetch repos accessible to the authenticated user
        const repos = [];
        try {
            const { data } = await octokit.repos.listForAuthenticatedUser({
                per_page: 100,
                sort: 'updated'
            });
            repos.push(...data.map(r => ({
                full_name: r.full_name,
                name: r.name,
                owner: r.owner.login,
                private: r.private,
                description: r.description,
                language: r.language,
                updated_at: r.updated_at
            })));
        } catch (e) {
            console.log('[API] Failed to list user repos:', e.message);
        }

        // Also try org repos if ALLOWED_ORGS is set
        const allowedOrgs = (process.env.ALLOWED_ORGS || '').split(',').map(o => o.trim()).filter(Boolean);
        for (const org of allowedOrgs) {
            try {
                const { data } = await octokit.repos.listForOrg({
                    org,
                    per_page: 100,
                    sort: 'updated'
                });
                repos.push(...data.map(r => ({
                    full_name: r.full_name,
                    name: r.name,
                    owner: r.owner.login,
                    private: r.private,
                    description: r.description,
                    language: r.language,
                    updated_at: r.updated_at
                })));
            } catch (e) {
                console.log(`[API] Failed to list org ${org} repos:`, e.message);
            }
        }

        // Deduplicate by full_name
        const uniqueRepos = [...new Map(repos.map(r => [r.full_name, r])).values()];
        res.json(uniqueRepos);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API for Inspection ---
app.get('/api/inspections', requireAuth, async (req, res) => {
    try {
        const freshToken = await getFreshSessionAccessToken(req);
        const tickets = freshToken
            ? await runWithUserToken(freshToken, () => getInspectionTickets())
            : await getInspectionTickets();
        res.json({ tickets });
    } catch (e) {
        console.error('[API] Failed to fetch inspections:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/inspect', requireAuth, async (req, res) => {
    const { repoName, createIssue: shouldCreateIssue = true } = req.body;
    if (!repoName) return res.status(400).json({ error: 'repoName is required' });

    console.log(`[API] Triggering inspection for ${repoName}`);
    systemStatus.currentPhase = 'Scanning';
    systemStatus.currentTicketKey = `INSPECT: ${repoName}`;
    systemStatus.currentTicketLogs = [];
    logProgress(`Starting manual inspection for ${repoName}...`);

    try {
        const { processRepo } = require('./scripts/inspect_repo');
        // Run inspection with a custom logger that feeds into UI logs.
        // processRepo(repoName, logCallbackFn, options) returns the
        // created/updated issue key if any; options.createIssue === false
        // skips issue creation.
        const loggerFn = (msg) => {
            logProgress(msg);
        };
        const freshToken = await getFreshSessionAccessToken(req);
        const inspectResult = freshToken
            ? await runWithUserToken(freshToken, () => processRepo(repoName, loggerFn, { createIssue: shouldCreateIssue }))
            : await processRepo(repoName, loggerFn, { createIssue: shouldCreateIssue });
        logProgress(`Inspection complete for ${repoName}.`);

        const response = { message: 'Inspection complete' };
        if (inspectResult && inspectResult.issueKey) {
            response.issueKey = inspectResult.issueKey;
            response.issueUrl = inspectResult.issueUrl;
        }
        res.json(response);
    } catch (e) {
        logProgress(`Error during inspection: ${e.message}`);
        res.status(500).json({ error: e.message });
    } finally {
        setTimeout(() => {
            systemStatus.currentPhase = 'Ready';
            systemStatus.currentTicketKey = null;
        }, 5000);
    }
});

// --- API: Create GitHub Issue ---
app.post('/api/tickets', requireAuth, async (req, res) => {
    try {
        const { block, title, repoName, description, priority } = req.body || {};

        if (!title || !repoName) {
            return res.status(400).json({ error: 'title and repoName are required' });
        }

        const targetRepo = process.env.GITHUB_ISSUES_REPO || repoName;

        const safeBlock = (block || '').trim();
        const summaryParts = [];
        if (safeBlock) summaryParts.push(`[${safeBlock}]`);
        summaryParts.push(title.trim());
        const summary = summaryParts.join(' ');

        const descLines = [];
        descLines.push(`**repo:** ${repoName}`);
        if (safeBlock) descLines.push(`Block: ${safeBlock}`);
        descLines.push('');
        if (description && description.trim()) {
            descLines.push(description.trim());
        }

        const fullDescription = descLines.join('\n');

        const priorityName = (priority || 'Medium').trim();

        const freshToken = await getFreshSessionAccessToken(req);
        const issue = await createIssue(targetRepo, summary, fullDescription, {
            priorityName
        }, freshToken);

        const issueRepo = process.env.GITHUB_ISSUES_REPO || repoName;
        const url = `https://github.com/${issueRepo}/issues/${issue.number}`;

        logProgress(`Created GitHub Issue from UI: ${issue.key} for repo ${repoName}`);

        res.json({
            key: issue.key,
            url,
            repo: targetRepo
        });
    } catch (e) {
        console.error('[API] Failed to create GitHub Issue from UI:', e.message);
        res.status(500).json({ error: e.message || 'Failed to create issue' });
    }
});


// --- Core Logic ---
async function processTicketData(issue, agent) {
    if (!issue || !issue.fields) return;

    const issueKey = issue.key;
    const priority = issue.fields.priority?.name || 'Medium';

    // Reset Live Status for new ticket
    systemStatus.currentPhase = 'Processing';
    systemStatus.currentTicketKey = issueKey;
    systemStatus.currentTicketLogs = [];
    systemStatus.currentIssueUrl = issueKey ? `https://github.com/${process.env.GITHUB_ISSUES_REPO}/issues/${issueKey.replace('GH-', '')}` : null;
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

    // GitHub Issue bodies are plain markdown strings, so just guarantee a string.
    ticketData.description = (typeof ticketData.description === 'string') ? ticketData.description : '';

    // Sentinel keys are always "GH-<number>". Default-repo lookup is no longer
    // keyed by project — operators should set DEFAULT_REPO in their env, or
    // include `**repo:** owner/name` in the issue body.
    const projectDefaultRepo = process.env.DEFAULT_REPO;
    console.log(`[Repo Lookup] Default repo from env: ${projectDefaultRepo || '(none)'}`);

    // Resolve the target repo ONLY from the structured repo field or the
    // DEFAULT_REPO env var. Free-text extraction from the issue body was
    // removed: issue text is attacker-controlled and the first
    // "owner/repo"-looking string in it (e.g. "CI/CD") is not a safe way
    // to choose a repository to write to.
    const fieldRepo = (ticketData.repo || ticketData.repoName || '').trim();
    const repoName = fieldRepo || projectDefaultRepo;

    if (!repoName) {
        const msg = `No target repository could be resolved for ${issueKey}. Set the issue body to include "**repo:** owner/name" or define the DEFAULT_REPO env var.`;
        logProgress(msg);
        try {
            await addComment(issueKey, `❌ ${msg}`);
            await transitionIssue(issueKey, 'To Do');
        } catch (_) { /* ignore */ }
        systemStatus.activeTickets = systemStatus.activeTickets.filter(t => t.key !== issueKey);
        return;
    }

    // Pre-validate repo access and cache default branch
    let resolvedDefaultBranch = null;

    // All GitHub work for this ticket runs under the owning agent's token
    // (via the caller's token context). Without an agent token, only
    // GitHub App (server credential) mode may proceed.
    const activeToken = agent?.token || null;
    if (!activeToken && !authService.getAuthConfig().hasGitHubApp) {
        logProgress(`Skipping ticket ${issueKey || 'unknown'} - No active user logged in.`);
        return;
    }

    // Enforce the allowed-repo scope (ALLOWED_REPOS / ALLOWED_ORGS policy)
    // before touching the target repository.
    if (!isRepoAllowed(repoName, { userLogin: agent?.user?.login })) {
        const msg = `Repository ${repoName} is outside the allowed scope for Sentinel. Add it to ALLOWED_REPOS or its owner to ALLOWED_ORGS to permit processing.`;
        logProgress(`Skipping ticket ${issueKey} - ${msg}`);
        try {
            await addComment(issueKey, `❌ ${msg}`);
            await transitionIssue(issueKey, 'To Do');
        } catch (_) { /* ignore */ }
        systemStatus.activeTickets = systemStatus.activeTickets.filter(t => t.key !== issueKey);
        return;
    }

    if (activeToken) {
        const hasAccess = await githubService.checkRepoAccess(repoName, activeToken);
        if (!hasAccess) {
            logProgress(`Skipping ticket ${issueKey} - User does not have push access to ${repoName}.`);
            // Do NOT transition or comment, just ignore.
            systemStatus.activeTickets = systemStatus.activeTickets.filter(t => t.key !== issueKey);
            return;
        }
        logProgress(`User access verified for ${repoName}`);
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
    let language = ticketData.language;

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

    { // Always analyze for deep config even if language is known
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

    // --- AGENTIC AI ANALYSIS ---
    let repoSummary = 'Analysis not available.';
    let fixStrategy = null;
    let availableSecrets = [];

    try {
        logProgress(`[Agentic] Listing repository secrets...`);
        availableSecrets = await listRepoSecrets(repoName);
        logProgress(`[Agentic] Found secrets: ${availableSecrets.join(', ') || 'None'}`);

        logProgress(`[Agentic] content analyzing repo...`);
        // We need a file listing and README for summary. 
        // We can reuse getRepoInstructions logic or just list files.
        // For efficiency, let's just pass the file list we might have or fetch root.
        const { getRepoRootFiles, getRepoFileContent } = require('./src/services/githubService');
        const files = await getRepoRootFiles(repoName);
        const readme = await getRepoFileContent(repoName, 'README.md');

        repoSummary = await llmService.summarizeRepo(files.join('\n'), readme);
        logProgress(`[Agentic] Repo Summary generated.`);

        logProgress(`[Agentic] Planning fix for ${issueKey}...`);
        fixStrategy = await llmService.planFix(ticketData, repoSummary);
        logProgress(`[Agentic] Fix Strategy generated.`);

        // Post Analysis to GitHub Issue
        if (issueKey) {
            const analysisComment = `🤖 **AI Agent Analysis**\n\n**Repository**: ${repoName}\n${repoSummary}\n\n**Secrets Found**: ${availableSecrets.length ? availableSecrets.join(', ') : 'None detected'}\n\n**Fix Strategy**:\n${fixStrategy}`;
            await addComment(issueKey, analysisComment);
        }

    } catch (e) {
        console.error('[Agentic] Analysis failed:', e);
        logProgress(`[Agentic] Analysis failed: ${e.message}`);
    }

    // Default commands based on language (if not specified)
    // Priority: Issue directive (fields.build/test parsed from the issue
    // body by mapIssue) > Repo Instructions (MD) > Repo Config (Code) >
    // Language Default
    let buildCommand = ticketData.build || repoInstructions.buildCommand || repoConfig.buildCommand || ticketData.buildCommand;
    let testCommand = ticketData.test || repoInstructions.testCommand || repoConfig.testCommand || ticketData.testCommand;

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

    const deployTarget = ticketData.deploy || ticketData.deployTarget || 'azure-webapp';

    try {
        // 1. Move to In Progress
        logProgress(`Transitioning GitHub Issue to "In Progress"...`);
        if (issueKey) {
            await transitionIssue(issueKey, 'In Progress');
            await addComment(issueKey, `🔄 Moving to In Progress`);
        }

        // 1b. Get Default Branch (Dynamic)
        const defaultBranch = resolvedDefaultBranch || await getDefaultBranch(repoName);
        logProgress(`Targeting default branch: ${defaultBranch} `);

        // 2.1 Optional: Apply ticket-specific Copilot fixes to target files before PR
        const ticketFiles = Array.isArray(ticketData.customfield_files) ? ticketData.customfield_files : [];
        if (USE_GH_COPILOT && ticketFiles.length > 0) {
            const fixPrompt = `Address GitHub Issue ${issueKey} requirements. Context: Language=${language}, Build=${buildCommand}, Test=${testCommand}. Make minimal, safe changes.`;
            logProgress(`Applying Copilot fixes to ${ticketFiles.length} file(s)...`);
            await applyCopilotFixes({ files: ticketFiles, prompt: fixPrompt });
        }

        // 2.2 Pre-PR AI Generation (Hybrid CLI) for workflow content
        let workflowYml;
        if (USE_GH_COPILOT) {
            logProgress(`Running gh copilot suggest for pre-PR generation...`);
            const promptParts = [
                `GitHub Issue: ${issueKey}`,
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

            // [NEW] Use active user's token for Copilot access
            const env = { ...process.env };
            if (activeToken) {
                env.GITHUB_TOKEN = activeToken;
            }

            const ghOutput = await new Promise((resolve) => {
                const child = spawn('gh', args, { cwd: process.cwd(), env });
                let stdout = '';
                let stderr = '';
                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
                        logProgress(`Copilot CLI timed out after 30s. Falling back.`);
                        resolve(null);
                    }
                }, 30_000);

                child.stdout.on('data', (d) => { stdout += d.toString(); });
                child.stderr.on('data', (d) => { stderr += d.toString(); });
                child.on('error', (error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    logProgress(`Copilot CLI failed to spawn: ${error.message}. Falling back.`);
                    resolve(null);
                });
                child.on('close', (code) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (code !== 0) {
                        logProgress(`Copilot CLI exited with code ${code}. stderr: ${stderr.slice(0, 200)}. Falling back.`);
                        resolve(null);
                        return;
                    }
                    if (stdout && stdout.trim().length > 0) {
                        resolve(stdout);
                    } else {
                        logProgress(`Copilot CLI produced no content. Falling back.`);
                        resolve(null);
                    }
                });

                // Actually feed our prompt to the CLI — previously this was dropped.
                try {
                    child.stdin.write(message);
                    child.stdin.end();
                } catch (_) { /* if write fails the close handler will fire */ }
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

        // [NEW] Agentic Workflow Generation Override
        if (fixStrategy && process.env.LLM_API_KEY) {
            logProgress(`[Agentic] Generating custom workflow based on strategy...`);
            const customWorkflow = await llmService.generateDraftWorkflow(fixStrategy, language, { buildCommand, testCommand, deployTarget }, availableSecrets);
            if (customWorkflow) {
                workflowYml = customWorkflow;
                logProgress(`[Agentic] Using LLM-generated workflow.`);
            }
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
            ticketData: { ...ticketData, buildCommand, testCommand },
            aiAnalysis: { fixStrategy, repoSummary, availableSecrets } // [NEW] AI context for PR comments
        });

        systemStatus.currentPrUrl = result.prUrl;

        if (result.isNew) {
            logProgress(`PR Created Successfully: ${result.prUrl} `);

            // 4. Comment Success & Move to configured post-PR status (per-board override)
            if (issueKey) {
                const postPrStatus = getPostPrStatusForIssue(issue);
                logProgress(`Posting success comment to GitHub Issue...`);
                await addComment(issueKey, `SUCCESS: Workflow PR created! \nLink: ${result.prUrl} `);
                await transitionIssue(issueKey, postPrStatus);
                await addComment(issueKey, `➡️ Moving to ${postPrStatus}`);
                logProgress(`Ticket moved to "${postPrStatus}".`);
            }
        } else {
            logProgress(`PR already exists: ${result.prUrl} `);
            if (issueKey) {
                const postPrStatus = getPostPrStatusForIssue(issue);
                logProgress(`Updates verified. Moving to configured post-PR status.`);
                await addComment(issueKey, `VERIFIED: Workflow PR already exists.\nLink: ${result.prUrl} `);
                await transitionIssue(issueKey, postPrStatus);
                await addComment(issueKey, `➡️ Moving to ${postPrStatus}`);
                logProgress(`Ticket moved to "${postPrStatus}".`);
            }
        }

        // Update UI History & Start Monitoring
        systemStatus.processedCount++;
        const historyItem = {
            key: issueKey,
            agentUserId: agent?.userId || null,
            priority,
            result: 'Success',
            time: new Date().toLocaleTimeString(),
            issueUrl: systemStatus.currentIssueUrl,
            prUrl: result.prUrl,
            repoName,
            branch: result.branch, // Needed for check monitoring
            payload: workflowYml, // Store payload for UI
            language, // [NEW] for UI
            deployTarget, // [NEW] for UI
            checks: [],
            headSha: result.headSha,
            copilotPrUrl: null,
            copilotMerged: false,
            copilotApproved: false,
            copilotCreatedAt: null, // [NEW]
            copilotMergedAt: null,   // [NEW]
            toolUsed: null,          // [NEW]
            prReadyCommented: false,
            prMergedCommented: false,
            failureCommentPosted: false
        };
        systemStatus.scanHistory.unshift(historyItem);
        // Add to monitored list
        systemStatus.monitoredTickets.push(historyItem);
        schedulePersistState();

    } catch (error) {
        logProgress(`ERROR: ${error.message} `);
        console.error(`Failed to process ${issueKey}: `, error.message);
        if (issueKey) {
            await addComment(issueKey, `FAILURE: Could not create workflow.Error: ${error.message} `);
            logProgress(`Transitioning ticket back to "To Do"...`);
            await transitionIssue(issueKey, 'To Do');
        }
        systemStatus.scanHistory.unshift({ key: issueKey, priority, result: 'Failed', time: new Date().toLocaleTimeString() });
        schedulePersistState();
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
            // Basic suggest only; flags like --filename/--message are unsupported,
            // so we pipe the prompt (with the target filename baked in) through stdin.
            const args = ['copilot', 'suggest'];
            const child = spawn('gh', args, { cwd: process.cwd() });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
                    results.push({ file: f, ok: false, stdout, stderr, error: 'Copilot CLI timed out' });
                    resolve();
                }
            }, 30_000);
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                results.push({ file: f, ok: false, stdout, stderr, error: error.message });
                resolve();
            });
            child.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                results.push({ file: f, ok: code === 0, stdout, stderr, error: code === 0 ? null : `exit ${code}` });
                resolve();
            });
            try {
                child.stdin.write(`File: ${f}\n\n${prompt}`);
                child.stdin.end();
            } catch (_) { /* handled by close */ }
        });
    }
    return results;
}

// --- Polling Loop (Sentinel Mode) ---
async function startPolling() {
    writeLog('--- Starting Sentinel Polling ---');

    // On startup, reconcile open PRs across the org and resume monitoring
    async function reconcileActivePRsOnStartup() {
        try {
            const org = process.env.GHUB_ORG || 'Unigalactix';
            writeLog(`[Sentinel] Reconciling active PRs in org: ${org}`);
            const prs = await getActiveOrgPRsWithGHKeys({ org });
            if (!Array.isArray(prs) || prs.length === 0) {
                writeLog('[Sentinel] No open PRs with GitHub issue keys found to reconcile.');
                return;
            }
            for (const pr of prs) {
                const issueKey = pr.issueKey;
                try {
                    const issue = await getIssueDetails(issueKey);
                    const statusName = issue?.fields?.status?.name || '';
                    const priority = issue?.fields?.priority?.name || 'Medium';
                    const isActive = /in progress|processing|in review|active/i.test(statusName) && !/done|closed|resolved/i.test(statusName);
                    if (!isActive) {
                        continue;
                    }
                    // Avoid duplicates
                    const already = systemStatus.monitoredTickets.find(t => t.key === issueKey || t.prUrl === pr.prUrl);
                    if (already) continue;

                    const historyItem = {
                        key: issueKey,
                        agentUserId: null,
                        priority,
                        result: 'Resumed',
                        time: new Date().toLocaleTimeString(),
                        issueUrl: process.env.GITHUB_ISSUES_REPO
                            ? `https://github.com/${process.env.GITHUB_ISSUES_REPO}/issues/${issueKey.replace(/^GH-/i, '')}`
                            : null,
                        prUrl: pr.prUrl,
                        repoName: pr.repoName,
                        branch: pr.branch,
                        payload: null,
                        language: null,
                        deployTarget: null,
                        checks: [],
                        headSha: pr.headSha,
                        copilotPrUrl: null,
                        copilotMerged: false,
                        copilotApproved: false,
                        copilotCreatedAt: null,
                        copilotMergedAt: null,
                        toolUsed: 'Reconcile',
                        prReadyCommented: false,
                        prMergedCommented: false,
                        failureCommentPosted: false
                    };
                    systemStatus.scanHistory.unshift(historyItem);
                    systemStatus.monitoredTickets.push(historyItem);
                    schedulePersistState();
                    writeLog(`[Sentinel] Resumed monitoring PR ${pr.prUrl} for issue ${issueKey}.`);
                    try {
                        await addComment(issueKey, `🔁 Server restarted: resuming monitoring for active PR\nPR: ${pr.prUrl}`);
                    } catch (commentErr) {
                        writeLog(`[Sentinel] Failed to post resume comment for ${issueKey}: ${commentErr.message}`);
                    }
                } catch (e) {
                    writeLog(`[Sentinel] Failed to reconcile ${issueKey}: ${e.message}`);
                }
            }
        } catch (e) {
            writeLog(`[Sentinel] Reconciliation error: ${e.message}`);
        }
    }

    const poll = async () => {
        try {
            if (systemStatus.paused) {
                systemStatus.currentPhase = 'Paused';
                systemStatus.currentTicketKey = 'PAUSED';
                systemStatus.nextScanTime = null;
                return;
            }

            const agents = [...activeAgents.values()];

            if (agents.length === 0) {
                if (authService.getAuthConfig().hasGitHubApp) {
                    // GitHub App mode: one scan with server credentials,
                    // no per-user token context.
                    systemStatus.currentPhase = 'Scanning';
                    systemStatus.nextScanTime = null;
                    writeLog('Scanning GitHub Issues for new tickets (GitHub App mode)...');

                    const issues = await getPendingTickets();
                    if (issues.length > 0) {
                        writeLog(`Found ${issues.length} pending tickets.`);
                        systemStatus.activeTickets = issues.map(i => ({
                            key: i.key,
                            priority: i.fields.priority?.name || 'Medium',
                            status: 'Queued'
                        }));
                        systemStatus.currentPhase = 'Processing';
                        for (const issue of issues) {
                            await processTicketData(issue, null);
                        }
                    } else {
                        writeLog('No pending issues found.');
                    }
                    return;
                }

                systemStatus.currentPhase = 'Waiting for Login';
                systemStatus.currentTicketKey = 'LOGIN_REQUIRED';
                systemStatus.currentTicketLogs = ['⚠️ Please login with GitHub to start processing issues'];
                systemStatus.nextScanTime = null;
                return;
            }

            // Process each logged-in user's queue sequentially, under that
            // user's own token context — tokens are never shared or mixed
            // between users.
            for (const agent of agents) {
                await refreshAgentToken(agent);
                // Re-fetch the agent: refreshAgentToken may have replaced it.
                const currentAgent = getAgent(agent.userId) || agent;

                await runWithUserToken(currentAgent.token, async () => {
                    // PHASE: Scanning
                    systemStatus.currentPhase = 'Scanning';
                    systemStatus.nextScanTime = null;

                    writeLog(`Scanning GitHub Issues for new tickets (agent ${currentAgent.user.login})...`);

                    const issues = await getPendingTickets();

                    if (issues.length > 0) {
                        writeLog(`Found ${issues.length} pending tickets.`);

                        // Populate Queue
                        systemStatus.activeTickets = issues.map(i => ({
                            key: i.key,
                            priority: i.fields.priority?.name || 'Medium',
                            status: 'Queued'
                        }));

                        // PHASE: Processing loop
                        systemStatus.currentPhase = 'Processing';
                        for (const issue of issues) {
                            await processTicketData(issue, currentAgent);
                        }
                    } else {
                        writeLog('No pending issues found.');
                    }
                });
            }
        } catch (error) {
            writeLog(`Scan error: ${error.message}`);
        } finally {
            // PHASE: Ready (waiting for next manual trigger)
            systemStatus.currentPhase = 'Ready';
            systemStatus.currentTicketKey = null;
            systemStatus.nextScanTime = null;
        }
    };

    const monitorChecks = async () => {
        try {
            if (systemStatus.monitoredTickets.length > 0) {
                const { getLatestWorkflowRunForRef, getJobsForRun, getPullRequestDetails, getPullRequestChecks, isPullRequestMerged } = require('./src/services/githubService');

                // Iterate over a COPY: tickets are removed from
                // systemStatus.monitoredTickets when they reach a terminal state.
                for (const ticket of [...systemStatus.monitoredTickets]) {
                    if (!ticket.branch) continue;

                    // Each ticket is monitored under its owning agent's
                    // token context (when the agent is still registered).
                    const agent = ticket.agentUserId ? getAgent(ticket.agentUserId) : null;

                    const work = async () => {
                        // Prefer headSha if present for precise run lookup
                        const ref = ticket.headSha || ticket.branch;
                        const latestRun = await getLatestWorkflowRunForRef({ repoName: ticket.repoName, ref });
                        let jobs = [];
                        if (latestRun && latestRun.id) {
                            jobs = await getJobsForRun({ repoName: ticket.repoName, runId: latestRun.id });
                        }
                        ticket.checks = jobs.map(j => ({ name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url || (latestRun ? latestRun.html_url : '') }));

                        // Fetch the main PR once when we have its URL
                        let mainPr = null;
                        let mainPrNumber = null;
                        if (ticket.prUrl) {
                            mainPrNumber = parseInt(ticket.prUrl.split('/').pop(), 10);
                            try {
                                mainPr = await getPullRequestDetails({ repoName: ticket.repoName, pull_number: mainPrNumber });
                            } catch (e) {
                                writeLog(`[Sentinel] Failed to fetch main PR for ${ticket.key}: ${e.message}`);
                            }
                        }

                        const removeFromMonitoring = () => {
                            systemStatus.monitoredTickets = systemStatus.monitoredTickets.filter(t => t !== ticket);
                        };

                        // --- Main-PR lifecycle ---
                        if (mainPr?.merged) {
                            if (!ticket.prMergedCommented) {
                                try {
                                    await addComment(ticket.key, `✅ **Workflow PR merged!**\n\nPR: ${ticket.prUrl}\n\nSentinel has completed this ticket — moving it to Done.`);
                                    await transitionIssue(ticket.key, 'Done');
                                } catch (e) {
                                    writeLog(`[Sentinel] Failed to close out ${ticket.key} after PR merge: ${e.message}`);
                                }
                                ticket.prMergedCommented = true;
                            }
                            ticket.result = 'Success';
                            removeFromMonitoring();
                            schedulePersistState();
                            return;
                        }

                        if (mainPr && mainPr.state === 'closed') {
                            // Closed without merging (merged is handled above)
                            if (!ticket.prMergedCommented) {
                                try {
                                    await addComment(ticket.key, `⚠️ **Workflow PR was closed without merging.**\n\nPR: ${ticket.prUrl}\n\nMoving this ticket back to To Do.`);
                                    await transitionIssue(ticket.key, 'To Do');
                                } catch (e) {
                                    writeLog(`[Sentinel] Failed to report closed PR for ${ticket.key}: ${e.message}`);
                                }
                                ticket.prMergedCommented = true;
                            }
                            removeFromMonitoring();
                            schedulePersistState();
                            return;
                        }

                        // --- CI failure reporting (main PR workflow run) ---
                        if (latestRun?.status === 'completed' && latestRun?.conclusion === 'failure' && !ticket.failureCommentPosted) {
                            const failingJobs = jobs.filter(j => j.conclusion === 'failure').map(j => j.name);
                            try {
                                await addComment(ticket.key, `❌ **CI failed** for the workflow PR.\n\nRun: ${latestRun.html_url || ''}\nFailing jobs: ${failingJobs.length ? failingJobs.join(', ') : 'see run details'}\n\nMoving this ticket back to To Do.`);
                                await transitionIssue(ticket.key, 'To Do');
                            } catch (e) {
                                writeLog(`[Sentinel] Failed to report CI failure for ${ticket.key}: ${e.message}`);
                            }
                            ticket.failureCommentPosted = true;
                            removeFromMonitoring();
                            schedulePersistState();
                            return;
                        }

                        // --- Copilot sub-PR handling ---
                        if (!ticket.copilotMerged && ticket.prUrl && mainPrNumber) {
                            try {
                                const subPr = await findCopilotSubPR({ repoName: ticket.repoName, mainPrNumber });
                                if (subPr) {
                                    ticket.copilotPrUrl = subPr.html_url;
                                    // [NEW] Capture Creation Time for Timer
                                    if (!ticket.copilotCreatedAt) {
                                        ticket.copilotCreatedAt = subPr.created_at;
                                    }

                                    const hasWipLabel = Array.isArray(subPr.labels) && subPr.labels.some(l => /\bWIP\b/i.test(l.name || ''));
                                    const isWipTitle = /\bWIP\b/i.test(subPr.title || '');
                                    // Block on WIP signaled by title OR label
                                    const isWorkInProgress = isWipTitle || hasWipLabel;

                                    if (!isWorkInProgress) {
                                        // If it's a draft, undraft it before auto-merge can act on it
                                        if (subPr.draft) {
                                            writeLog(`[Sentinel] SubPR #${subPr.number} is Draft. Mark as Ready for Review...`);
                                            await markPullRequestReadyForReview({ repoName: ticket.repoName, pullNumber: subPr.number });
                                            ticket.toolUsed = "Autopilot + Undraft"; // [NEW] Track tool usage
                                        } else {
                                            ticket.toolUsed = "Autopilot"; // [NEW] Track tool usage
                                        }

                                        // [FIX #14] Only auto-approve / enable auto-merge once per sub PR.
                                        if (!ticket.copilotApproved) {
                                            // Gate approval on the sub-PR's own checks:
                                            // fetch its head sha, then its check runs.
                                            let subPrDetails = null;
                                            try {
                                                subPrDetails = await getPullRequestDetails({ repoName: ticket.repoName, pull_number: subPr.number });
                                            } catch (e) {
                                                writeLog(`[Sentinel] Failed to fetch SubPR #${subPr.number} details: ${e.message}`);
                                            }
                                            const subPrSha = subPrDetails?.head?.sha || subPr.head?.sha;
                                            const subChecks = subPrSha
                                                ? await getPullRequestChecks({ repoName: ticket.repoName, ref: subPrSha })
                                                : [];

                                            const failedConclusions = ['failure', 'cancelled', 'timed_out', 'action_required'];
                                            const failedChecks = subChecks.filter(c => failedConclusions.includes(c.conclusion));
                                            if (failedChecks.length > 0) {
                                                writeLog(`[Sentinel] SubPR #${subPr.number} has failing checks (${failedChecks.map(c => c.name).join(', ')}). Skipping approval.`);
                                                if (!ticket.subPrChecksFailed) {
                                                    ticket.subPrChecksFailed = true;
                                                    try {
                                                        await addComment(ticket.key, `⚠️ **Copilot sub-PR #${subPr.number} has failing checks**: ${failedChecks.map(c => c.name).join(', ')}.\n\nSentinel will not approve or auto-merge it until the checks pass.`);
                                                    } catch (e) {
                                                        writeLog(`[Sentinel] Failed to comment failing sub-PR checks for ${ticket.key}: ${e.message}`);
                                                    }
                                                }
                                                return;
                                            }

                                            // Checks still running — skip this cycle silently.
                                            if (subChecks.some(c => c.status !== 'completed')) {
                                                return;
                                            }

                                            // All checks completed successfully (or
                                            // zero checks exist): safe to approve.
                                            writeLog(`[Sentinel] Auto-approving SubPR #${subPr.number}...`);
                                            await approvePullRequest({ repoName: ticket.repoName, pullNumber: subPr.number });
                                            ticket.copilotApproved = true;

                                            // Enable GitHub Auto-Merge on the sub PR.
                                            // There is deliberately NO immediate-merge
                                            // fallback: if auto-merge cannot be enabled,
                                            // log it and let a human decide.
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
                                                writeLog(`[Sentinel] ⚠️ Auto-merge enable failed for SubPR #${subPr.number}: ${autoRes.message}`);
                                                ticket.autoMergeError = autoRes.message;
                                            }
                                        } else if (ticket.autoMergeEnabled && !ticket.copilotMerged) {
                                            // Poll merged-state cheaply without re-approving / re-enabling auto-merge
                                            const mergedCheck = await isPullRequestMerged({ repoName: ticket.repoName, pullNumber: subPr.number });
                                            if (mergedCheck.merged) {
                                                ticket.copilotMerged = true;
                                                ticket.copilotMergedAt = new Date().toISOString();
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                writeLog(`Status check error for ${ticket.key}: ${e.message}`);
                            }
                        }
                    };

                    if (agent) {
                        await refreshAgentToken(agent);
                        // Re-fetch: refreshAgentToken may have replaced the agent.
                        const currentAgent = getAgent(agent.userId) || agent;
                        await runWithUserToken(currentAgent.token, work);
                    } else {
                        await work();
                    }
                }
            }
        } catch (e) {
            writeLog(`Monitoring error: ${e.message}`);
        } finally {
            setTimeout(monitorChecks, 15000);
        }
    };

    // Reconcile once on startup, then wait for manual trigger
    await reconcileActivePRsOnStartup();

    // Expose poll function globally for manual trigger via /api/poll
    global.forcePoll = poll;

    // Set initial phase to Ready (manual triggers only)
    systemStatus.currentPhase = 'Ready';

    monitorChecks();
}

app.listen(PORT, async () => {
    writeLog(`Server running on port ${PORT}`);

    // Restore persisted ticket / history state before any background work starts.
    loadPersistedState();

    // Verify Env
    const ghToken = process.env.GHUB_TOKEN;
    const issuesRepo = process.env.GITHUB_ISSUES_REPO;
    const copilotEnabled = process.env.USE_GH_COPILOT; // Just log it

    writeLog(`GitHub Token present: ${!!ghToken}`);
    writeLog(`GitHub Issues Repo: ${issuesRepo}`);
    writeLog(`GH Copilot enabled: ${copilotEnabled}`);

    if (!issuesRepo) {
        writeLog('⚠️⚠️ WARNING: GITHUB_ISSUES_REPO is not set — issue scanning is DISABLED until it is set (e.g. GITHUB_ISSUES_REPO=owner/repo). Sentinel cannot read or create issues without it. ⚠️⚠️');
    }

    startPolling();
});
