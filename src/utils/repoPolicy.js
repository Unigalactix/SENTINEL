/**
 * Repository allowlist policy.
 *
 * Sentinel creates branches, workflow files, and PRs in target repositories
 * named by GitHub Issues. Without a policy, any issue author could steer the
 * agent at any repository the operator's token can push to. This module is
 * the single place that decides whether a target repo is in scope.
 *
 * Policy (first matching rule wins):
 *   1. ALLOWED_REPOS env (comma-separated "owner/repo" list): the repo must
 *      be in the list.
 *   2. ALLOWED_ORGS env (comma-separated owner list): the repo's owner must
 *      be in the list.
 *   3. Default: the repo's owner must equal the owner of GITHUB_ISSUES_REPO
 *      (the repo Sentinel itself is operated from) or the authenticated
 *      user's login (options.userLogin). If neither is known, deny.
 *
 * All comparisons are case-insensitive (GitHub names are case-insensitive).
 */

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9-._]+$/;

function parseList(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Check whether a repository is allowed as a Sentinel target.
 * @param {string} repoName - "owner/repo"
 * @param {object} [options]
 * @param {string} [options.userLogin] - Login of the authenticated user, if known.
 * @returns {boolean}
 */
function isRepoAllowed(repoName, options = {}) {
    if (!repoName || typeof repoName !== 'string' || !REPO_PATTERN.test(repoName)) {
        return false;
    }

    const normalized = repoName.toLowerCase();
    const owner = normalized.split('/')[0];

    // Rule 1: explicit repo allowlist.
    const allowedRepos = parseList(process.env.ALLOWED_REPOS);
    if (allowedRepos.length > 0) {
        return allowedRepos.includes(normalized);
    }

    // Rule 2: explicit org/owner allowlist.
    const allowedOrgs = parseList(process.env.ALLOWED_ORGS);
    if (allowedOrgs.length > 0) {
        return allowedOrgs.includes(owner);
    }

    // Rule 3 (default): same owner as the issues repo, or the user's own login.
    const issuesRepo = process.env.GITHUB_ISSUES_REPO;
    const issuesOwner = issuesRepo && REPO_PATTERN.test(issuesRepo)
        ? issuesRepo.split('/')[0].toLowerCase()
        : null;
    const userLogin = options && options.userLogin
        ? String(options.userLogin).toLowerCase()
        : null;

    if (!issuesOwner && !userLogin) {
        return false;
    }

    if (issuesOwner && owner === issuesOwner) return true;
    if (userLogin && owner === userLogin) return true;
    return false;
}

module.exports = { isRepoAllowed };
