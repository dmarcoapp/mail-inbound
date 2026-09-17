'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
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

function freshValidateRequire() {
    const resolved = require.resolve('../src/auth/validate', { paths: [__dirname] });
    delete require.cache[resolved];
    return require(resolved);
}

async function withTempMessage(contents, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(dir, 'message.eml');
    await fs.writeFile(filePath, contents);
    try {
        await fn(filePath);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const MESSAGE = [
    'From: sender@example.test',
    'To: reports@example.test',
    'Message-ID: <msg-1@example.test>',
    '',
    'body',
    ''
].join('\r\n');

const PARSED = { from: { value: [{ address: 'sender@example.test' }] } };

test('validateMessageAuthentication closes the message stream when the check fails', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        SMTP_HOSTNAME: 'mx.example.test'
    });

    // This authenticate leaves the stream alone, so whatever state it ends up
    // in is the caller's doing.
    let messageStream = null;
    const restoreMailauth = mockModule('mailauth', {
        authenticate: async (stream) => {
            messageStream = stream;
            const err = new Error('auth-down');
            err.code = 'EIO';
            throw err;
        }
    });

    try {
        const { validateMessageAuthentication } = freshValidateRequire();
        await withTempMessage(MESSAGE, async (filePath) => {
            await assert.rejects(
                () => validateMessageAuthentication(filePath, {
                    parsed: PARSED,
                    delivery: { mailFrom: 'sender@example.test', clientIp: '192.0.2.1' }
                }),
                (err) => err?.name === 'TemporaryProcessingError' && err?.kind === 'temporary'
            );
        });
    } finally {
        restoreMailauth();
        restoreConfig();
    }

    // An abandoned read stream holds a file descriptor open, and emits an
    // unhandled 'error' when the file is moved to the retry queue while its
    // open is still in flight, which takes the whole processor down.
    assert.ok(messageStream);
    assert.equal(messageStream.destroyed, true);
    assert.ok(messageStream.listenerCount('error') > 0);
});
