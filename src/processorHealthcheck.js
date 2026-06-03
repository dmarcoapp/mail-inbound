'use strict';

const fs = require('fs/promises');
const {
    PROCESSOR_HEARTBEAT_PATH,
    PROCESSOR_HEALTHCHECK_STALE_MS_NUM
} = require('./workerConfig');

async function main() {
    let stat;
    try {
        stat = await fs.stat(PROCESSOR_HEARTBEAT_PATH);
    } catch {
        process.exitCode = 1;
        return;
    }

    const ageMs = Date.now() - stat.mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs > PROCESSOR_HEALTHCHECK_STALE_MS_NUM) {
        process.exitCode = 1;
        return;
    }

    process.exitCode = 0;
}

main().catch(() => {
    process.exitCode = 1;
});

