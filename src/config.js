'use strict';

const { loadEnv } = require('./loadEnv');

const { readSecret } = require('./utils');

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

const S3_ENDPOINT = must('S3_ENDPOINT', env.S3_ENDPOINT);
const S3_REGION = env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = readSecret('s3_access_key', 'S3_ACCESS_KEY');
const S3_SECRET_KEY = readSecret('s3_secret_key', 'S3_SECRET_KEY');
const S3_BUCKET = must('S3_BUCKET', env.S3_BUCKET);
const S3_FORCE_PATH_STYLE = mustBool('S3_FORCE_PATH_STYLE', env.S3_FORCE_PATH_STYLE, true);
const S3_UPLOAD_TIMEOUT_MS_NUM = mustNumber('S3_UPLOAD_TIMEOUT_MS', env.S3_UPLOAD_TIMEOUT_MS || '30000', { min: 1000 });

const REQUIRE_ATTACHMENTS_BOOL = mustBool('REQUIRE_ATTACHMENTS', env.REQUIRE_ATTACHMENTS, true);
const MAX_ATTACHMENTS_NUM = mustNumber('MAX_ATTACHMENTS', env.MAX_ATTACHMENTS || '1', { min: 0, max: 1000 });
const ALLOWED_ATTACHMENT_EXTENSIONS_SET = new Set(
    String(env.ALLOWED_ATTACHMENT_EXTENSIONS || '.xml,.zip,.gz,.gzip')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .map(s => (s.startsWith('.') ? s : `.${s}`))
);

const MAX_XML_BYTES_NUM = mustNumber('MAX_XML_BYTES', env.MAX_XML_BYTES || String(10 * 1024 * 1024), { min: 1 });
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

try {
    const u = new URL(S3_ENDPOINT);
    if (!u.protocol || !u.hostname) throw new Error('missing protocol/hostname');
} catch (e) {
    throw new Error(`Invalid S3_ENDPOINT: ${e.message}`);
}

module.exports = {
    SMTP_HOSTNAME,
    WEBHOOK_URL,
    WEBHOOK_SECRET,
    WEBHOOK_TIMEOUT_MS_NUM,
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
    S3_BUCKET,
    S3_FORCE_PATH_STYLE,
    S3_UPLOAD_TIMEOUT_MS_NUM,
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
