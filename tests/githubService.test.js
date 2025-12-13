// tests/githubService.test.js
const { generateWorkflowFile, detectRepoLanguage } = require('../githubService');

// Mock @octokit/rest before requiring the service?
// Since githubService instantiates Octokit immediately on require, we need to mock it carefully.
// However, jest mocks modules.
jest.mock('@octokit/rest', () => {
    return {
        Octokit: jest.fn().mockImplementation(() => ({
            repos: {
                getContent: jest.fn()
            }
        }))
    };
});

// We need to re-require to get the mocked instance if we wanted access to it, 
// but since we are testing exported functions that use the global `octokit` instance inside the module,
// we might need to expose the octokit instance or mock the responses via the mock we just set up.

// Let's get the specific mock function reference
const { Octokit } = require('@octokit/rest');
// The mock instance will be returned by the constructor
const mockGetContent = jest.fn();
Octokit.mockImplementation(() => ({
    repos: {
        getContent: mockGetContent
    },
    // Add other namespaces if needed for initialization
    git: { getRef: jest.fn(), createRef: jest.fn() },
    pulls: { create: jest.fn(), list: jest.fn() }
}));

describe('githubService', () => {

    // --- generateWorkflowFile Tests ---
    describe('generateWorkflowFile', () => {
        test('should generate Node.js workflow correctly', () => {
            const yaml = generateWorkflowFile({
                language: 'node',
                repoName: 'test/repo',
                buildCommand: 'npm run build',
                testCommand: 'npm test'
            });
            expect(yaml).toContain('Set up Node.js');
            expect(yaml).toContain('npm run build');
            expect(yaml).toContain('npm test');
            expect(yaml).toContain('Running NPM Audit');
        });

        test('should generate Python workflow correctly', () => {
            const yaml = generateWorkflowFile({
                language: 'python',
                repoName: 'test/repo',
                buildCommand: 'echo build',
                testCommand: 'pytest'
            });
            expect(yaml).toContain('Set up Python');
            expect(yaml).toContain('pip install -r requirements.txt');
        });

        test('should generate .NET workflow correctly', () => {
            const yaml = generateWorkflowFile({
                language: 'dotnet',
                repoName: 'test/repo',
                buildCommand: 'dotnet build',
                testCommand: 'dotnet test'
            });
            expect(yaml).toContain('Set up .NET');
            expect(yaml).toContain('dotnet restore');
        });
    });

    // --- detectRepoLanguage Tests ---
    describe('detectRepoLanguage', () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('should detect Node.js from package.json', async () => {
            // Setup mock response
            // We need to access the instance that was created inside githubService
            // Since `githubService.js` does `new Octokit()`, our mock implementation logic above 
            // is effectively providing the object that internal code uses.
            // But we need to make sure `mockGetContent` is the same function instance.
            // The approach above defines `mockGetContent` outside.
            // But verify if `Octokit` constructor was called.

            mockGetContent.mockResolvedValue({
                data: [
                    { name: 'README.md' },
                    { name: 'package.json' }
                ]
            });

            const lang = await detectRepoLanguage('owner/repo');
            expect(lang).toBe('node');
        });

        test('should detect .NET from .csproj', async () => {
            mockGetContent.mockResolvedValue({
                data: [
                    { name: 'README.md' },
                    { name: 'App.csproj' }
                ]
            });

            const lang = await detectRepoLanguage('owner/repo');
            expect(lang).toBe('dotnet');
        });

        test('should default to node if no markers found', async () => {
            mockGetContent.mockResolvedValue({
                data: [
                    { name: 'README.md' }
                ]
            });

            const lang = await detectRepoLanguage('owner/repo');
            expect(lang).toBe('node');
        });
    });

});
