'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isPermanentProcessingError } = require('../src/processingErrors');

function mockModule(modulePath, exports) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    const prev = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return () => {
        if (prev) require.cache[resolved] = prev;
        else delete require.cache[resolved];
    };
}

function freshProcessMessageRequire(options = {}) {
    const modules = [
        '../src/processor/processMessage',
        '../src/attachments/extractXml',
        '../src/dmarc/validateReport',
        '../src/clamav/scan',
        '../src/auth/validate'
    ];

    for (const modulePath of modules) {
        const resolved = require.resolve(modulePath, { paths: [__dirname] });
        delete require.cache[resolved];
    }

    require.cache[require.resolve('../src/clamav/scan.js', { paths: [__dirname] })] = {
        id: require.resolve('../src/clamav/scan.js', { paths: [__dirname] }),
        filename: require.resolve('../src/clamav/scan.js', { paths: [__dirname] }),
        loaded: true,
        exports: {
            scanFileWithClamav: options.scanFileWithClamav || (async () => ({ clean: true, virus: '' }))
        }
    };

    require.cache[require.resolve('../src/auth/validate.js', { paths: [__dirname] })] = {
        id: require.resolve('../src/auth/validate.js', { paths: [__dirname] }),
        filename: require.resolve('../src/auth/validate.js', { paths: [__dirname] }),
        loaded: true,
        exports: {
            validateMessageAuthentication: options.validateMessageAuthentication || (async () => ({
                spf: 'pass',
                dkim: 'pass',
                dmarc: 'pass',
                dmarcPolicy: 'reject'
            }))
        }
    };

    return require(require.resolve('../src/processor/processMessage', { paths: [__dirname] }));
}

async function withTempMessage(contents, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-'));
    const filePath = path.join(dir, 'message.eml');
    await fs.writeFile(filePath, contents);
    try {
        await fn(filePath);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function makeMessage(xmlBody) {
    const encodedXml = Buffer.from(xmlBody, 'utf8').toString('base64');
    return [
        'From: sender@example.test',
        'To: reports@example.test',
        'X-Original-To: spoofed@example.test',
        'Message-ID: <msg-1@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hello',
        '--b',
        'Content-Type: application/xml; name="report.xml"',
        'Content-Disposition: attachment; filename="report.xml"',
        'Content-Transfer-Encoding: base64',
        '',
        encodedXml,
        '--b--',
        ''
    ].join('\r\n');
}

test('processMessageFile uploads valid DMARC reports and posts webhook', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    let uploaded = null;
    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async (opts) => {
            uploaded = opts;
            return { bucket: 'bucket-a', key: opts.key };
        }
    });

    let postedPayload = null;
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async (payload) => {
            postedPayload = payload;
            return 202;
        },
        isHttpSuccess: (status) => status >= 200 && status < 300,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            const result = await processMessageFile(filePath, {
                envelopeRecipients: ['envelope@example.test']
            });
            assert.equal(result.attachments, 1);
            assert.match(uploaded.key, /^attachments\/[0-9a-f-]+$/i);
            assert.equal(uploaded.meta.filename, 'report.xml');
            assert.equal(postedPayload.report_type, 'dmarc_aggregate');
            assert.equal(postedPayload.attachments[0].key, uploaded.key);
            assert.deepEqual(postedPayload.to, ['envelope@example.test']);
        });
    } finally {
        restoreWebhook();
        restoreUpload();
        restoreConfig();
    }
});

test('processMessageFile rejects infected messages before upload', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    let uploadCalled = false;
    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async () => {
            uploadCalled = true;
            return { bucket: 'bucket-a', key: 'attachments/x' };
        }
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 200,
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire({
            scanFileWithClamav: async () => ({ clean: false, virus: 'Eicar-Test-Signature' })
        });
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'PermanentProcessingError'
                    && /malware detected/i.test(String(err?.message || ''))
            );
        });
        assert.equal(uploadCalled, false);
    } finally {
        restoreWebhook();
        restoreUpload();
        restoreConfig();
    }
});

test('processMessageFile defers when authentication checks are temporarily unavailable', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async () => ({ bucket: 'bucket-a', key: 'attachments/x' })
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 200,
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire({
            validateMessageAuthentication: async () => {
                throw Object.assign(new Error('dns timeout'), { kind: 'temporary' });
            }
        });
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'TemporaryProcessingError' && err?.kind === 'temporary'
            );
        });
    } finally {
        restoreWebhook();
        restoreUpload();
        restoreConfig();
    }
});

test('processMessageFile rejects non-DMARC attachments before webhook', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    let webhookCalled = false;
    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async () => ({ bucket: 'bucket-a', key: 'attachments/x' })
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => {
            webhookCalled = true;
            return 200;
        },
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata></report_metadata>',
        '  <policy_published></policy_published>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                isPermanentProcessingError
            );
            assert.equal(webhookCalled, false);
        });
    } finally {
        restoreWebhook();
        restoreUpload();
        restoreConfig();
    }
});

test('processMessageFile treats retryable local attachment failures as temporary', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreStore = mockModule(path.resolve(__dirname, '../src/io/storeStreamToTmpFile.js'), {
        storeStreamToTmpFile: async () => {
            const err = new Error('disk full');
            err.code = 'ENOSPC';
            throw err;
        }
    });

    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async () => ({ bucket: 'bucket-a', key: 'attachments/x' })
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 200,
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'TemporaryProcessingError' && err?.kind === 'temporary'
            );
        });
    } finally {
        restoreWebhook();
        restoreDelete();
        restoreUpload();
        restoreStore();
        restoreConfig();
    }
});

