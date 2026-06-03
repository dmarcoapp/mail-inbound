'use strict';

const path = require('path');
const { permanentProcessingError } = require('../processingErrors');
const { REQUIRE_ATTACHMENTS_BOOL, MAX_ATTACHMENTS_NUM, ALLOWED_ATTACHMENT_EXTENSIONS_SET } = require('../config');

function getSafeFilename(att) {
    const raw = String(att?.filename || '').trim();
    return path.basename(raw);
}

function hasAllowedExtension(filename) {
    if (!ALLOWED_ATTACHMENT_EXTENSIONS_SET.size) return true;
    const base = path.basename(String(filename || '')).toLowerCase();
    return ALLOWED_ATTACHMENT_EXTENSIONS_SET.has(path.extname(base));
}

function validateAttachmentsOrThrow(attachments) {
    const list = attachments || [];

    if (REQUIRE_ATTACHMENTS_BOOL && list.length === 0) {
        throw permanentProcessingError('Message rejected: attachment required');
    }
    if (MAX_ATTACHMENTS_NUM >= 0 && list.length > MAX_ATTACHMENTS_NUM) {
        throw permanentProcessingError('Message rejected: too many attachments');
    }

    for (const att of list) {
        const fname = getSafeFilename(att);
        if (!fname) throw permanentProcessingError('Message rejected: attachment filename required');
        if (!hasAllowedExtension(fname)) throw permanentProcessingError('Message rejected: attachment extension not allowed');
    }

    return list;
}

module.exports = { validateAttachmentsOrThrow, getSafeFilename };
