'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadConfig(overrides) {
    const saved = { ...process.env };
    Object.assign(process.env, {
        WEBHOOK_URL: 'http://webhook.test/hook',
        WEBHOOK_SECRET: 'secret',
        ...overrides
    });
    const resolved = require.resolve('../src/config.js', { paths: [__dirname] });
    delete require.cache[resolved];
    try {
        return require(resolved);
    } finally {
        delete require.cache[resolved];
        for (const key of Object.keys(process.env)) {
            if (!(key in saved)) delete process.env[key];
        }
        Object.assign(process.env, saved);
    }
}

test('MAX_XML_BYTES defaults to the 8 MB the backend accepts', () => {
    assert.equal(loadConfig({ MAX_XML_BYTES: '' }).MAX_XML_BYTES_NUM, 8 * 1024 * 1024);
});

test('MAX_XML_BYTES above the limit is lowered instead of stopping the processor', () => {
    // 10 MB is what earlier releases wrote into .env.
    assert.equal(loadConfig({ MAX_XML_BYTES: '10485760' }).MAX_XML_BYTES_NUM, 8 * 1024 * 1024);
});

test('MAX_XML_BYTES below the limit is kept', () => {
    assert.equal(loadConfig({ MAX_XML_BYTES: '4096' }).MAX_XML_BYTES_NUM, 4096);
});
