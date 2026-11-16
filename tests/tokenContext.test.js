// tests/tokenContext.test.js
const {
    runWithUserToken,
    getContextToken,
    setFallbackToken,
    getEffectiveToken
} = require('../src/services/tokenContext');

describe('tokenContext', () => {
    afterEach(() => {
        // The fallback token is module-level state — reset between tests.
        setFallbackToken(null);
    });

    test('no context token outside runWithUserToken', () => {
        expect(getContextToken()).toBeNull();
        expect(getEffectiveToken()).toBeNull();
    });

    test('context token is visible inside runWithUserToken', () => {
        const seen = runWithUserToken('ctx-token', () => getContextToken());
        expect(seen).toBe('ctx-token');
    });

    test('context token survives awaits inside the run', async () => {
        const seen = await runWithUserToken('ctx-token', async () => {
            await new Promise(resolve => setImmediate(resolve));
            await Promise.resolve();
            return getContextToken();
        });
        expect(seen).toBe('ctx-token');
    });

    test('context does not leak after the run completes', async () => {
        await runWithUserToken('ctx-token', async () => {
            expect(getContextToken()).toBe('ctx-token');
        });
        expect(getContextToken()).toBeNull();
    });

    test('concurrent runs keep their own tokens', async () => {
        const run = (token, delay) => runWithUserToken(token, async () => {
            await new Promise(resolve => setTimeout(resolve, delay));
            return getContextToken();
        });
        const [a, b] = await Promise.all([run('token-a', 20), run('token-b', 1)]);
        expect(a).toBe('token-a');
        expect(b).toBe('token-b');
    });

    test('explicit token wins over context token', () => {
        const seen = runWithUserToken('ctx-token', () => getEffectiveToken('explicit-token'));
        expect(seen).toBe('explicit-token');
    });

    test('context token wins over fallback token', () => {
        setFallbackToken('fallback-token');
        const seen = runWithUserToken('ctx-token', () => getEffectiveToken());
        expect(seen).toBe('ctx-token');
    });

    test('fallback token is used when there is no context', () => {
        setFallbackToken('fallback-token');
        expect(getEffectiveToken()).toBe('fallback-token');
        expect(getEffectiveToken(null)).toBe('fallback-token');
    });

    test('explicit token wins over fallback token', () => {
        setFallbackToken('fallback-token');
        expect(getEffectiveToken('explicit-token')).toBe('explicit-token');
    });

    test('a null context token falls through to the fallback', () => {
        setFallbackToken('fallback-token');
        const seen = runWithUserToken(null, () => getEffectiveToken());
        expect(seen).toBe('fallback-token');
    });

    test('runWithUserToken returns the callback result', async () => {
        await expect(runWithUserToken('t', async () => 42)).resolves.toBe(42);
        expect(runWithUserToken('t', () => 'sync')).toBe('sync');
    });
});
