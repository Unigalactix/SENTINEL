/**
 * Unit tests for GitHub Issue Service helpers.
 * Covers pure helpers that do not make HTTP requests.
 */

const {
    parseBodyDirective,
    derivePriority,
    mapIssue,
    parseIssueNumber
} = require('../src/services/githubIssueService');

describe('githubIssueService helpers', () => {
    describe('parseBodyDirective', () => {
        test('parses bold style **repo:** owner/name', () => {
            const body = '**repo:** Unigalactix/SENTINEL\nSome description';
            expect(parseBodyDirective(body, 'repo')).toBe('Unigalactix/SENTINEL');
        });

        test('parses plain style key: value', () => {
            const body = 'language: node\nbuild: npm test';
            expect(parseBodyDirective(body, 'language')).toBe('node');
            expect(parseBodyDirective(body, 'build')).toBe('npm test');
        });

        test('is case insensitive on the key', () => {
            const body = '**Repo:** owner/name';
            expect(parseBodyDirective(body, 'repo')).toBe('owner/name');
        });

        test('returns null when key is missing', () => {
            expect(parseBodyDirective('hello world', 'repo')).toBeNull();
        });

        test('returns null on non-string body', () => {
            expect(parseBodyDirective(null, 'repo')).toBeNull();
            expect(parseBodyDirective(undefined, 'repo')).toBeNull();
            expect(parseBodyDirective({}, 'repo')).toBeNull();
        });
    });

    describe('derivePriority', () => {
        test('returns Highest for priority:critical or priority:highest label', () => {
            expect(derivePriority([{ name: 'priority:critical' }])).toBe('Highest');
            expect(derivePriority([{ name: 'priority:highest' }])).toBe('Highest');
        });

        test('returns High for priority:high label', () => {
            expect(derivePriority([{ name: 'priority:high' }])).toBe('High');
        });

        test('returns Low for priority:low label', () => {
            expect(derivePriority([{ name: 'priority:low' }])).toBe('Low');
        });

        test('returns Medium when no priority label is present', () => {
            expect(derivePriority([{ name: 'sentinel:todo' }, { name: 'bug' }])).toBe('Medium');
            expect(derivePriority([])).toBe('Medium');
        });

        test('handles plain string labels', () => {
            expect(derivePriority(['priority:high'])).toBe('High');
        });

        test('handles non-array input gracefully', () => {
            expect(derivePriority(null)).toBe('Medium');
            expect(derivePriority(undefined)).toBe('Medium');
        });
    });

    describe('mapIssue', () => {
        test('maps a basic open issue into Sentinel shape', () => {
            const raw = {
                number: 42,
                title: 'Add CI for new repo',
                body: '**repo:** Unigalactix/sample-node-project\nlanguage: node\nPlease add CI.',
                labels: [{ name: 'sentinel:todo' }, { name: 'priority:high' }]
            };

            const mapped = mapIssue(raw);

            expect(mapped.id).toBe(42);
            expect(mapped.number).toBe(42);
            expect(mapped.key).toBe('GH-42');
            expect(mapped.fields.summary).toBe('Add CI for new repo');
            expect(mapped.fields.priority.name).toBe('High');
            expect(mapped.fields.repo).toBe('Unigalactix/sample-node-project');
            expect(mapped.fields.language).toBe('node');
        });

        test('handles empty body and missing labels gracefully', () => {
            const raw = { number: 7, title: 'Empty', body: null };
            const mapped = mapIssue(raw);
            expect(mapped.key).toBe('GH-7');
            expect(mapped.fields.priority.name).toBe('Medium');
            expect(mapped.fields.repo).toBeNull();
        });
    });

    describe('parseIssueNumber', () => {
        test('extracts number from a valid GH key', () => {
            expect(parseIssueNumber('GH-123')).toBe(123);
            expect(parseIssueNumber('gh-9')).toBe(9);
        });

        test('throws on invalid format', () => {
            expect(() => parseIssueNumber('ABC-1')).toThrow(/Invalid issue key/);
            expect(() => parseIssueNumber('GH-')).toThrow(/Invalid issue key/);
            expect(() => parseIssueNumber('123')).toThrow(/Invalid issue key/);
        });
    });
});
