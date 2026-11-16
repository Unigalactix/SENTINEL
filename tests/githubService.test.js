// tests/githubService.test.js

// Shared mock for repos.getContent, bound into every mock Octokit instance
// below so tests can control what the service "fetches" from GitHub.
//
// The mock instances MUST include `hook: { error: jest.fn() }`:
// githubService wraps every client with addErrorLogging(), which calls
// client.hook.error('request', ...). Without a hook API, client creation
// throws, detectRepoLanguage catches the error and silently falls back to
// its 'node' default — which is why the .NET detection test used to fail.
const mockGetContent = jest.fn();

jest.mock('@octokit/rest', () => {
    return {
        Octokit: jest.fn().mockImplementation(() => ({
            hook: { error: jest.fn() },
            repos: {
                getContent: mockGetContent
            },
            // Add other namespaces if needed for initialization
            git: { getRef: jest.fn(), createRef: jest.fn() },
            pulls: { create: jest.fn(), list: jest.fn() }
        }))
    };
});

const { generateWorkflowFile, detectRepoLanguage } = require('../src/services/githubService');

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
            expect(yaml).toContain('Setup Node.js');
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

    // --- generateDockerfile Tests ---
    describe('generateDockerfile', () => {
        const { generateDockerfile } = require('../src/services/githubService');

        test('should generate Node.js Dockerfile', () => {
            const dockerfile = generateDockerfile('node');
            expect(dockerfile).toContain('FROM node:20-alpine');
            expect(dockerfile).toContain('CMD ["npm", "start"]');
        });

        test('should generate Python Dockerfile', () => {
            const dockerfile = generateDockerfile('python');
            expect(dockerfile).toContain('FROM python:3.9-slim');
            expect(dockerfile).toContain('requirements.txt');
        });

        test('should generate .NET Dockerfile', () => {
            const dockerfile = generateDockerfile('dotnet');
            expect(dockerfile).toContain('FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build');
            expect(dockerfile).toContain('ENTRYPOINT ["dotnet", "App.dll"]');
        });
    });

    describe('generateWorkflowFile with Security', () => {
        test('should generate CodeQL security job', () => {
            const yaml = generateWorkflowFile({
                language: 'node',
                repoName: 'test/repo',
                buildCommand: 'npm build',
                testCommand: 'npm test'
            });
            expect(yaml).toContain('security-scan:');
            expect(yaml).toContain('github/codeql-action/init@v3');
            expect(yaml).toContain('languages: ${{ env.CODEQL_LANGUAGE }}');
            expect(yaml).toContain('CODEQL_LANGUAGE: javascript');
        });

        test('should include docker ACR build/push for docker', () => {
            const yaml = generateWorkflowFile({
                language: 'python',
                repoName: 'test/repo',
                buildCommand: 'build',
                testCommand: 'test',
                deployTarget: 'docker'
            });
            expect(yaml).toContain('docker-build:');
            expect(yaml).toContain('docker/build-push-action@v5');
            expect(yaml).toContain('secrets.ACR_LOGIN_SERVER');
        });
    });

    describe('generateWorkflowFile with Docker', () => {
        test('should generate Docker build/push workflow', () => {
            const yaml = generateWorkflowFile({
                language: 'node',
                repoName: 'test/repo',
                buildCommand: 'npm build',
                testCommand: 'npm test',
                deployTarget: 'docker'
            });
            expect(yaml).toContain('docker-build:');
            expect(yaml).toContain('docker/login-action@v3');
            expect(yaml).toContain('docker/build-push-action@v5');
            expect(yaml).toContain('secrets.ACR_LOGIN_SERVER');
        });
    });
});
