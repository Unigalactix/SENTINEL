const { Octokit } = require('@octokit/rest');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const REQUIRED_SCOPES = [
    'repo',           // Full control of private repositories
    'workflow',       // Update GitHub Action workflows
    'admin:org',      // (Optional) For org-level secrets/settings if needed
];

async function checkPermissions() {
    console.log('--- GitHub Token Permission Check ---');

    if (!process.env.GHUB_TOKEN) {
        console.error('❌ Error: GHUB_TOKEN is missing in .env file.');
        process.exit(1);
    }

    try {
        const octokit = new Octokit({ auth: process.env.GHUB_TOKEN });

        // 1. Check Authentication & Scopes (Classic Tokens)
        // For Fine-grained tokens, 'x-oauth-scopes' might be empty or behave differently.
        const { headers, data: user } = await octokit.request('GET /user');
        const scopesHeader = headers['x-oauth-scopes'] || '';
        const assignedScopes = scopesHeader.split(',').map(s => s.trim()).filter(s => s);

        console.log(`✅ Authenticated as: ${user.login}`);
        console.log(`ℹ️  Token Scopes Detected: ${assignedScopes.length > 0 ? assignedScopes.join(', ') : '(None or Fine-grained Token)'}`);

        // 2. Validate against Requirements
        const missingScopes = [];
        // Note: 'repo' scope usually implies 'repo:status', 'repo_deployment', 'public_repo', etc.
        // We do a simple check for exact matches or broader scopes.

        REQUIRED_SCOPES.forEach(req => {
            const hasScope = assignedScopes.some(s => s === req || (req.startsWith('repo') && s === 'repo'));
            if (!hasScope) {
                // Special handling: 'repo' covers almost everything.
                if (req === 'workflow' && assignedScopes.includes('repo')) return;
                missingScopes.push(req);
            }
        });

        if (assignedScopes.length === 0) {
            console.warn('\n⚠️  Warning: No scopes detected in headers. If you are using a Fine-Grained Token, headers may not reflect permissions. You must manually verify "Repository Permissions" in GitHub Developer Settings.');
        } else if (missingScopes.length > 0) {
            console.error('\n❌ Missing Required Scopes:');
            missingScopes.forEach(s => console.error(`   - ${s}`));
            console.log('\nPlease update your Personal Access Token (PAT) at https://github.com/settings/tokens');
        } else {
            console.log('\n✅ All required classic scopes appear to be present.');
        }

        // 3. Test Write Access (Dry Run)
        console.log('\n--- Testing Write Access (Dry Run) ---');
        // We can't easily test "write" without writing, but we can check if we can see private repos (indicates 'repo' scope often)
        try {
            // Just list one repo to see if we can access it
            await octokit.rest.repos.listForAuthenticatedUser({ visibility: 'private', per_page: 1 });
            console.log('✅ Access to private repositories confirmed.');
        } catch (e) {
            if (e.status === 403 || e.status === 401) {
                console.error('❌ Failed to list private repositories. Token likely lacks "repo" scope.');
            } else {
                console.warn(`⚠️  Could not verify private repo access: ${e.message}`);
            }
        }

    } catch (error) {
        console.error(`❌ Authentication Failed: ${error.message}`);
        if (error.status === 401) {
            console.error('   -> The token is invalid or expired.');
        }
    }
}

checkPermissions();
