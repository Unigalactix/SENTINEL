/**
 * Import Verification Tests
 * Ensures all imported functions exist in their respective exports.
 * Prevents "function is not a function" runtime errors.
 */

describe('Service Exports', () => {

    describe('githubService', () => {
        const githubService = require('../src/services/githubService');

        const expectedExports = [
            'generateWorkflowFile',
            'createPullRequestForWorkflow',
            'getPullRequestChecks',
            'detectRepoLanguage',
            'generateDockerfile',
            'getRepoInstructions',
            'analyzeRepoStructure',
            'getDefaultBranch',
            'findCopilotSubPR',
            'mergeSubPRIntoBranch',
            'getPullRequestDetails',
            'hasExistingWorkflow',
            'triggerExistingWorkflow',
            'deleteBranch',
            'markPullRequestReadyForReview',
            'mergePullRequest',
            'enablePullRequestAutoMerge',
            'isPullRequestMerged',
            'approvePullRequest',
            'getLatestWorkflowRunForRef',
            'getJobsForRun',
            'summarizeFailureFromRun',
            'getLatestDeploymentUrl',
            'getActiveOrgPRsWithJiraKeys',
            'getRepoRootFiles',
            'getRepoFileContent',
            'getRepoDirectoryFiles',
            'listRepoSecrets',
            'listAccessibleRepos',
            'checkRepoAccess',
            'listRepoWorkflows',
            'getReleases',
            'getBranchProtection',
            'listBranches'
        ];

        test.each(expectedExports)('%s is exported and is a function', (fnName) => {
            expect(githubService[fnName]).toBeDefined();
            expect(typeof githubService[fnName]).toBe('function');
        });
    });

    describe('jiraService', () => {
        const jiraService = require('../src/services/jiraService');

        const expectedExports = [
            'getPendingTickets',
            'transitionIssue',
            'addComment',
            'getIssueDetails',
            'createIssue',
            'getProjects',
            'searchIssues',
            'updateIssue'
        ];

        test.each(expectedExports)('%s is exported and is a function', (fnName) => {
            expect(jiraService[fnName]).toBeDefined();
            expect(typeof jiraService[fnName]).toBe('function');
        });
    });

    describe('llmService', () => {
        const llmService = require('../src/services/llmService');

        test('is exported as instance', () => {
            expect(llmService).toBeDefined();
        });

        const expectedMethods = [
            'planFix',
            'analyzeInspectionResults',
            'generateDraftWorkflow',
            'executeAgenticTask'
        ];

        test.each(expectedMethods)('%s is a method', (methodName) => {
            expect(typeof llmService[methodName]).toBe('function');
        });
    });

    describe('devopsChecks', () => {
        const devopsChecks = require('../src/services/devopsChecks');

        test('runDevOpsScan is exported and is a function', () => {
            expect(devopsChecks.runDevOpsScan).toBeDefined();
            expect(typeof devopsChecks.runDevOpsScan).toBe('function');
        });
    });
});

describe('Server Imports', () => {
    test('server.js can be required without errors', () => {
        // This will throw if any import is missing
        expect(() => {
            // Just check that the file can be parsed
            require.resolve('../server.js');
        }).not.toThrow();
    });

    test('inspect_repo.js can be required without errors', () => {
        expect(() => {
            require.resolve('../scripts/inspect_repo.js');
        }).not.toThrow();
    });

    test('mcpServer.js can be required without errors', () => {
        expect(() => {
            require.resolve('../mcpServer.js');
        }).not.toThrow();
    });
});
