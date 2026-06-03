'use strict';

const path = require('path');
const { fork } = require('child_process');
const {
    PermanentProcessingError,
    TemporaryProcessingError
} = require('../processingErrors');

const CHILD_ENTRYPOINT = path.join(__dirname, 'workerChild.js');
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const CHILD_KILL_GRACE_MS = 5 * 1000;

function toProcessingError(result) {
    const message = String(result?.message || 'Message processing failed');
    if (result?.kind === 'permanent') {
        return new PermanentProcessingError(message);
    }
    return new TemporaryProcessingError(message);
}

function runMessageProcessorInChild(
    filePath,
    { envelopeRecipients = [], delivery = {} } = {},
    {
        forkImpl = fork,
        childEntrypoint = CHILD_ENTRYPOINT,
        timeoutMs = CHILD_TIMEOUT_MS,
        killGraceMs = CHILD_KILL_GRACE_MS
    } = {}
) {
    return new Promise((resolve, reject) => {
        let child;
        let settled = false;
        let timeoutId = null;
        let killTimerId = null;
        let timeoutError = null;

        function clearMainTimeout() {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        }

        function clearKillTimer() {
            if (killTimerId) {
                clearTimeout(killTimerId);
                killTimerId = null;
            }
        }

        function finish(fn, value) {
            if (settled) return;
            settled = true;
            clearMainTimeout();
            fn(value);
        }

        function killChild(signal) {
            if (!child || typeof child.kill !== 'function') {
                return false;
            }

            try {
                return child.kill(signal);
            } catch {
                return false;
            }
        }

        try {
            child = forkImpl(childEntrypoint, [], {
                stdio: ['ignore', 'inherit', 'inherit', 'ipc']
            });
        } catch (err) {
            finish(reject, new TemporaryProcessingError('Processor worker failed to start', { cause: err }));
            return;
        }

        child.once('error', (err) => {
            clearKillTimer();
            if (timeoutError) {
                finish(reject, timeoutError);
                return;
            }
            finish(reject, new TemporaryProcessingError('Processor worker failed to start', { cause: err }));
        });

        child.once('message', (result) => {
            if (settled) return;
            if (timeoutError) return;

            if (result?.ok) {
                clearKillTimer();
                finish(resolve);
                return;
            }
            clearKillTimer();
            finish(reject, toProcessingError(result));
        });

        child.once('exit', (code, signal) => {
            clearKillTimer();
            if (settled) return;
            if (timeoutError) {
                finish(reject, timeoutError);
                return;
            }

            const detail = signal
                ? `signal ${signal}`
                : `code ${Number.isFinite(code) ? code : 'unknown'}`;
            finish(
                reject,
                new TemporaryProcessingError(`Processor worker exited unexpectedly (${detail})`)
            );
        });

        timeoutId = setTimeout(() => {
            timeoutError = new TemporaryProcessingError(
                `Processor worker timed out after ${timeoutMs}ms`
            );
            clearMainTimeout();

            if (!killChild('SIGTERM')) {
                finish(reject, timeoutError);
                return;
            }

            if (killGraceMs <= 0) {
                if (!killChild('SIGKILL')) {
                    finish(reject, timeoutError);
                }
                return;
            }

            killTimerId = setTimeout(() => {
                killTimerId = null;
                if (!killChild('SIGKILL')) {
                    finish(reject, timeoutError);
                }
            }, killGraceMs);
        }, timeoutMs);

        child.send({
            filePath,
            envelopeRecipients: Array.isArray(envelopeRecipients)
                ? envelopeRecipients.slice()
                : [],
            delivery: delivery && typeof delivery === 'object'
                ? { ...delivery }
                : {}
        });
    });
}

module.exports = {
    runMessageProcessorInChild
};
