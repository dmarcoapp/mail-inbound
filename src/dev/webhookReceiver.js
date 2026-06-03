'use strict';

const crypto = require('crypto');
const http = require('http');
const { readSecret } = require('../utils');
const { info, warn, error } = require('../logger');

const PORT = Number(process.env.WEBHOOK_DEV_PORT || '3000');
const MAX_BODY_BYTES = Number(process.env.WEBHOOK_DEV_MAX_BODY_BYTES || String(1024 * 1024));
const MAX_CLOCK_SKEW_SECONDS = Number(process.env.WEBHOOK_DEV_MAX_CLOCK_SKEW_SECONDS || '900');

function getWebhookSecret() {
    try {
        return readSecret('webhook_secret', 'WEBHOOK_SECRET');
    } catch (err) {
        warn('webhook-dev', 'webhook secret unavailable; signature verification disabled', {
            error: String(err?.message || err)
        });
        return '';
    }
}

function safeEqualHex(left, right) {
    const leftBuffer = Buffer.from(String(left || ''), 'hex');
    const rightBuffer = Buffer.from(String(right || ''), 'hex');
    if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyWebhookSignature({ body, timestamp, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
    if (!secret) return true;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_CLOCK_SKEW_SECONDS) {
        return false;
    }

    const signature = String(signatureHeader || '').replace(/^sha256=/i, '');
    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

    return safeEqualHex(signature, expected);
}

async function readBody(req) {
    const chunks = [];
    let seen = 0;

    for await (const chunk of req) {
        seen += chunk.length;
        if (seen > MAX_BODY_BYTES) {
            throw Object.assign(new Error('request body too large'), { statusCode: 413 });
        }
        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, statusCode, payload) {
    if (statusCode === 204) {
        res.writeHead(204);
        res.end();
        return;
    }

    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
    });
    res.end(body);
}

function createServer({ secret = getWebhookSecret() } = {}) {
    return http.createServer(async (req, res) => {
        try {
            if (req.method !== 'POST' || req.url !== '/inbound-email') {
                sendJson(res, 404, { ok: false });
                return;
            }

            const body = await readBody(req);
            const verified = verifyWebhookSignature({
                body,
                timestamp: req.headers['x-timestamp'],
                signatureHeader: req.headers['x-signature'],
                secret
            });

            if (!verified) {
                warn('webhook-dev', 'rejected request with invalid signature', {
                    requestId: String(req.headers['x-request-id'] || '')
                });
                sendJson(res, 401, { ok: false });
                return;
            }

            let payload = {};
            try {
                payload = JSON.parse(body);
            } catch {
                sendJson(res, 400, { ok: false });
                return;
            }

            info('webhook-dev', 'accepted webhook', {
                emailId: payload?.email_id || '',
                attachments: Array.isArray(payload?.attachments) ? payload.attachments.length : 0,
                reportType: payload?.report_type || ''
            });

            sendJson(res, 204, {});
        } catch (err) {
            const statusCode = Number(err?.statusCode || 500);
            error('webhook-dev', 'request failed', err);
            sendJson(res, statusCode, { ok: false });
        }
    });
}

if (require.main === module) {
    const server = createServer();
    server.listen(PORT, '0.0.0.0', () => {
        info('webhook-dev', 'listening', { port: PORT });
    });
}

module.exports = {
    createServer,
    verifyWebhookSignature
};
