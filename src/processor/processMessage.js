'use strict';

const fs = require('fs');
const { promisify } = require('util');
const zlib = require('zlib');
const { simpleParser } = require('mailparser');
const { validateAttachmentsOrThrow, getSafeFilename } = require('../policy/attachmentPolicy');
const { extractXmlFromFile } = require('../attachments/extractXml');
const { validateAggregateDmarcReport } = require('../dmarc/validateReport');
const { scanFileWithClamav } = require('../clamav/scan');
const { validateMessageAuthentication } = require('../auth/validate');
const { storeStreamToTmpFile } = require('../io/storeStreamToTmpFile');
const { safeUnlink } = require('../io/tmp');
const {
    postWebhook,
    isHttpSuccess,
    isHttpPermanentFailure,
    isHttpDeadLetterFailure
} = require('../webhook/post');
const { sha256Hex } = require('../utils');
const { info, warn, error } = require('../logger');
const {
    PermanentProcessingError,
    TemporaryProcessingError,
    DeadLetterProcessingError,
    isPermanentProcessingError,
    isTemporaryProcessingError,
    isDeadLetterProcessingError
} = require('../processingErrors');

const gzip = promisify(zlib.gzip);

// PHP's default post_max_size, which the backend runs with. A report goes in
// the webhook gzip-compressed, so even the largest one the limits allow is
// usually a fraction of this. One that is not is turned away here, where the
// message is still on hand, rather than lost as an unreadable request.
const WEBHOOK_MAX_BODY_BYTES = 8 * 1024 * 1024;

const RETRYABLE_LOCAL_ERROR_CODES = new Set([
    'EACCES',
    'EBUSY',
    'EIO',
    'EMFILE',
    'ENFILE',
    'ENOENT',
    'ENOSPC',
    'EPERM'
]);

async function sha256File(filePath) {
    const hash = sha256Hex();
    await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(filePath);
        rs.on('error', reject);
        rs.on('data', chunk => hash.update(chunk));
        rs.on('end', resolve);
    });
    return hash.digest('hex');
}

function toPreparedCleanupPaths(tmpPath, extracted) {
    return Array.from(new Set([tmpPath, ...(extracted?.cleanupPaths || [])].filter(Boolean)));
}

function normalizeProcessingError(err) {
    if (
        err instanceof PermanentProcessingError
        || err instanceof TemporaryProcessingError
        || err instanceof DeadLetterProcessingError
    ) {
        return err;
    }

    if (isTemporaryProcessingError(err)) {
        return new TemporaryProcessingError(String(err?.message || 'Message deferred'), { cause: err });
    }

    if (isPermanentProcessingError(err)) {
        return new PermanentProcessingError(String(err?.message || 'Message rejected'), { cause: err });
    }

    if (isDeadLetterProcessingError(err)) {
        return new DeadLetterProcessingError(String(err?.message || 'Message held'), { cause: err });
    }

    return null;
}

async function prepareAttachment(att) {
    const filename = getSafeFilename(att);
    const stored = await storeStreamToTmpFile(att.content, 'att');

    let extracted;
    try {
        extracted = await extractXmlFromFile({ filePath: stored.filePath, filename });
        await validateAggregateDmarcReport({ filePath: extracted.filePath });
        return {
            filePath: extracted.filePath,
            filename: extracted.filename,
            contentType: extracted.contentType || 'application/xml',
            cleanupPaths: toPreparedCleanupPaths(stored.filePath, extracted)
        };
    } catch (err) {
        await safeUnlink(stored.filePath);
        throw err;
    }
}

function wrapPermanent(err, fallbackMessage = 'Message rejected') {
    const normalized = normalizeProcessingError(err);
    if (normalized) return normalized;
    return new PermanentProcessingError(String(err?.message || fallbackMessage), { cause: err });
}

function isRetryableLocalFailure(err) {
    return RETRYABLE_LOCAL_ERROR_CODES.has(String(err?.code || ''));
}

function wrapProcessingError(
    err,
    {
        permanentMessage = 'Message rejected',
        temporaryMessage = 'Message deferred: local processing failed'
    } = {}
) {
    const normalized = normalizeProcessingError(err);
    if (normalized) return normalized;

    if (isRetryableLocalFailure(err)) {
        return new TemporaryProcessingError(temporaryMessage, { cause: err });
    }

    return new PermanentProcessingError(String(err?.message || permanentMessage), { cause: err });
}

async function encodePreparedAttachment(prepared) {
    let content;
    try {
        content = (await gzip(await fs.promises.readFile(prepared.filePath))).toString('base64');
    } catch (err) {
        throw wrapProcessingError(err, {
            temporaryMessage: 'Message deferred: failed to read the extracted report'
        });
    }

    return {
        filename: prepared.filename,
        content_type: prepared.contentType,
        content
    };
}

