'use strict';

const fs = require('fs');
const { simpleParser } = require('mailparser');
const { validateAttachmentsOrThrow, getSafeFilename } = require('../policy/attachmentPolicy');
const { extractXmlFromFile } = require('../attachments/extractXml');
const { validateAggregateDmarcReport } = require('../dmarc/validateReport');
const { scanFileWithClamav } = require('../clamav/scan');
const { validateMessageAuthentication } = require('../auth/validate');
const { storeStreamToTmpFile } = require('../io/storeStreamToTmpFile');
const { safeUnlink } = require('../io/tmp');
const { uploadToS3 } = require('../s3/upload');
const { deleteFromS3 } = require('../s3/delete');
const { postWebhook, isHttpSuccess, isHttpPermanentFailure } = require('../webhook/post');
const { sha256Hex } = require('../utils');
const { info, warn, error } = require('../logger');
const {
    PermanentProcessingError,
    TemporaryProcessingError,
    isPermanentProcessingError,
    isTemporaryProcessingError
} = require('../processingErrors');

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
    if (err instanceof PermanentProcessingError || err instanceof TemporaryProcessingError) {
        return err;
    }

    if (isTemporaryProcessingError(err)) {
        return new TemporaryProcessingError(String(err?.message || 'Message deferred'), { cause: err });
    }

    if (isPermanentProcessingError(err)) {
        return new PermanentProcessingError(String(err?.message || 'Message rejected'), { cause: err });
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
            id: stored.id,
            filePath: extracted.filePath,
            filename: extracted.filename,
            contentType: extracted.contentType || 'application/xml',
            cleanupPaths: toPreparedCleanupPaths(stored.filePath, extracted),
            contentDisposition: att.contentDisposition || '',
            contentId: att.cid || ''
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

async function uploadPreparedAttachment(prepared) {
    try {
        const s3loc = await uploadToS3({
            key: `attachments/${prepared.id}`,
            filePath: prepared.filePath,
            meta: {
                filename: prepared.filename,
                contentType: prepared.contentType,
                contentDisposition: prepared.contentDisposition,
                contentId: prepared.contentId
            }
        });

        return {
            id: prepared.id,
            bucket: s3loc.bucket,
            key: s3loc.key,
            filename: prepared.filename,
            content_type: prepared.contentType
        };
    } catch (err) {
        throw new TemporaryProcessingError('S3 upload failed', { cause: err });
    }
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

    throw new TemporaryProcessingError(`Webhook temporary failure with status ${status}`);
}

async function cleanupUploadedAttachments(attachments) {
    const cleanupTargets = Array.isArray(attachments) ? attachments : [];

    await Promise.allSettled(cleanupTargets.map(async (attachment) => {
        try {
            await deleteFromS3({
                bucket: attachment.bucket,
                key: attachment.key
            });
        } catch (err) {
            warn('processor', 'failed to remove uploaded attachment after downstream failure', {
                key: attachment?.key || '',
                bucket: attachment?.bucket || '',
                error: String(err?.message || err)
            });
        }
    }));
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
    const uploadedAttachments = [];
    let parsed = null;
    let deliveryCommitted = false;
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
            uploadedAttachments.push(await uploadPreparedAttachment(prepared));
        }

        const payload = {
            email_id: emailId,
            created_at: createdAt,
            from: parsed.from?.text || '',
            to: recipients,
            message_id: parsed.messageId || '',
            report_type: 'dmarc_aggregate',
            attachments: uploadedAttachments
        };

        await deliverWebhook(payload);
        deliveryCommitted = true;

        info('processor', 'accepted message', {
            emailId,
            attachments: uploadedAttachments.length,
            spf: authResults.spf,
            dkim: authResults.dkim,
            dmarc: authResults.dmarc,
            dmarcPolicy: authResults.dmarcPolicy
        });

        return {
            emailId,
            attachments: uploadedAttachments.length,
            payload
        };
    } catch (err) {
        if (!deliveryCommitted && uploadedAttachments.length > 0) {
            await cleanupUploadedAttachments(uploadedAttachments);
        }

        if (isTemporaryProcessingError(err)) {
            error('processor', 'deferred message', err, { emailId });
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
