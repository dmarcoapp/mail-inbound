'use strict';

const net = require('net');
const { info, warn, error } = require('./logger');
const {
    CLAMAV_SCAN_ENABLED_BOOL,
    CLAMAV_HOST,
    CLAMAV_PORT_NUM,
    CLAMAV_TIMEOUT_MS_NUM
} = require('./config');

function wait(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function probeTcp({ host, port, timeoutMs }) {
    await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let settled = false;

        function finish(fn, value) {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            fn(value);
        }

        socket.setTimeout(timeoutMs, () => {
            finish(reject, new Error(`connect timeout after ${timeoutMs}ms`));
        });

        socket.once('connect', () => {
            finish(resolve);
        });

        socket.once('error', (err) => {
            finish(reject, err);
        });
    });
}

async function waitForClamav() {
    if (!CLAMAV_SCAN_ENABLED_BOOL) {
        return;
    }

    const rawStartupWaitMs = process.env.CLAMAV_STARTUP_WAIT_MS || '60000';
    const startupWaitMs = Number(rawStartupWaitMs);
    if (!Number.isFinite(startupWaitMs) || startupWaitMs < 0) {
        throw new Error(`Invalid CLAMAV_STARTUP_WAIT_MS="${rawStartupWaitMs}"`);
    }

    const startedAt = Date.now();
    let attempts = 0;
    let lastError = null;

    while ((Date.now() - startedAt) <= startupWaitMs) {
        attempts += 1;
        try {
            await probeTcp({
                host: CLAMAV_HOST,
                port: CLAMAV_PORT_NUM,
                timeoutMs: Math.min(CLAMAV_TIMEOUT_MS_NUM, 5000)
            });

            info('bootstrap', 'clamav reachable; starting processor', {
                host: CLAMAV_HOST,
                port: CLAMAV_PORT_NUM,
                attempts
            });
            return;
        } catch (err) {
            lastError = err;
            warn('bootstrap', 'waiting for clamav before starting processor', {
                host: CLAMAV_HOST,
                port: CLAMAV_PORT_NUM,
                attempts,
                error: String(err?.message || err)
            });
            await wait(2000);
        }
    }

    throw new Error(`ClamAV not reachable at ${CLAMAV_HOST}:${CLAMAV_PORT_NUM} after ${startupWaitMs}ms (${String(lastError?.message || lastError || 'unknown error')})`);
}

(async () => {
    try {
        await waitForClamav();
        const { run } = require('./index');
        await run();
    } catch (err) {
        error('bootstrap', 'failed to start processor', err);
        process.exit(1);
    }
})();
