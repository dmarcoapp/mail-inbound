'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function mockModule(modulePath, exports) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    const prev = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return () => {
        if (prev) require.cache[resolved] = prev;
        else delete require.cache[resolved];
    };
}

function freshIndexRequire(inputDir, options = {}) {
    const uncaughtBefore = process.listeners('uncaughtException');
    const rejectionBefore = process.listeners('unhandledRejection');
    const config = {
        PROCESSOR_INPUT_DIR: inputDir,
        PROCESSOR_POLL_MS_NUM: 1000,
        PROCESSOR_RETRY_DELAY_MS_NUM: 30_000,
        PROCESSOR_MAX_RETRIES_NUM: 3,
        PROCESSOR_MAX_BATCH_SIZE_NUM: 10,
        PROCESSOR_MAX_CONCURRENCY_NUM: 4,
        PROCESSOR_DEAD_LETTER_DIR: path.join(inputDir, 'dead-letter'),
        PROCESSOR_HEARTBEAT_PATH: path.join(inputDir, '.heartbeat', 'processor.heartbeat'),
        ...(options.config || {})
    };
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/workerConfig.js'), {
        ...config
    });
    const restoreTmp = mockModule(path.resolve(__dirname, '../src/io/tmp.js'), {
        startTmpSweeper: () => {}
    });
    const restoreProcessor = mockModule(path.resolve(__dirname, '../src/processor/runIsolated.js'), {
        runMessageProcessorInChild: options.runMessageProcessorInChild || (async () => {})
    });
    const restoreLogger = mockModule(path.resolve(__dirname, '../src/logger.js'), {
        info: options.info || (() => {}),
        warn: options.warn || (() => {}),
        error: options.error || (() => {})
    });

    const resolved = require.resolve('../src/index.js', { paths: [__dirname] });
    delete require.cache[resolved];
    const mod = require(resolved);

    return {
        mod,
        restore() {
            const uncaughtAfter = process.listeners('uncaughtException');
            for (const listener of uncaughtAfter.slice(uncaughtBefore.length)) {
                process.removeListener('uncaughtException', listener);
            }

            const rejectionAfter = process.listeners('unhandledRejection');
            for (const listener of rejectionAfter.slice(rejectionBefore.length)) {
                process.removeListener('unhandledRejection', listener);
            }

            delete require.cache[resolved];
            restoreLogger();
            restoreProcessor();
            restoreTmp();
            restoreConfig();
        }
    };
}

async function withTempDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maildrop-'));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test('recoverStartupState recovers processing files and removes stale orphan files', async () => {
    await withTempDir(async (inputDir) => {
        await fs.mkdir(path.join(inputDir, '.tmp'), { recursive: true });

        const processingPath = path.join(inputDir, 'message.eml.processing');
        const metadataPath = path.join(inputDir, 'message.meta.json');
        const orphanMetadataPath = path.join(inputDir, 'orphan.meta.json');
        const staleTmpPath = path.join(inputDir, '.tmp', 'old-partial.eml');
        const freshTmpPath = path.join(inputDir, '.tmp', 'new-partial.eml');

        await fs.writeFile(processingPath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":"reports@example.test"}');
        await fs.writeFile(orphanMetadataPath, '{"recipient":"old@example.test"}');
        await fs.writeFile(staleTmpPath, 'old');
        await fs.writeFile(freshTmpPath, 'fresh');

        const old = Date.now() - 5_000;
        await fs.utimes(orphanMetadataPath, old / 1000, old / 1000);
        await fs.utimes(staleTmpPath, old / 1000, old / 1000);

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await mod.recoverStartupState({
                inputDir,
                now: Date.now(),
                staleMs: 1_000
            });
        } finally {
            restore();
        }

        const recovered = await fs.readFile(path.join(inputDir, 'message.eml'), 'utf8');
        assert.equal(recovered, 'message');
        await assert.rejects(() => fs.stat(processingPath));
        await fs.stat(metadataPath);
        await assert.rejects(() => fs.stat(orphanMetadataPath));
        await assert.rejects(() => fs.stat(staleTmpPath));
        await fs.stat(freshTmpPath);
    });
});

test('recoverStartupState keeps fresh orphan metadata to avoid racing active handoff', async () => {
    await withTempDir(async (inputDir) => {
        const metadataPath = path.join(inputDir, 'fresh.meta.json');
        await fs.writeFile(metadataPath, '{"recipient":"fresh@example.test"}');

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await mod.recoverStartupState({
                inputDir,
                now: Date.now(),
                staleMs: 60_000
            });
        } finally {
            restore();
        }

        await fs.stat(metadataPath);
    });
});

