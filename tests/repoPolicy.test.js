// tests/repoPolicy.test.js
const { isRepoAllowed } = require('../src/utils/repoPolicy');

const ENV_KEYS = ['ALLOWED_REPOS', 'ALLOWED_ORGS', 'GITHUB_ISSUES_REPO'];

describe('repoPolicy.isRepoAllowed', () => {
    let savedEnv;

    beforeEach(() => {
        savedEnv = {};
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = savedEnv[key];
            }
        }
    });

    describe('ALLOWED_REPOS set', () => {
        beforeEach(() => {
            process.env.ALLOWED_REPOS = 'Unigalactix/SENTINEL, octocat/hello-world';
        });

        test('allows a repo in the list', () => {
            expect(isRepoAllowed('Unigalactix/SENTINEL')).toBe(true);
            expect(isRepoAllowed('octocat/hello-world')).toBe(true);
        });

        test('matches case-insensitively', () => {
            expect(isRepoAllowed('unigalactix/sentinel')).toBe(true);
        });

        test('denies a repo not in the list, even from a listed owner', () => {
            expect(isRepoAllowed('Unigalactix/other-repo')).toBe(false);
            expect(isRepoAllowed('someone/else')).toBe(false);
        });

        test('takes precedence over ALLOWED_ORGS', () => {
            process.env.ALLOWED_ORGS = 'someorg';
            expect(isRepoAllowed('someorg/repo')).toBe(false);
            expect(isRepoAllowed('Unigalactix/SENTINEL')).toBe(true);
        });
    });

    describe('ALLOWED_ORGS set', () => {
        beforeEach(() => {
            process.env.ALLOWED_ORGS = 'Unigalactix, my-org';
        });

        test('allows any repo whose owner is in the list', () => {
            expect(isRepoAllowed('Unigalactix/anything')).toBe(true);
            expect(isRepoAllowed('my-org/project')).toBe(true);
        });

        test('matches owner case-insensitively', () => {
            expect(isRepoAllowed('UNIGALACTIX/repo')).toBe(true);
        });

        test('denies repos from owners not in the list', () => {
            expect(isRepoAllowed('stranger/repo')).toBe(false);
        });
    });

    describe('default policy (no allowlists configured)', () => {
        beforeEach(() => {
            process.env.GITHUB_ISSUES_REPO = 'Unigalactix/SENTINEL';
        });

        test('allows repos owned by the issues-repo owner', () => {
            expect(isRepoAllowed('Unigalactix/target-repo')).toBe(true);
            expect(isRepoAllowed('unigalactix/target-repo')).toBe(true);
        });

        test('denies repos from other owners', () => {
            expect(isRepoAllowed('someoneelse/target-repo')).toBe(false);
        });

        test('allows repos owned by the authenticated user', () => {
            expect(isRepoAllowed('octocat/project', { userLogin: 'OctoCat' })).toBe(true);
        });

        test('denies when neither issues repo nor userLogin is known', () => {
            delete process.env.GITHUB_ISSUES_REPO;
            expect(isRepoAllowed('octocat/project')).toBe(false);
            expect(isRepoAllowed('octocat/project', {})).toBe(false);
        });

        test('userLogin alone (no issues repo) still scopes correctly', () => {
            delete process.env.GITHUB_ISSUES_REPO;
            expect(isRepoAllowed('octocat/project', { userLogin: 'octocat' })).toBe(true);
            expect(isRepoAllowed('other/project', { userLogin: 'octocat' })).toBe(false);
        });
    });

    describe('malformed repo names', () => {
        beforeEach(() => {
            process.env.GITHUB_ISSUES_REPO = 'Unigalactix/SENTINEL';
        });

        test.each([
            '',
            'noslash',
            '/repo',
            'owner/',
            'owner/repo/extra',
            'owner name/repo',
            'owner/re po'
        ])('denies %j', (bad) => {
            expect(isRepoAllowed(bad)).toBe(false);
        });

        test('denies non-string input', () => {
            expect(isRepoAllowed(null)).toBe(false);
            expect(isRepoAllowed(undefined)).toBe(false);
            expect(isRepoAllowed(42)).toBe(false);
        });
    });
});
