'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../src/utils');

test('sha256Hex returns a usable hash', () => {
    const hex = utils.sha256Hex().update('abc').digest('hex');
    assert.equal(hex.length, 64);
});

test('readSecret falls back to env when secret missing', () => {
    const originalRead = require('fs').readFileSync;
    const originalEnv = process.env.TEST_SECRET_FALLBACK;

    process.env.TEST_SECRET_FALLBACK = 'fallback-secret';
    require('fs').readFileSync = () => {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
    };

    try {
        const value = utils.readSecret('missing_secret', 'TEST_SECRET_FALLBACK');
        assert.equal(value, 'fallback-secret');
    } finally {
        require('fs').readFileSync = originalRead;
        if (originalEnv === undefined) delete process.env.TEST_SECRET_FALLBACK;
        else process.env.TEST_SECRET_FALLBACK = originalEnv;
    }
});

test('readSecret throws when secret missing and no env fallback', () => {
    const originalRead = require('fs').readFileSync;
    require('fs').readFileSync = () => {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
    };

    try {
        assert.throws(() => utils.readSecret('missing_secret'), /Missing secret: missing_secret/);
    } finally {
        require('fs').readFileSync = originalRead;
    }
});
