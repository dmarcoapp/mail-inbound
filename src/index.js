'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
    PROCESSOR_INPUT_DIR,
    PROCESSOR_POLL_MS_NUM,
    PROCESSOR_RETRY_DELAY_MS_NUM,
    PROCESSOR_MAX_RETRIES_NUM,
    PROCESSOR_MAX_BATCH_SIZE_NUM,
    PROCESSOR_MAX_CONCURRENCY_NUM,
    PROCESSOR_DEAD_LETTER_DIR,
    PROCESSOR_HEARTBEAT_PATH,
    PROCESSOR_METRICS_LOG_MS_NUM
} = require('./workerConfig');
const { startTmpSweeper } = require('./io/tmp');
const { runMessageProcessorInChild } = require('./processor/runIsolated');
const { incrementMetric, startMetricsLogger } = require('./metrics');
const {
    PermanentProcessingError,
    TemporaryProcessingError
} = require('./processingErrors');
const { info, warn, error } = require('./logger');

process.on('uncaughtException', (err) => {
    error('process', 'uncaught exception', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    error('process', 'unhandled rejection', reason);
    process.exit(1);
});

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function ensureInputDir() {
    await fs.mkdir(PROCESSOR_INPUT_DIR, { recursive: true });
    await fs.mkdir(PROCESSOR_DEAD_LETTER_DIR, { recursive: true });
    await fs.mkdir(path.dirname(PROCESSOR_HEARTBEAT_PATH), { recursive: true });
}

async function writeHeartbeat() {
    await fs.writeFile(PROCESSOR_HEARTBEAT_PATH, `${Date.now()}\n`, 'utf8');
}

function isCandidateFile(name) {
    return name.endsWith('.eml') && !name.endsWith('.tmp');
}

function isProcessingFile(name) {
    return name.endsWith('.processing');
}

function isMetadataFile(name) {
    return name.endsWith('.meta.json');
}

function isDeadLetterFile(name) {
    return /\.dead\.\d+\.eml$/.test(String(name || ''));
}

function stripProcessingSuffix(name) {
    return name.endsWith('.processing') ? name.slice(0, -'.processing'.length) : name;
}

function stripRetrySuffix(name) {
    return String(name).replace(/\.retry(?:\.\d+){1,2}(?=\.eml$)/, '');
}

function stripDeadLetterSuffix(name) {
    return String(name).replace(/\.dead\.\d+(?=\.eml$)/, '');
}

function parseRetryState(name) {
    const current = stripProcessingSuffix(String(name));
    const currentMatch = current.match(/\.retry\.(\d+)\.(\d+)\.eml$/);
    if (currentMatch) {
        const attempt = Number(currentMatch[1]);
        const retryAt = Number(currentMatch[2]);
        if (Number.isFinite(attempt) && Number.isFinite(retryAt)) {
            return { attempt, retryAt };
        }
    }

    const legacyMatch = current.match(/\.retry\.(\d+)\.eml$/);
    if (!legacyMatch) return null;

    const retryAt = Number(legacyMatch[1]);
    if (!Number.isFinite(retryAt)) return null;
    return { attempt: 1, retryAt };
}

function compareCandidate(a, b) {
    return a.mtimeMs - b.mtimeMs || a.fullPath.localeCompare(b.fullPath);
}

function pushCandidate(candidates, next) {
    let insertAt = candidates.length;

    for (let i = 0; i < candidates.length; i += 1) {
        if (compareCandidate(next, candidates[i]) < 0) {
            insertAt = i;
            break;
        }
    }

    candidates.splice(insertAt, 0, next);
    if (candidates.length > PROCESSOR_MAX_BATCH_SIZE_NUM) {
        candidates.pop();
    }
}

function toMetadataPath(filePath) {
    const dir = path.dirname(filePath);
    let baseName = path.basename(filePath);
    baseName = stripProcessingSuffix(baseName);
    if (baseName.endsWith('.eml')) {
        baseName = baseName.slice(0, -'.eml'.length);
    }
    return path.join(dir, `${baseName}.meta.json`);
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function recoverProcessingFiles(entries, inputDir) {
    for (const entry of entries) {
        if (!entry.isFile() || !isProcessingFile(entry.name)) continue;

        const processingPath = path.join(inputDir, entry.name);
        const recoveredPath = path.join(inputDir, stripProcessingSuffix(entry.name));

        if (await fileExists(recoveredPath)) {
            warn('processor', 'skipped recovery because target file already exists', {
                filePath: processingPath,
                targetPath: recoveredPath
            });
            continue;
        }

        try {
            await fs.rename(processingPath, recoveredPath);
            warn('processor', 'recovered interrupted message file', {
                filePath: recoveredPath
            });
        } catch (err) {
            error('processor', 'failed to recover interrupted message file', err, {
                filePath: processingPath
            });
        }
    }
}

async function cleanupOrphanMetadataFiles(entries, inputDir, now, staleMs) {
    for (const entry of entries) {
        if (!entry.isFile() || !isMetadataFile(entry.name)) continue;

        const metadataPath = path.join(inputDir, entry.name);
        const stat = await fs.stat(metadataPath).catch(() => null);
        if (!stat) continue;
        if ((now - stat.mtimeMs) < staleMs) continue;

        const baseName = entry.name.slice(0, -'.meta.json'.length);
        const candidates = [
            path.join(inputDir, `${baseName}.eml`),
            path.join(inputDir, `${baseName}.eml.processing`)
        ];

        let hasMessage = false;
        for (const candidate of candidates) {
            if (await fileExists(candidate)) {
                hasMessage = true;
                break;
            }
        }
        if (hasMessage) continue;

        await deleteFile(metadataPath);
        warn('processor', 'removed orphan delivery metadata', {
            filePath: metadataPath
        });
    }
}

async function cleanupMaildropTmpFiles(inputDir, now, staleMs) {
    const tmpDir = path.join(inputDir, '.tmp');
    let entries;
    try {
        entries = await fs.readdir(tmpDir, { withFileTypes: true });
    } catch (err) {
        if (err?.code === 'ENOENT') return;
        throw err;
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = path.join(tmpDir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) continue;
        if ((now - stat.mtimeMs) < staleMs) continue;

        await deleteFile(filePath);
        warn('processor', 'removed stale maildrop temp file', {
            filePath
        });
    }
}

async function recoverStartupState({
    inputDir = PROCESSOR_INPUT_DIR,
    now = Date.now(),
    staleMs = PROCESSOR_RETRY_DELAY_MS_NUM
} = {}) {
    let entries;
    try {
        entries = await fs.readdir(inputDir, { withFileTypes: true });
    } catch (err) {
        if (err?.code === 'ENOENT') return;
        throw err;
    }

    await recoverProcessingFiles(entries, inputDir);

    let refreshedEntries;
    try {
        refreshedEntries = await fs.readdir(inputDir, { withFileTypes: true });
    } catch (err) {
        if (err?.code === 'ENOENT') return;
        throw err;
    }

    await cleanupOrphanMetadataFiles(refreshedEntries, inputDir, now, staleMs);
    await cleanupMaildropTmpFiles(inputDir, now, staleMs);
}

async function listCandidatePaths() {
    const entries = await fs.readdir(PROCESSOR_INPUT_DIR, { withFileTypes: true });
    const candidates = [];
    const now = Date.now();

    for (const entry of entries) {
        if (!entry.isFile() || !isCandidateFile(entry.name)) continue;
        const fullPath = path.join(PROCESSOR_INPUT_DIR, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) continue;

        const retryState = parseRetryState(entry.name);
        const isLegacyRetryFile = entry.name.endsWith('.retry.eml');
        if (retryState && now < retryState.retryAt) {
            continue;
        }
        if (!retryState && isLegacyRetryFile && (now - stat.mtimeMs) < PROCESSOR_RETRY_DELAY_MS_NUM) {
            continue;
        }

        pushCandidate(candidates, { fullPath, mtimeMs: stat.mtimeMs });
    }

    return candidates.map(entry => entry.fullPath);
}

function toProcessingPath(filePath) {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    return path.join(dir, `${stripProcessingSuffix(baseName)}.processing`);
}

function toRetryPath(filePath, attempt = 0) {
    const dir = path.dirname(filePath);
    const baseName = stripRetrySuffix(stripProcessingSuffix(path.basename(filePath)));
    const nextAttempt = attempt + 1;
    const retryAt = Date.now() + PROCESSOR_RETRY_DELAY_MS_NUM;
    if (baseName.endsWith('.eml')) {
        return path.join(dir, `${baseName.slice(0, -'.eml'.length)}.retry.${nextAttempt}.${retryAt}.eml`);
    }
    return path.join(dir, `${baseName}.retry.${nextAttempt}.${retryAt}.eml`);
}

function toDeadLetterPath(filePath) {
    const baseName = stripRetrySuffix(stripProcessingSuffix(path.basename(filePath)));
    const stamp = Date.now();
    if (baseName.endsWith('.eml')) {
        return path.join(PROCESSOR_DEAD_LETTER_DIR, `${baseName.slice(0, -'.eml'.length)}.dead.${stamp}.eml`);
    }
    return path.join(PROCESSOR_DEAD_LETTER_DIR, `${baseName}.dead.${stamp}.eml`);
}

function toDeadLetterReplayPath(
    filePath,
    {
        inputDir = PROCESSOR_INPUT_DIR,
        retryAt = Date.now()
    } = {}
) {
    const baseName = stripDeadLetterSuffix(stripProcessingSuffix(path.basename(filePath)));
    if (baseName.endsWith('.eml')) {
        return path.join(inputDir, `${baseName.slice(0, -'.eml'.length)}.retry.0.${retryAt}.eml`);
    }
    return path.join(inputDir, `${baseName}.retry.0.${retryAt}.eml`);
}

async function claimFile(filePath) {
    const processingPath = toProcessingPath(filePath);
    await fs.rename(filePath, processingPath);
    return processingPath;
}

async function deleteFile(filePath) {
    await fs.unlink(filePath).catch(() => {});
}

async function deleteBundle(filePath) {
    await deleteFile(filePath);
    await deleteFile(toMetadataPath(filePath));
}

async function moveBundle(filePath, nextPath) {
    const metadataPath = toMetadataPath(filePath);
    const nextMetadataPath = toMetadataPath(nextPath);

    await fs.rename(filePath, nextPath);
    try {
        await fs.rename(metadataPath, nextMetadataPath);
    } catch (err) {
        await fs.rename(nextPath, filePath).catch(async () => {
            await deleteFile(nextPath);
        });
        throw err;
    }
}

async function requeueFile(filePath) {
    const retryState = parseRetryState(path.basename(filePath));
    const retryPath = toRetryPath(filePath, retryState?.attempt || 0);
    await moveBundle(filePath, retryPath);
    return {
        retryPath,
        attempt: (retryState?.attempt || 0) + 1
    };
}

async function moveToDeadLetter(filePath) {
    const deadLetterPath = toDeadLetterPath(filePath);
    await moveBundle(filePath, deadLetterPath);
    return deadLetterPath;
}

async function handleTemporaryFailure(claimedPath, err) {
    const retryState = parseRetryState(path.basename(claimedPath));
    const attempts = retryState?.attempt || 0;

    if (attempts >= PROCESSOR_MAX_RETRIES_NUM) {
        const deadLetterPath = await moveToDeadLetter(claimedPath).catch(async (moveErr) => {
            error('processor', 'failed to dead-letter message', moveErr, { filePath: claimedPath });
            await deleteBundle(claimedPath);
            return '';
        });
        if (deadLetterPath) {
            incrementMetric('messages_dead_lettered_total');
            error('processor', 'moved message to dead-letter after retry exhaustion', err, {
                filePath: deadLetterPath,
                retries: attempts
            });
        }
        return;
    }

    const retry = await requeueFile(claimedPath).catch(async (renameErr) => {
        error('processor', 'failed to requeue message', renameErr, { filePath: claimedPath });
        await deleteBundle(claimedPath);
        return null;
    });
    if (retry) {
        incrementMetric('messages_requeued_total');
        warn('processor', 'requeued message for retry', {
            filePath: retry.retryPath,
            retryAttempt: retry.attempt
        });
    }
}

async function readDeliveryMetadata(filePath) {
    const metadataPath = toMetadataPath(filePath);
    let raw;
    try {
        raw = await fs.readFile(metadataPath, 'utf8');
    } catch (err) {
        if (err?.code === 'EACCES' || err?.code === 'EPERM') {
            throw new TemporaryProcessingError('Message deferred: delivery metadata unreadable', { cause: err });
        }
        throw new PermanentProcessingError('Message rejected: delivery metadata missing', { cause: err });
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new PermanentProcessingError('Message rejected: invalid delivery metadata', { cause: err });
    }

    const recipients = [];
    if (typeof parsed?.recipient === 'string') {
        const recipient = parsed.recipient.trim();
        if (recipient) recipients.push(recipient);
    }
    if (Array.isArray(parsed?.recipients)) {
        for (const value of parsed.recipients) {
            const recipient = String(value || '').trim();
            if (recipient) recipients.push(recipient);
        }
    }

    const unique = Array.from(new Set(recipients));
    if (unique.length === 0) {
        throw new PermanentProcessingError('Message rejected: delivery metadata missing recipient');
    }

    return {
        recipients: unique,
        recipient: unique[0],
        clientIp: typeof parsed?.client_ip === 'string' ? parsed.client_ip.trim() : '',
        clientName: typeof parsed?.client_name === 'string' ? parsed.client_name.trim() : '',
        helo: typeof parsed?.helo === 'string' ? parsed.helo.trim() : '',
        mailFrom: typeof parsed?.mail_from === 'string' ? parsed.mail_from.trim() : '',
        queueId: typeof parsed?.queue_id === 'string' ? parsed.queue_id.trim() : '',
        receivedAt: typeof parsed?.received_at === 'string' ? parsed.received_at.trim() : ''
    };
}

async function handleOneFile(filePath) {
    let claimedPath = '';

    try {
        claimedPath = await claimFile(filePath);
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            warn('processor', 'failed to claim message file', { filePath, error: String(err?.message || err) });
        }
        return;
    }

    let delivery;
    try {
        delivery = await readDeliveryMetadata(claimedPath);
    } catch (err) {
        if (err?.kind === 'temporary') {
            await handleTemporaryFailure(claimedPath, err);
            return;
        }
        warn('processor', 'rejected message', {
            filePath: claimedPath,
            message: String(err?.message || 'Message rejected')
        });
        incrementMetric('messages_rejected_total');
        await deleteBundle(claimedPath);
        return;
    }

    try {
        await runMessageProcessorInChild(claimedPath, {
            envelopeRecipients: delivery.recipients,
            delivery
        });
        incrementMetric('messages_accepted_total');
        await deleteBundle(claimedPath);
    } catch (err) {
        if (err?.kind === 'temporary') {
            incrementMetric('messages_deferred_total');
            await handleTemporaryFailure(claimedPath, err);
            return;
        }

        incrementMetric('messages_rejected_total');
        await deleteBundle(claimedPath);
    }
}

async function listDeadLetterPaths(
    {
        deadLetterDir = PROCESSOR_DEAD_LETTER_DIR
    } = {}
) {
    let entries;
    try {
        entries = await fs.readdir(deadLetterDir, { withFileTypes: true });
    } catch (err) {
        if (err?.code === 'ENOENT') return [];
        throw err;
    }

    const candidates = [];
    for (const entry of entries) {
        if (!entry.isFile() || !isDeadLetterFile(entry.name)) continue;

        const fullPath = path.join(deadLetterDir, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) continue;
        candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
    }

    candidates.sort(compareCandidate);
    return candidates.map(entry => entry.fullPath);
}

async function replayDeadLetterFile(
    filePath,
    {
        inputDir = PROCESSOR_INPUT_DIR,
        retryAt = Date.now()
    } = {}
) {
    let nextRetryAt = Number(retryAt);
    if (!Number.isFinite(nextRetryAt)) {
        nextRetryAt = Date.now();
    }

    for (let attempt = 0; attempt < 1000; attempt += 1) {
        const replayPath = toDeadLetterReplayPath(filePath, {
            inputDir,
            retryAt: nextRetryAt + attempt
        });

        if (await fileExists(replayPath) || await fileExists(toMetadataPath(replayPath))) {
            continue;
        }

        await moveBundle(filePath, replayPath);
        return replayPath;
    }

    throw new Error('Unable to allocate replay path for dead-letter message');
}

async function replayDeadLetters(
    {
        inputDir = PROCESSOR_INPUT_DIR,
        deadLetterDir = PROCESSOR_DEAD_LETTER_DIR,
        limit = PROCESSOR_MAX_BATCH_SIZE_NUM
    } = {}
) {
    const maxItems = Math.max(0, Number(limit) || 0);
    const deadLetters = await listDeadLetterPaths({ deadLetterDir });
    const selected = deadLetters.slice(0, maxItems);
    const replayed = [];
    const failed = [];
    let nextRetryAt = Date.now();

    for (const deadLetterPath of selected) {
        try {
            const replayPath = await replayDeadLetterFile(deadLetterPath, {
                inputDir,
                retryAt: nextRetryAt
            });
            replayed.push(replayPath);
            info('processor', 'requeued dead-letter message', {
                sourcePath: deadLetterPath,
                filePath: replayPath
            });
            nextRetryAt += 1;
        } catch (err) {
            failed.push(deadLetterPath);
            error('processor', 'failed to requeue dead-letter message', err, {
                filePath: deadLetterPath
            });
        }
    }

    return {
        replayed,
        failed,
        remaining: Math.max(0, deadLetters.length - replayed.length)
    };
}

async function processCandidates(
    candidatePaths,
    {
        concurrency = PROCESSOR_MAX_CONCURRENCY_NUM,
        handle = handleOneFile
    } = {}
) {
    const queue = Array.isArray(candidatePaths) ? candidatePaths.slice() : [];
    const limit = Math.max(1, Math.min(queue.length || 1, Number(concurrency) || 1));
    let nextIndex = 0;
    const failures = [];

    async function runWorker() {
        while (true) {
            const currentIndex = nextIndex;
            if (currentIndex >= queue.length) return;
            nextIndex += 1;

            try {
                await handle(queue[currentIndex]);
            } catch (err) {
                failures.push(err);
            }
        }
    }

    await Promise.all(Array.from({ length: limit }, () => runWorker()));

    if (failures.length > 0) {
        throw failures[0];
    }
}

async function run() {
    await ensureInputDir();
    await recoverStartupState();
    startTmpSweeper();
    startMetricsLogger({ intervalMs: PROCESSOR_METRICS_LOG_MS_NUM });
    info('processor', 'watching drop directory', {
        inputDir: PROCESSOR_INPUT_DIR,
        pollMs: PROCESSOR_POLL_MS_NUM,
        retryDelayMs: PROCESSOR_RETRY_DELAY_MS_NUM,
        maxConcurrency: PROCESSOR_MAX_CONCURRENCY_NUM
    });

    while (true) {
        try {
            const candidates = await listCandidatePaths();
            await processCandidates(candidates);
        } catch (err) {
            error('processor', 'poll iteration failed', err, { inputDir: PROCESSOR_INPUT_DIR });
        }

        await writeHeartbeat().catch((err) => {
            warn('processor', 'failed to update heartbeat', {
                filePath: PROCESSOR_HEARTBEAT_PATH,
                error: String(err?.message || err)
            });
        });

        await sleep(PROCESSOR_POLL_MS_NUM);
    }
}

if (require.main === module) {
    run().catch((err) => {
        error('boot', 'processor failed to initialize', err);
        process.exitCode = 1;
    });
}

module.exports = {
    run,
    ensureInputDir,
    listCandidatePaths,
    listDeadLetterPaths,
    handleOneFile,
    processCandidates,
    replayDeadLetterFile,
    replayDeadLetters,
    recoverStartupState,
    toMetadataPath,
    parseRetryState,
    toRetryPath,
    toDeadLetterPath,
    toDeadLetterReplayPath
};
