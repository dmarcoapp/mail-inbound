'use strict';

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createServer,
    verifyWebhookSignature
} = require('../src/dev/webhookReceiver');

function sign({ body, timestamp, secret }) {
    return `sha256=${crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex')}`;
}

test('verifyWebhookSignature accepts valid signatures and rejects invalid ones', () => {
    const body = JSON.stringify({ email_id: 'id-1' });
    const timestamp = '1000';
    const secret = 'dev-secret';

    assert.equal(verifyWebhookSignature({
        body,
        timestamp,
        secret,
        signatureHeader: sign({ body, timestamp, secret }),
        nowSeconds: 1000
    }), true);

    assert.equal(verifyWebhookSignature({
        body,
        timestamp,
        secret,
        signatureHeader: 'sha256=bad',
        nowSeconds: 1000
    }), false);
});

test('createServer returns a dev webhook http server', () => {
    const server = createServer({ secret: 'dev-secret' });

    assert.equal(typeof server.listen, 'function');
    assert.equal(typeof server.close, 'function');
    assert.equal(server.listening, false);
});
