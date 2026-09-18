'use strict';

const fs = require('fs/promises');
const { permanentProcessingError } = require('../processingErrors');

const DMARC_REJECTION = 'Message rejected: attachment is not a valid DMARC aggregate report';

function escapeTagName(tagName) {
    return String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTagPattern(tagName, { closing = false } = {}) {
    const prefix = closing ? '</' : '<';
    return new RegExp(`${prefix}\\s*(?:[A-Za-z_][\\w.-]*:)?${escapeTagName(tagName)}(?:\\s|>)`, 'i');
}

function hasTag(xml, tagName) {
    return compileTagPattern(tagName).test(xml);
}

function hasClosingTag(xml, tagName) {
    return compileTagPattern(tagName, { closing: true }).test(xml);
}

// Where the first opening tag's content starts, or -1. The attribute list is
// skipped with indexOf rather than a quantifier, so nothing here backtracks.
function findContentStart(xml, tagName) {
    const opening = new RegExp(`<\\s*(?:[A-Za-z_][\\w.-]*:)?${escapeTagName(tagName)}(?=[\\s>])`, 'gi');
    if (!opening.exec(xml)) return -1;

    const tagEnd = xml.indexOf('>', opening.lastIndex);
    return -1 === tagEnd ? -1 : tagEnd + 1;
}

// Where the closing tag after `from` starts, or -1.
function findContentEnd(xml, tagName, from) {
    const closing = new RegExp(`<\\s*/\\s*(?:[A-Za-z_][\\w.-]*:)?${escapeTagName(tagName)}\\s*>`, 'gi');
    closing.lastIndex = from;

    const match = closing.exec(xml);
    return match ? match.index : -1;
}

function extractFirstTagText(xml, tagName) {
    // The two tags are located in separate forward scans instead of one pattern
    // spanning both. A single pattern needs a lazy `[\s\S]*?` between them,
    // which rescans the rest of the document from every candidate opening tag:
    // a report padded with unclosed tags then costs quadratic time, and one
    // attachment stalls a worker for longer than its timeout. Only the first
    // opening tag is considered, which loses nothing, because a closing tag
    // missing after it is missing after every later one too.
    const contentStart = findContentStart(xml, tagName);
    if (contentStart < 0) return '';

    const contentEnd = findContentEnd(xml, tagName, contentStart);
    if (contentEnd < 0) return '';

    return xml.slice(contentStart, contentEnd)
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
