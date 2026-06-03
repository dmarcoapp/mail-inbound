'use strict';

const { ensureInputDir, replayDeadLetters } = require('./index');
const { info, error } = require('./logger');

async function main() {
    await ensureInputDir();
    const result = await replayDeadLetters();

    info('dead-letter', 'replay completed', {
        replayed: result.replayed.length,
        failed: result.failed.length,
        remaining: result.remaining
    });

    if (result.failed.length > 0) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch((err) => {
        error('dead-letter', 'replay failed', err);
        process.exitCode = 1;
    });
}

module.exports = {
    main
};