test('listCandidatePaths skips deferred retries and keeps the oldest ready messages', async () => {
    await withTempDir(async (inputDir) => {
        const now = Date.now();
        const oldReady = path.join(inputDir, 'old.eml');
        const ready = path.join(inputDir, 'ready.eml');
        const futureRetry = path.join(inputDir, `future.retry.2.${now + 60_000}.eml`);
        const staleLegacyRetry = path.join(inputDir, 'legacy.retry.eml');
        const freshLegacyRetry = path.join(inputDir, 'fresh.retry.eml');
        const ignored = path.join(inputDir, 'ignore.txt');

        await fs.writeFile(oldReady, 'old');
        await fs.writeFile(ready, 'ready');
        await fs.writeFile(futureRetry, 'future');
        await fs.writeFile(staleLegacyRetry, 'legacy-old');
        await fs.writeFile(freshLegacyRetry, 'legacy-fresh');
        await fs.writeFile(ignored, 'x');

        await fs.utimes(oldReady, (now - 5_000) / 1000, (now - 5_000) / 1000);
        await fs.utimes(ready, (now - 3_000) / 1000, (now - 3_000) / 1000);
        await fs.utimes(staleLegacyRetry, (now - 40_000) / 1000, (now - 40_000) / 1000);
        await fs.utimes(freshLegacyRetry, (now - 1_000) / 1000, (now - 1_000) / 1000);

        const { mod, restore } = freshIndexRequire(inputDir, {
            config: {
                PROCESSOR_RETRY_DELAY_MS_NUM: 30_000,
                PROCESSOR_MAX_BATCH_SIZE_NUM: 2
            }
        });

        try {
            const candidates = await mod.listCandidatePaths();
            assert.deepEqual(candidates, [staleLegacyRetry, oldReady]);
        } finally {
            restore();
        }
    });
});

test('handleOneFile requeues unreadable metadata as temporary failure', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');

        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":"reports@example.test"}');
        await fs.chmod(metadataPath, 0);

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        const entries = await fs.readdir(inputDir);
        const retryMessage = entries.find(name => /^message\.retry\.1\.\d+\.eml$/.test(name));
        const retryMetadata = entries.find(name => /^message\.retry\.1\.\d+\.meta\.json$/.test(name));

        assert.ok(retryMessage);
        assert.ok(retryMetadata);
        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile drops permanently invalid metadata bundles', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');

        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":');

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile drops bundles when delivery metadata is missing', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        await fs.writeFile(messagePath, 'message');

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(path.join(inputDir, 'message.meta.json')));
    });
});

test('handleOneFile drops metadata without recipients', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');

        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{}');

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile moves exhausted temporary failures into dead-letter', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        await fs.mkdir(deadLetterDir, { recursive: true });

        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');
        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":"reports@example.test"}');

        const temporaryError = Object.assign(new Error('downstream unavailable'), { kind: 'temporary' });
        const { mod, restore } = freshIndexRequire(inputDir, {
            config: {
                PROCESSOR_MAX_RETRIES_NUM: 0
            },
            runMessageProcessorInChild: async () => {
                throw temporaryError;
            }
        });

        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        const deadEntries = await fs.readdir(deadLetterDir);
        assert.ok(deadEntries.some(name => /^message\.dead\.\d+\.eml$/.test(name)));
        assert.ok(deadEntries.some(name => /^message\.dead\.\d+\.meta\.json$/.test(name)));
        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile preserves retry state after claiming a retried message', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        await fs.mkdir(deadLetterDir, { recursive: true });

        const messagePath = path.join(inputDir, 'message.retry.1.123456.eml');
        const metadataPath = path.join(inputDir, 'message.retry.1.123456.meta.json');
        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":"reports@example.test"}');

        const temporaryError = Object.assign(new Error('downstream unavailable'), { kind: 'temporary' });
        const { mod, restore } = freshIndexRequire(inputDir, {
            config: {
                PROCESSOR_MAX_RETRIES_NUM: 1
            },
            runMessageProcessorInChild: async () => {
                throw temporaryError;
            }
        });

        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        const deadEntries = await fs.readdir(deadLetterDir);
        assert.ok(deadEntries.some(name => /^message\.dead\.\d+\.eml$/.test(name)));
        assert.ok(deadEntries.some(name => /^message\.dead\.\d+\.meta\.json$/.test(name)));
        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile deletes accepted bundles after successful processing', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');
        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(
            metadataPath,
            JSON.stringify({
                recipient: 'reports@example.test',
                recipients: ['alt@example.test', 'reports@example.test', '']
            })
        );

        const calls = [];
        const { mod, restore } = freshIndexRequire(inputDir, {
            runMessageProcessorInChild: async (claimedPath, options) => {
                calls.push({ claimedPath, options });
            }
        });

        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        assert.equal(calls.length, 1);
        assert.match(calls[0].claimedPath, /\.processing$/);
        assert.deepEqual(calls[0].options.envelopeRecipients, [
            'reports@example.test',
            'alt@example.test'
        ]);
        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile deletes exhausted temporary failures when dead-letter move fails', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');
        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":"reports@example.test"}');

        const temporaryError = Object.assign(new Error('downstream unavailable'), { kind: 'temporary' });
        const { mod, restore } = freshIndexRequire(inputDir, {
            config: {
                PROCESSOR_MAX_RETRIES_NUM: 0
            },
            runMessageProcessorInChild: async () => {
                throw temporaryError;
            }
        });

        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('handleOneFile deletes bundles after permanent processor failure', async () => {
    await withTempDir(async (inputDir) => {
        const messagePath = path.join(inputDir, 'message.eml');
        const metadataPath = path.join(inputDir, 'message.meta.json');
        await fs.writeFile(messagePath, 'message');
        await fs.writeFile(metadataPath, '{"recipient":"reports@example.test"}');

        const permanentError = Object.assign(new Error('rejected downstream'), { kind: 'permanent' });
        const { mod, restore } = freshIndexRequire(inputDir, {
            runMessageProcessorInChild: async () => {
                throw permanentError;
            }
        });

        try {
            await mod.handleOneFile(messagePath);
        } finally {
            restore();
        }

        await assert.rejects(() => fs.stat(messagePath));
        await assert.rejects(() => fs.stat(metadataPath));
    });
});

