'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function freshRequire(modulePath) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    delete require.cache[resolved];
    return require(resolved);
}

test('postWebhook sends signed request and returns status', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        WEBHOOK_URL: 'https://example.test/hook',
        WEBHOOK_SECRET: 'secret',
        WEBHOOK_TIMEOUT_MS_NUM: 100
    });

    let seen = null;
    const restoreUndici = mockModule('undici', {
        request: async (url, opts) => {
            seen = { url, opts };
            return {
                statusCode: 204,
                body: (async function* () {
                    yield Buffer.from('ok');
                })()
            };
        }
    });

    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000; // fixed timestamp

    try {
        const { postWebhook } = freshRequire('../src/webhook/post');
        const status = await postWebhook({ email_id: 'abc123', foo: 'bar' });

        assert.equal(status, 204);
        assert.equal(seen.url, 'https://example.test/hook');
        assert.equal(seen.opts.method, 'POST');
        assert.equal(seen.opts.headers['x-request-id'], 'abc123');

        const body = seen.opts.body;
        const ts = Math.floor(Date.now() / 1000).toString();
        const sig = crypto.createHmac('sha256', 'secret')
            .update(`${ts}.${body}`)
            .digest('hex');
        assert.equal(seen.opts.headers['x-timestamp'], ts);
        assert.equal(seen.opts.headers['x-signature'], `sha256=${sig}`);
    } finally {
        Date.now = originalNow;
        restoreUndici();
        restoreConfig();
    }
});

test('isHttpSuccess and client failure helpers classify correctly', () => {
    const { isHttpSuccess, isHttpPermanentFailure, isHttpRetryableClientFailure } = require('../src/webhook/post');
    assert.equal(isHttpSuccess(200), true);
    assert.equal(isHttpSuccess(299), true);
    assert.equal(isHttpSuccess(300), false);

    assert.equal(isHttpPermanentFailure(399), false);
    assert.equal(isHttpPermanentFailure(400), true);
    assert.equal(isHttpPermanentFailure(408), false);
    assert.equal(isHttpPermanentFailure(409), false);
    assert.equal(isHttpPermanentFailure(425), false);
    assert.equal(isHttpPermanentFailure(429), false);
    assert.equal(isHttpPermanentFailure(499), true);
    assert.equal(isHttpPermanentFailure(500), false);

    assert.equal(isHttpRetryableClientFailure(408), true);
    assert.equal(isHttpRetryableClientFailure(409), true);
    assert.equal(isHttpRetryableClientFailure(425), true);
    assert.equal(isHttpRetryableClientFailure(429), true);
    assert.equal(isHttpRetryableClientFailure(404), false);
});

test('postWebhook handles missing body and oversized body', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        WEBHOOK_URL: 'https://example.test/hook',
        WEBHOOK_SECRET: 'secret',
        WEBHOOK_TIMEOUT_MS_NUM: 100
    });

    const restoreUndici = mockModule('undici', {
        request: async () => ({ statusCode: 200 })
    });

    try {
        const { postWebhook } = freshRequire('../src/webhook/post');
        const status = await postWebhook({ email_id: 'id1' });
        assert.equal(status, 200);
    } finally {
        restoreUndici();
    }

    const restoreUndici2 = mockModule('undici', {
        request: async () => ({
            statusCode: 200,
            body: (async function* () {
                yield Buffer.alloc(70 * 1024, 'a');
                yield Buffer.alloc(10, 'b');
            })()
        })
    });

    try {
        const { postWebhook } = freshRequire('../src/webhook/post');
        const status = await postWebhook({ email_id: 'id2' });
        assert.equal(status, 200);
    } finally {
        restoreUndici2();
        restoreConfig();
    }
});

test('postWebhook tolerates response body read errors', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        WEBHOOK_URL: 'https://example.test/hook',
        WEBHOOK_SECRET: 'secret',
        WEBHOOK_TIMEOUT_MS_NUM: 100
    });

    const restoreUndici = mockModule('undici', {
        request: async () => ({
            statusCode: 200,
            body: (async function* () {
                throw new Error('read-fail');
            })()
        })
    });

    try {
        const { postWebhook } = freshRequire('../src/webhook/post');
        const status = await postWebhook({ email_id: 'id3' });
        assert.equal(status, 200);
    } finally {
        restoreUndici();
        restoreConfig();
    }
});

test('postWebhook does not log raw payload body', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        WEBHOOK_URL: 'https://example.test/hook',
        WEBHOOK_SECRET: 'secret',
        WEBHOOK_TIMEOUT_MS_NUM: 100
    });

    const restoreUndici = mockModule('undici', {
        request: async () => ({
            statusCode: 200,
            body: (async function* () {
                yield Buffer.from('ok');
            })()
        })
    });

    const originalLog = console.log;
    const seenLogs = [];
    console.log = (...args) => seenLogs.push(args.map(String).join(' '));

    try {
        const { postWebhook } = freshRequire('../src/webhook/post');
        await postWebhook({ email_id: 'id-privacy', from: 'sensitive@example.test', attachments: [{ id: '1' }] });
    } finally {
        console.log = originalLog;
        restoreUndici();
        restoreConfig();
    }

    const flattened = seenLogs.join('\n');
    assert.ok(/"emailId":"id-privacy"/.test(flattened));
    assert.equal(flattened.includes('sensitive@example.test'), false);
});

test('postWebhook tolerates destroy errors when body exceeds limit', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        WEBHOOK_URL: 'https://example.test/hook',
        WEBHOOK_SECRET: 'secret',
        WEBHOOK_TIMEOUT_MS_NUM: 100
    });

    let destroyCalled = false;
    const body = {
        async *[Symbol.asyncIterator]() {
            yield Buffer.alloc(70 * 1024, 'a');
            yield Buffer.from('ignored');
        },
        destroy() {
            destroyCalled = true;
            throw new Error('destroy-fail');
        }
    };

    const restoreUndici = mockModule('undici', {
        request: async () => ({ statusCode: 200, body })
    });

    try {
        const { postWebhook } = freshRequire('../src/webhook/post');
        const status = await postWebhook({ email_id: 'id-destroy' });
        assert.equal(status, 200);
        assert.equal(destroyCalled, true);
    } finally {
        restoreUndici();
        restoreConfig();
    }
});
