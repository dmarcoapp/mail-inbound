'use strict';

const crypto = require('crypto');
const { request } = require('undici');
const { info } = require('../logger');

function getWebhookConfig() {
    const { WEBHOOK_URL, WEBHOOK_SECRET, WEBHOOK_TIMEOUT_MS_NUM } = require('../config');
    return { WEBHOOK_URL, WEBHOOK_SECRET, WEBHOOK_TIMEOUT_MS_NUM };
}

function signWebhook(bodyString) {
    const { WEBHOOK_SECRET } = getWebhookConfig();
    const ts = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${ts}.${bodyString}`;
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
    return { timestamp: ts, signatureHeader: `sha256=${sig}` };
}

function isHttpSuccess(status) {
    return status >= 200 && status < 300;
}

function isHttpRetryableClientFailure(status) {
    return status === 408 || status === 409 || status === 425 || status === 429;
}

function isHttpPermanentFailure(status) {
    return status >= 400 && status < 500 && !isHttpRetryableClientFailure(status);
}

async function postWebhook(payload) {
    const { WEBHOOK_URL, WEBHOOK_TIMEOUT_MS_NUM } = getWebhookConfig();
    const body = JSON.stringify(payload);
    const { timestamp, signatureHeader } = signWebhook(body);

    const headers = {
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signatureHeader,
        'x-request-id': payload.email_id
    };

    const attachmentCount = Array.isArray(payload?.attachments) ? payload.attachments.length : 0;
    info('webhook', 'request', {
        emailId: payload?.email_id || '',
        attachments: attachmentCount
    });

    const res = await request(WEBHOOK_URL, {
        method: 'POST',
        headers,
        body,
        headersTimeout: WEBHOOK_TIMEOUT_MS_NUM,
        bodyTimeout: WEBHOOK_TIMEOUT_MS_NUM
    });

    const status = res.statusCode;

    let seen = 0;
    const limit = 64 * 1024;
    if (res.body) {
        try {
            for await (const chunk of res.body) {
                seen += chunk?.length || 0;
                if (seen > limit) {
                    try {
                        res.body.destroy?.(new Error('response body too large'));
                    } catch {
                    }
                    break;
                }
            }
        } catch {
        }
    }

    info('webhook', 'response', { status });

    return status;
}

module.exports = { postWebhook, isHttpSuccess, isHttpPermanentFailure, isHttpRetryableClientFailure };