test('retry path helpers include attempt counter and dead-letter target', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            const retryPath = mod.toRetryPath(path.join(inputDir, 'sample.processing'), 2);
            const retryBase = path.basename(retryPath);
            const retryState = mod.parseRetryState(retryBase);
            const processingRetryState = mod.parseRetryState(`${retryBase}.processing`);

            assert.match(retryBase, /^sample\.retry\.3\.\d+\.eml$/);
            assert.equal(retryState?.attempt, 3);
            assert.equal(typeof retryState?.retryAt, 'number');
            assert.deepEqual(processingRetryState, retryState);

            const deadLetterPath = mod.toDeadLetterPath(path.join(inputDir, 'sample.retry.3.123456.eml.processing'));
            assert.equal(path.dirname(deadLetterPath), deadLetterDir);
            assert.match(path.basename(deadLetterPath), /^sample\.dead\.\d+\.eml$/);

            const replayPath = mod.toDeadLetterReplayPath(path.join(deadLetterDir, 'sample.dead.123456.eml'), {
                inputDir,
                retryAt: 987654
            });
            assert.equal(path.dirname(replayPath), inputDir);
            assert.equal(path.basename(replayPath), 'sample.retry.0.987654.eml');
        } finally {
            restore();
        }
    });
});

test('processCandidates limits concurrency while draining the batch', async () => {
    await withTempDir(async (inputDir) => {
        const { mod, restore } = freshIndexRequire(inputDir);
        let inFlight = 0;
        let maxInFlight = 0;
        const seen = [];

        try {
            await mod.processCandidates(
                ['a', 'b', 'c', 'd', 'e'],
                {
                    concurrency: 2,
                    handle: async (candidate) => {
                        seen.push(candidate);
                        inFlight += 1;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        inFlight -= 1;
                    }
                }
            );
        } finally {
            restore();
        }

        assert.equal(maxInFlight, 2);
        assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'd', 'e']);
    });
});

test('processCandidates rethrows the first worker failure', async () => {
    await withTempDir(async (inputDir) => {
        const { mod, restore } = freshIndexRequire(inputDir);
        const failure = new Error('boom');

        try {
            await assert.rejects(
                () => mod.processCandidates(
                    ['ok', 'fail'],
                    {
                        concurrency: 2,
                        handle: async (candidate) => {
                            if (candidate === 'fail') throw failure;
                        }
                    }
                ),
                (err) => err === failure
            );
        } finally {
            restore();
        }
    });
});

test('replayDeadLetters moves dead-letter bundles back into the input queue', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        await fs.mkdir(deadLetterDir, { recursive: true });

        const deadLetterPath = path.join(deadLetterDir, 'report.dead.111.eml');
        const deadLetterMetadataPath = path.join(deadLetterDir, 'report.dead.111.meta.json');
        await fs.writeFile(deadLetterPath, 'message');
        await fs.writeFile(deadLetterMetadataPath, '{"recipient":"reports@example.test"}');

        const { mod, restore } = freshIndexRequire(inputDir);
        let result;
        try {
            result = await mod.replayDeadLetters({
                inputDir,
                deadLetterDir,
                limit: 10
            });
        } finally {
            restore();
        }

        assert.equal(result.replayed.length, 1);
        assert.equal(result.failed.length, 0);
        assert.equal(result.remaining, 0);

        const replayPath = result.replayed[0];
        assert.match(path.basename(replayPath), /^report\.retry\.0\.\d+\.eml$/);
        const replayMetadataPath = replayPath.replace(/\.eml$/, '.meta.json');

        const replayedMessage = await fs.readFile(replayPath, 'utf8');
        const replayedMetadata = await fs.readFile(replayMetadataPath, 'utf8');
        assert.equal(replayedMessage, 'message');
        assert.equal(replayedMetadata, '{"recipient":"reports@example.test"}');

        await assert.rejects(() => fs.stat(deadLetterPath));
        await assert.rejects(() => fs.stat(deadLetterMetadataPath));
    });
});

