/**
 * Authentication Service for GitHub App OAuth
 * Handles OAuth flow, token exchange, and session management
 */
require('dotenv').config();

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;

const GITHUB_APP_NAME = 'sentinel-dev-agent'; // Replace with your actual GitHub App name (slug)

/**
 * Generates the GitHub OAuth authorization URL
 */
function getAuthorizationUrl(redirectUri) {
    const params = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: 'repo read:org read:user',
        state: generateState()
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Returns the GitHub App Installation URL
 */
function getInstallationUrl() {
    // If we have the App ID/Slug, we can direct users to install it.
    // For a public app: https://github.com/apps/<app-slug>/installations/new
    const appSlug = process.env.GITHUB_APP_SLUG || 'sentinel-dev-agent';
    return `https://github.com/apps/${appSlug}/installations/new`;
}


/**
 * Generates a random state for CSRF protection
 */
function generateState() {
    return Math.random().toString(36).substring(2, 15);
}

/**
 * Exchanges the OAuth code for an access token
 */
async function exchangeCodeForToken(code, redirectUri) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
            code: code,
            redirect_uri: redirectUri
        })
    });

    const data = await response.json();

    if (data.error) {
        throw new Error(`OAuth error: ${data.error_description || data.error}`);
    }

    return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        scope: data.scope
    };
}

/**
 * Fetches the authenticated user's GitHub profile
 */
async function getGitHubUser(accessToken) {
    const response = await fetch('https://api.github.com/user', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch GitHub user');
    }

    return await response.json();
}

/**
 * Check if we have valid GitHub App credentials configured
 */
function hasGitHubAppCredentials() {
    return !!(GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID);
}

/**
 * Check if we have OAuth credentials configured
 */
function hasOAuthCredentials() {
    return !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET);
}

/**
 * Get authentication status and available methods
 */
function getAuthConfig() {
    return {
        hasGitHubApp: hasGitHubAppCredentials(),
        hasOAuth: hasOAuthCredentials(),
        clientId: OAUTH_CLIENT_ID,
        appId: GITHUB_APP_ID
    };
}

module.exports = {
    getAuthorizationUrl,
    getInstallationUrl,
    exchangeCodeForToken,
    getGitHubUser,
    hasGitHubAppCredentials,
    hasOAuthCredentials,
    getAuthConfig
};