async function deliverWebhook(payload) {
    let status;
    try {
        status = await postWebhook(payload);
    } catch (err) {
        throw new TemporaryProcessingError('Webhook request failed', { cause: err });
    }

    if (isHttpSuccess(status)) {
        return status;
    }

    if (isHttpPermanentFailure(status)) {
        throw new PermanentProcessingError(`Webhook rejected payload with status ${status}`);
    }

    if (isHttpDeadLetterFailure(status)) {
        throw new DeadLetterProcessingError(`Webhook refused payload with status ${status}`);
    }

    throw new TemporaryProcessingError(`Webhook temporary failure with status ${status}`);
}

async function processMessageFile(
    filePath,
    {
        envelopeRecipients = [],
        delivery = {}
    } = {}
) {
    const emailId = await sha256File(filePath);
    const createdAt = new Date().toISOString();
    const preparedAttachments = [];
    const encodedAttachments = [];
    let parsed = null;
    let authResults = {
        spf: 'none',
        dkim: 'none',
        dmarc: 'none',
        dmarcPolicy: 'none'
    };

    const recipients = Array.isArray(envelopeRecipients) && envelopeRecipients.length > 0
        ? envelopeRecipients.slice()
        : (Array.isArray(delivery?.recipients) ? delivery.recipients.slice() : []);

    try {
        try {
            const scanResult = await scanFileWithClamav(filePath);
            if (!scanResult?.clean) {
                throw new PermanentProcessingError(`Message rejected: malware detected (${scanResult?.virus || 'unknown'})`);
            }
        } catch (err) {
            const normalized = normalizeProcessingError(err);
            if (normalized) throw normalized;
            throw new TemporaryProcessingError('Message deferred: ClamAV scan failed', { cause: err });
        }

        const messageStream = fs.createReadStream(filePath);
        // simpleParser stops reading when it throws, but it does not close the
        // stream, and an 'error' with no listener is an uncaught exception. A
        // failed parse leaves the file on its way to the retry queue, so the
        // pending open can still fail after we are done with it.
        messageStream.on('error', () => {});

        try {
            parsed = await simpleParser(messageStream, { streamAttachments: true });
        } catch (err) {
            messageStream.destroy();
            throw wrapProcessingError(err, {
                permanentMessage: 'Failed to parse message',
                temporaryMessage: 'Message deferred: failed to read message'
            });
        }

        try {
            authResults = await validateMessageAuthentication(filePath, {
                parsed,
                delivery
            });
        } catch (err) {
            const normalized = normalizeProcessingError(err);
            if (normalized) throw normalized;
            throw new TemporaryProcessingError('Message deferred: authentication checks unavailable', { cause: err });
        }

        let attachments;
        try {
            attachments = validateAttachmentsOrThrow(parsed.attachments || []);
        } catch (err) {
            throw wrapPermanent(err);
        }

        for (const att of attachments) {
            try {
                preparedAttachments.push(await prepareAttachment(att));
            } catch (err) {
                throw wrapProcessingError(err, {
                    temporaryMessage: 'Message deferred: attachment processing failed'
                });
            }
        }

        for (const prepared of preparedAttachments) {
            encodedAttachments.push(await encodePreparedAttachment(prepared));
        }

        const payload = {
            email_id: emailId,
            created_at: createdAt,
            from: parsed.from?.text || '',
            to: recipients,
            message_id: parsed.messageId || '',
            report_type: 'dmarc_aggregate',
            attachments: encodedAttachments
        };

        if (Buffer.byteLength(JSON.stringify(payload)) > WEBHOOK_MAX_BODY_BYTES) {
            throw new PermanentProcessingError('Message rejected: report too large to forward');
        }

        await deliverWebhook(payload);

        info('processor', 'accepted message', {
            emailId,
            attachments: encodedAttachments.length,
            spf: authResults.spf,
            dkim: authResults.dkim,
            dmarc: authResults.dmarc,
            dmarcPolicy: authResults.dmarcPolicy
        });

        return {
            emailId,
            attachments: encodedAttachments.length,
            payload
        };
    } catch (err) {
        if (isTemporaryProcessingError(err)) {
            error('processor', 'deferred message', err, { emailId });
            throw err;
        }

        if (isDeadLetterProcessingError(err)) {
            error('processor', 'held message for the dead-letter directory', err, { emailId });
            throw err;
        }

        warn('processor', 'rejected message', {
            emailId,
            message: String(err?.message || 'Message rejected')
        });
        throw err;
    } finally {
        for (const prepared of preparedAttachments) {
            for (const cleanupPath of prepared.cleanupPaths) {
                await safeUnlink(cleanupPath);
            }
        }

        if (parsed?.attachments) {
            for (const attachment of parsed.attachments) {
                try { attachment?.content?.destroy?.(); } catch {}
            }
        }
    }
}

module.exports = {
    processMessageFile,
    sha256File
};