test('listDeadLetterPaths tolerates a missing dead-letter directory', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'missing-dead-letter');
        const { mod, restore } = freshIndexRequire(inputDir);

        try {
            const entries = await mod.listDeadLetterPaths({ deadLetterDir });
            assert.deepEqual(entries, []);
        } finally {
            restore();
        }
    });
});

test('listDeadLetterPaths rethrows unexpected directory errors', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'not-a-directory');
        await fs.writeFile(deadLetterDir, 'x');

        const { mod, restore } = freshIndexRequire(inputDir);

        try {
            await assert.rejects(
                () => mod.listDeadLetterPaths({ deadLetterDir }),
                (err) => err?.code === 'ENOTDIR'
            );
        } finally {
            restore();
        }
    });
});

test('replayDeadLetterFile retries on collisions and normalizes invalid retryAt', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        await fs.mkdir(deadLetterDir, { recursive: true });

        const deadLetterPath = path.join(deadLetterDir, 'report.dead.111.eml');
        const deadLetterMetadataPath = path.join(deadLetterDir, 'report.dead.111.meta.json');
        await fs.writeFile(deadLetterPath, 'message');
        await fs.writeFile(deadLetterMetadataPath, '{"recipient":"reports@example.test"}');

        await fs.writeFile(path.join(inputDir, 'report.retry.0.100.eml'), 'occupied');

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            const replayPath = await mod.replayDeadLetterFile(deadLetterPath, {
                inputDir,
                retryAt: Number.NaN
            });
            assert.match(path.basename(replayPath), /^report\.retry\.0\.\d+\.eml$/);
            const replayed = await fs.readFile(replayPath, 'utf8');
            assert.equal(replayed, 'message');
        } finally {
            restore();
        }
    });
});

test('replayDeadLetters reports failures for broken dead-letter bundles', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        await fs.mkdir(deadLetterDir, { recursive: true });

        const validPath = path.join(deadLetterDir, 'ok.dead.111.eml');
        const validMetaPath = path.join(deadLetterDir, 'ok.dead.111.meta.json');
        const brokenPath = path.join(deadLetterDir, 'broken.dead.222.eml');

        await fs.writeFile(validPath, 'ok');
        await fs.writeFile(validMetaPath, '{"recipient":"reports@example.test"}');
        await fs.writeFile(brokenPath, 'broken');

        const { mod, restore } = freshIndexRequire(inputDir);
        let result;
        try {
            result = await mod.replayDeadLetters({
                inputDir,
                deadLetterDir,
                limit: 10
            });
        } finally {
            restore();
        }

        assert.equal(result.replayed.length, 1);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0], brokenPath);
        assert.equal(result.remaining, 1);
    });
});

test('replayDeadLetterFile throws after exhausting collision attempts', async () => {
    await withTempDir(async (inputDir) => {
        const deadLetterDir = path.join(inputDir, 'dead-letter');
        await fs.mkdir(deadLetterDir, { recursive: true });

        const deadLetterPath = path.join(deadLetterDir, 'report.dead.111.eml');
        const deadLetterMetadataPath = path.join(deadLetterDir, 'report.dead.111.meta.json');
        await fs.writeFile(deadLetterPath, 'message');
        await fs.writeFile(deadLetterMetadataPath, '{"recipient":"reports@example.test"}');

        for (let i = 0; i < 1000; i += 1) {
            await fs.writeFile(path.join(inputDir, `report.retry.0.${1000 + i}.eml`), 'occupied');
        }

        const { mod, restore } = freshIndexRequire(inputDir);
        try {
            await assert.rejects(
                () => mod.replayDeadLetterFile(deadLetterPath, {
                    inputDir,
                    retryAt: 1000
                }),
                /Unable to allocate replay path/
            );
        } finally {
            restore();
        }
    });
});

test('index.js exits through boot failure path when startup initialization fails', async () => {
    const indexPath = path.resolve(__dirname, '../src/index.js');
    const badInputDir = path.join('/dev/null', 'maildrop');

    const result = await new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [indexPath],
            {
                cwd: path.resolve(__dirname, '..'),
                env: {
                    ...process.env,
                    PROCESSOR_INPUT_DIR: badInputDir
                },
                stdio: ['ignore', 'ignore', 'pipe']
            }
        );

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stderr }));
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /processor failed to initialize/);
});
