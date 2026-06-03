'use strict';

const fs = require('fs');
const { Upload } = require('@aws-sdk/lib-storage');
const { s3 } = require('./client');
const { S3_BUCKET, S3_UPLOAD_TIMEOUT_MS_NUM } = require('../config');

function sanitizeS3MetadataValue(v, maxLen = 500) {
    if (!v) return '';
    const cleaned = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

async function uploadToS3({ key, filePath, meta }) {
    const body = fs.createReadStream(filePath);

    const upload = new Upload({
        client: s3,
        params: {
            Bucket: S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: meta.contentType || 'application/octet-stream',
            Metadata: {
                filename: sanitizeS3MetadataValue(meta.filename || ''),
                content_disposition: sanitizeS3MetadataValue(meta.contentDisposition || ''),
                content_id: sanitizeS3MetadataValue(meta.contentId || '')
            }
        }
    });

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { upload.abort(); } catch {}
            try { body.destroy(new Error('S3 upload timeout')); } catch {}
            reject(new Error('S3 upload timeout'));
        }, S3_UPLOAD_TIMEOUT_MS_NUM);
        if (typeof timer.unref === 'function') timer.unref();
    });

    try {
        await Promise.race([upload.done(), timeoutPromise]);
        return { bucket: S3_BUCKET, key };
    } finally {
        if (timer) clearTimeout(timer);
        try { body.destroy(); } catch {}
    }
}

module.exports = { uploadToS3 };
