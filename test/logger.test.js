'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('logger.error includes nested cause details when available', () => {
    const { error } = require('../src/logger');
    const originalError = console.error;
    const lines = [];

    console.error = (line) => {
        lines.push(String(line));
    };

    try {
        const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:9000'), {
            code: 'ECONNREFUSED'
        });
        const wrapped = Object.assign(new Error('S3 upload failed'), {
            name: 'TemporaryProcessingError',
            kind: 'temporary',
            cause
        });

        error('processor', 'deferred message', wrapped, { emailId: 'abc123' });
    } finally {
        console.error = originalError;
    }

    assert.equal(lines.length, 1);

    const line = lines[0];
    const meta = JSON.parse(line.slice(line.indexOf('{')));

    assert.equal(meta.emailId, 'abc123');
    assert.equal(meta.error, 'S3 upload failed');
    assert.equal(meta.name, 'TemporaryProcessingError');
    assert.equal(meta.kind, 'temporary');
    assert.equal(meta.causeError, 'connect ECONNREFUSED 10.0.0.5:9000');
    assert.equal(meta.causeCode, 'ECONNREFUSED');
});
