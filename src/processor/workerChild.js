'use strict';

const {
    processMessageFile
} = require('./processMessage');
const {
    isPermanentProcessingError,
    isTemporaryProcessingError
} = require('../processingErrors');

let settled = false;

function sendResult(payload) {
    if (settled) return;
    settled = true;
    if (typeof process.send === 'function') {
        process.send({ type: 'result', ...payload });
    }
}

function toResultFromError(err) {
    if (isPermanentProcessingError(err)) {
        return {
            ok: false,
            kind: 'permanent',
            message: String(err?.message || 'Message rejected')
        };
    }

    if (isTemporaryProcessingError(err)) {
        return {
            ok: false,
            kind: 'temporary',
            message: String(err?.message || 'Message deferred')
        };
    }

    return {
        ok: false,
        kind: 'temporary',
        message: 'Message processing crashed'
    };
}

function failAndExit(err) {
    sendResult(toResultFromError(err));
    process.exit(1);
}

process.on('uncaughtException', failAndExit);
process.on('unhandledRejection', failAndExit);

process.on('message', async (payload) => {
    if (settled) return;

    try {
        await processMessageFile(payload?.filePath, {
            envelopeRecipients: Array.isArray(payload?.envelopeRecipients)
                ? payload.envelopeRecipients
                : [],
            delivery: payload?.delivery && typeof payload.delivery === 'object'
                ? payload.delivery
                : {}
        });
        sendResult({ ok: true });
        process.exit(0);
    } catch (err) {
        sendResult(toResultFromError(err));
        process.exit(0);
    }
});
