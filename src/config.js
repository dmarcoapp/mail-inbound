'use strict';

const { loadEnv } = require('./loadEnv');

const { readSecret } = require('./utils');
const { warn } = require('./logger');

loadEnv();

function must(name, val) {
    if (val === undefined || val === null) throw new Error(`Missing required env: ${name}`);
    if (typeof val === 'string' && val.trim() === '') throw new Error(`Missing required env: ${name} (empty string)`);
    return val;
}

function mustNumber(name, val, { min = -Infinity, max = Infinity } = {}) {
    const num = Number(val);
    if (!Number.isFinite(num)) throw new Error(`Invalid number env: ${name}="${val}"`);
    if (num < min || num > max) throw new Error(`Out of range env: ${name}=${num} (min=${min}, max=${max})`);
    return num;
}

function mustBool(name, val, def = false) {
    if (val === undefined || val === null) return def;
    return String(val).toLowerCase() === 'true';
}

const env = process.env;
const SMTP_HOSTNAME = env.SMTP_HOSTNAME || '';

const WEBHOOK_URL = must('WEBHOOK_URL', env.WEBHOOK_URL);
const WEBHOOK_SECRET = readSecret('webhook_secret', 'WEBHOOK_SECRET');
const WEBHOOK_TIMEOUT_MS_NUM = mustNumber('WEBHOOK_TIMEOUT_MS', env.WEBHOOK_TIMEOUT_MS || '4000', { min: 1000 });

const REQUIRE_ATTACHMENTS_BOOL = mustBool('REQUIRE_ATTACHMENTS', env.REQUIRE_ATTACHMENTS, true);
const MAX_ATTACHMENTS_NUM = mustNumber('MAX_ATTACHMENTS', env.MAX_ATTACHMENTS || '1', { min: 0, max: 1000 });
const ALLOWED_ATTACHMENT_EXTENSIONS_SET = new Set(
    String(env.ALLOWED_ATTACHMENT_EXTENSIONS || '.xml,.zip,.gz,.gzip')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .map(s => (s.startsWith('.') ? s : `.${s}`))
);

// The backend refuses a report larger than 8 MB once unpacked, so a higher
// limit here would only send reports it is bound to turn away. Earlier
// releases defaulted to 10 MB and wrote that into .env, so a higher value is
// lowered with a warning rather than keeping the processor from starting.
const MAX_XML_BYTES_LIMIT = 8 * 1024 * 1024;
const MAX_XML_BYTES_CONFIGURED = mustNumber('MAX_XML_BYTES', env.MAX_XML_BYTES || String(MAX_XML_BYTES_LIMIT), { min: 1 });
if (MAX_XML_BYTES_CONFIGURED > MAX_XML_BYTES_LIMIT) {
    warn('config', 'MAX_XML_BYTES is above what the backend accepts, using the limit instead', {
        configured: MAX_XML_BYTES_CONFIGURED,
        limit: MAX_XML_BYTES_LIMIT
    });
}
const MAX_XML_BYTES_NUM = Math.min(MAX_XML_BYTES_CONFIGURED, MAX_XML_BYTES_LIMIT);
const MAX_COMPRESSION_RATIO_NUM = mustNumber('MAX_COMPRESSION_RATIO', env.MAX_COMPRESSION_RATIO || '60', { min: 1, max: 10000 });
const CLAMAV_SCAN_ENABLED_BOOL = mustBool('CLAMAV_SCAN_ENABLED', env.CLAMAV_SCAN_ENABLED, true);
const CLAMAV_HOST = env.CLAMAV_HOST || 'clamav';
const CLAMAV_PORT_NUM = mustNumber('CLAMAV_PORT', env.CLAMAV_PORT || '3310', { min: 1, max: 65535 });
const CLAMAV_TIMEOUT_MS_NUM = mustNumber('CLAMAV_TIMEOUT_MS', env.CLAMAV_TIMEOUT_MS || '10000', { min: 1000 });

try {
    const u = new URL(WEBHOOK_URL);
    if (!u.protocol) throw new Error('missing protocol');
} catch (e) {
    throw new Error(`Invalid WEBHOOK_URL: ${e.message}`);
}

module.exports = {
    SMTP_HOSTNAME,
    WEBHOOK_URL,
    WEBHOOK_SECRET,
    WEBHOOK_TIMEOUT_MS_NUM,
    REQUIRE_ATTACHMENTS_BOOL,
    MAX_ATTACHMENTS_NUM,
    ALLOWED_ATTACHMENT_EXTENSIONS_SET,
    MAX_XML_BYTES_NUM,
    MAX_COMPRESSION_RATIO_NUM,
    CLAMAV_SCAN_ENABLED_BOOL,
    CLAMAV_HOST,
    CLAMAV_PORT_NUM,
    CLAMAV_TIMEOUT_MS_NUM
};
