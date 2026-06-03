'use strict';

const fs = require('fs/promises');
const { permanentProcessingError } = require('../processingErrors');

const DMARC_REJECTION = 'Message rejected: attachment is not a valid DMARC aggregate report';

function compileTagPattern(tagName, { closing = false } = {}) {
    const escaped = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = closing ? '</' : '<';
    return new RegExp(`${prefix}\\s*(?:[A-Za-z_][\\w.-]*:)?${escaped}(?:\\s|>)`, 'i');
}

function hasTag(xml, tagName) {
    return compileTagPattern(tagName).test(xml);
}

function hasClosingTag(xml, tagName) {
    return compileTagPattern(tagName, { closing: true }).test(xml);
}

function extractFirstTagText(xml, tagName) {
    const escaped = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `<\\s*(?:[A-Za-z_][\\w.-]*:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*/\\s*(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`,
        'i'
    );
    const match = xml.match(pattern);
    if (!match) return '';
    return String(match[1] || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function rejectInvalid() {
    return permanentProcessingError(DMARC_REJECTION);
}

async function validateAggregateDmarcReport({ filePath }) {
    const raw = await fs.readFile(filePath, 'utf8');
    const xml = raw.replace(/^\uFEFF/, '').trim();

    if (!xml) throw rejectInvalid();
    if (!hasTag(xml, 'feedback') || !hasClosingTag(xml, 'feedback')) throw rejectInvalid();
    if (!hasTag(xml, 'report_metadata') || !hasClosingTag(xml, 'report_metadata')) throw rejectInvalid();
    if (!hasTag(xml, 'policy_published') || !hasClosingTag(xml, 'policy_published')) throw rejectInvalid();
    if (!hasTag(xml, 'record') || !hasClosingTag(xml, 'record')) throw rejectInvalid();

    return {
        reportId: extractFirstTagText(xml, 'report_id'),
        orgName: extractFirstTagText(xml, 'org_name')
    };
}

module.exports = {
    DMARC_REJECTION,
    validateAggregateDmarcReport,
    hasTag,
    hasClosingTag,
    extractFirstTagText
};
