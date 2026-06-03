'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function mockModule(modulePath, exports) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    const prev = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return () => {
        if (prev) require.cache[resolved] = prev;
        else delete require.cache[resolved];
    };
}

function freshReplayRequire(options = {}) {
    const calls = [];
    const restoreIndex = mockModule(path.resolve(__dirname, '../src/index.js'), {
        ensureInputDir: async () => {
            calls.push('ensure');
        },
        replayDeadLetters: async () => {
            calls.push('replay');
            return options.result || { replayed: [], failed: [], remaining: 0 };
        }
    });
    const restoreLogger = mockModule(path.resolve(__dirname, '../src/logger.js'), {
        info: (...args) => {
            calls.push(['info', ...args]);
        },
        error: (...args) => {
            calls.push(['error', ...args]);
        }
    });

    const resolved = require.resolve('../src/replayDeadLetter.js', { paths: [__dirname] });
    delete require.cache[resolved];
    const mod = require(resolved);

    return {
        calls,
        mod,
        restore() {
            delete require.cache[resolved];
            restoreLogger();
            restoreIndex();
        }
    };
}

test('replayDeadLetter main initializes directories before replaying', async () => {
    const { calls, mod, restore } = freshReplayRequire({
        result: { replayed: ['a'], failed: [], remaining: 0 }
    });

    try {
        await mod.main();
    } finally {
        restore();
    }

    assert.equal(calls[0], 'ensure');
    assert.equal(calls[1], 'replay');
    assert.deepEqual(calls[2], [
        'info',
        'dead-letter',
        'replay completed',
        { replayed: 1, failed: 0, remaining: 0 }
    ]);
});