test('processMessageFile removes uploaded attachments when webhook rejects payload', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const deleted = [];
    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async (opts) => ({ bucket: 'bucket-a', key: opts.key })
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async (opts) => {
            deleted.push(opts);
        }
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 422,
        isHttpSuccess: () => false,
        isHttpPermanentFailure: () => true
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                isPermanentProcessingError
            );
        });
    } finally {
        restoreWebhook();
        restoreDelete();
        restoreUpload();
        restoreConfig();
    }

    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].bucket, 'bucket-a');
    assert.match(deleted[0].key, /^attachments\//);
});

test('processMessageFile treats retryable parse failures as temporary', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreMailparser = mockModule('mailparser', {
        simpleParser: async (stream) => {
            try { stream?.destroy?.(); } catch {}
            const err = new Error('read-fail');
            err.code = 'EIO';
            throw err;
        }
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage('<feedback></feedback>'), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'TemporaryProcessingError' && err?.kind === 'temporary'
            );
        });
    } finally {
        restoreDelete();
        restoreMailparser();
        restoreConfig();
    }
});

test('processMessageFile closes the message stream when parsing fails', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    // Unlike the tests above, this parser leaves the stream alone, so whatever
    // state it ends up in is the caller's doing.
    let messageStream = null;
    const restoreMailparser = mockModule('mailparser', {
        simpleParser: async (stream) => {
            messageStream = stream;
            const err = new Error('read-fail');
            err.code = 'EIO';
            throw err;
        }
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage('<feedback></feedback>'), async (filePath) => {
            await assert.rejects(() => processMessageFile(filePath, {
                envelopeRecipients: ['envelope@example.test']
            }));
        });
    } finally {
        restoreDelete();
        restoreMailparser();
        restoreConfig();
    }

    // An abandoned read stream holds a file descriptor open, and emits an
    // unhandled 'error' when the file is moved to the retry queue while its
    // open is still in flight, which takes the whole processor down.
    assert.ok(messageStream);
    assert.equal(messageStream.destroyed, true);
    assert.ok(messageStream.listenerCount('error') > 0);
});

test('processMessageFile treats non-retryable parse failures as permanent', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreMailparser = mockModule('mailparser', {
        simpleParser: async () => {
            throw new Error('parse-fail');
        }
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage('<feedback></feedback>'), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                isPermanentProcessingError
            );
            await new Promise((resolve) => setImmediate(resolve));
        });
    } finally {
        restoreDelete();
        restoreMailparser();
        restoreConfig();
    }
});

test('processMessageFile treats non-processing attachment policy errors as permanent', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restorePolicy = mockModule(path.resolve(__dirname, '../src/policy/attachmentPolicy.js'), {
        getSafeFilename: () => 'report.xml',
        validateAttachmentsOrThrow: () => {
            throw new Error('policy-bug');
        }
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage('<feedback></feedback>'), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                isPermanentProcessingError
            );
        });
    } finally {
        restoreDelete();
        restorePolicy();
        restoreConfig();
    }
});

test('processMessageFile retries webhook temporary HTTP failures', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async (opts) => ({ bucket: 'bucket-a', key: opts.key })
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 503,
        isHttpSuccess: () => false,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'TemporaryProcessingError' && err?.kind === 'temporary'
            );
        });
    } finally {
        restoreWebhook();
        restoreDelete();
        restoreUpload();
        restoreConfig();
    }
});

test('processMessageFile retries when S3 upload throws', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async () => {
            throw new Error('s3-down');
        }
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {}
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 200,
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'TemporaryProcessingError'
                    && err?.kind === 'temporary'
                    && /S3 upload failed/.test(String(err?.message || ''))
            );
        });
    } finally {
        restoreWebhook();
        restoreDelete();
        restoreUpload();
        restoreConfig();
    }
});

test('processMessageFile warns when uploaded attachment cleanup fails after webhook request error', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const warnings = [];
    const restoreLogger = mockModule(path.resolve(__dirname, '../src/logger.js'), {
        info: () => {},
        warn: (...args) => {
            warnings.push(args);
        },
        error: () => {}
    });
    const restoreUpload = mockModule(path.resolve(__dirname, '../src/s3/upload.js'), {
        uploadToS3: async (opts) => ({ bucket: 'bucket-a', key: opts.key })
    });
    const restoreDelete = mockModule(path.resolve(__dirname, '../src/s3/delete.js'), {
        deleteFromS3: async () => {
            throw new Error('cleanup-fail');
        }
    });
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => {
            throw new Error('socket-hangup');
        },
        isHttpSuccess: () => false,
        isHttpPermanentFailure: () => false
    });

    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>Example Reporter</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, {
                    envelopeRecipients: ['envelope@example.test']
                }),
                (err) => err?.name === 'TemporaryProcessingError'
                    && err?.kind === 'temporary'
                    && /Webhook request failed/.test(String(err?.message || ''))
            );
        });
    } finally {
        restoreWebhook();
        restoreDelete();
        restoreUpload();
        restoreLogger();
        restoreConfig();
    }

    assert.ok(
        warnings.some((args) => String(args[1] || '').includes('failed to remove uploaded attachment after downstream failure'))
    );
});
