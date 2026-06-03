'use strict';

const { loadEnv } = require('./loadEnv');

loadEnv();

function mustNumber(name, val, { min = -Infinity, max = Infinity } = {}) {
    const num = Number(val);
    if (!Number.isFinite(num)) throw new Error(`Invalid number env: ${name}="${val}"`);
    if (num < min || num > max) throw new Error(`Out of range env: ${name}=${num} (min=${min}, max=${max})`);
    return num;
}

const env = process.env;

const PROCESSOR_INPUT_DIR = env.PROCESSOR_INPUT_DIR || '/maildrop/incoming';
const PROCESSOR_POLL_MS_NUM = mustNumber('PROCESSOR_POLL_MS', env.PROCESSOR_POLL_MS || '1000', { min: 100, max: 60_000 });
const PROCESSOR_RETRY_DELAY_MS_NUM = mustNumber('PROCESSOR_RETRY_DELAY_MS', env.PROCESSOR_RETRY_DELAY_MS || '30000', { min: 1000 });
const PROCESSOR_MAX_RETRIES_NUM = mustNumber('PROCESSOR_MAX_RETRIES', env.PROCESSOR_MAX_RETRIES || '20', { min: 0, max: 10_000 });
const PROCESSOR_MAX_BATCH_SIZE_NUM = mustNumber('PROCESSOR_MAX_BATCH_SIZE', env.PROCESSOR_MAX_BATCH_SIZE || '10', { min: 1, max: 1000 });
const PROCESSOR_MAX_CONCURRENCY_NUM = mustNumber(
    'PROCESSOR_MAX_CONCURRENCY',
    env.PROCESSOR_MAX_CONCURRENCY || String(Math.min(PROCESSOR_MAX_BATCH_SIZE_NUM, 4)),
    { min: 1, max: 1000 }
);
const PROCESSOR_DEAD_LETTER_DIR = env.PROCESSOR_DEAD_LETTER_DIR || '/maildrop/dead-letter';
const PROCESSOR_HEARTBEAT_PATH = env.PROCESSOR_HEARTBEAT_PATH || '/tmp/mail-inbound-webhook/processor.heartbeat';
const PROCESSOR_HEALTHCHECK_STALE_MS_NUM = mustNumber(
    'PROCESSOR_HEALTHCHECK_STALE_MS',
    env.PROCESSOR_HEALTHCHECK_STALE_MS || String(Math.max(PROCESSOR_POLL_MS_NUM * 5, 30_000)),
    { min: 1_000 }
);
const PROCESSOR_METRICS_LOG_MS_NUM = mustNumber('PROCESSOR_METRICS_LOG_MS', env.PROCESSOR_METRICS_LOG_MS || '60000', { min: 0 });

module.exports = {
    PROCESSOR_INPUT_DIR,
    PROCESSOR_POLL_MS_NUM,
    PROCESSOR_RETRY_DELAY_MS_NUM,
    PROCESSOR_MAX_RETRIES_NUM,
    PROCESSOR_MAX_BATCH_SIZE_NUM,
    PROCESSOR_MAX_CONCURRENCY_NUM,
    PROCESSOR_DEAD_LETTER_DIR,
    PROCESSOR_HEARTBEAT_PATH,
    PROCESSOR_HEALTHCHECK_STALE_MS_NUM,
    PROCESSOR_METRICS_LOG_MS_NUM
};
