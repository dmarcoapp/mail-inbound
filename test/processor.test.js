'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { isPermanentProcessingError, isDeadLetterProcessingError } = require('../src/processingErrors');

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

test('processMessageFile sends valid DMARC reports inside the webhook', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    let postedPayload = null;
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async (payload) => {
            postedPayload = payload;
            return 202;
        },
        isHttpSuccess: (status) => status >= 200 && status < 300,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
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
            assert.equal(postedPayload.report_type, 'dmarc_aggregate');
            assert.deepEqual(postedPayload.to, ['envelope@example.test']);
            assert.deepEqual(Object.keys(postedPayload.attachments[0]).sort(), ['content', 'content_type', 'filename']);
            assert.equal(postedPayload.attachments[0].filename, 'report.xml');
            assert.equal(postedPayload.attachments[0].content_type, 'application/xml');
            const sent = zlib.gunzipSync(Buffer.from(postedPayload.attachments[0].content, 'base64')).toString('utf8');
            assert.equal(sent, xml);
        });
    } finally {
        restoreWebhook();
        restoreConfig();
    }
});

test('processMessageFile rejects infected messages before forwarding them', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    let posted = false;
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => {
            posted = true;
            return 200;
        },
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
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
        assert.equal(posted, false);
    } finally {
        restoreWebhook();
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

    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 200,
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
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
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => {
            webhookCalled = true;
            return 200;
        },
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
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

    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 200,
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
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
        restoreStore();
        restoreConfig();
    }
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
    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage('<feedback></feedback>'), async (filePath) => {
            await assert.rejects(() => processMessageFile(filePath, {
                envelopeRecipients: ['envelope@example.test']
            }));
        });
    } finally {
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

    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 503,
        isHttpSuccess: () => false,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
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
        restoreConfig();
    }
});

test('processMessageFile discards the message when the webhook rejects the recipient', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    // The status classifiers stay real, because what is under test is that a
    // 404 counts as permanent.
    const realWebhook = require('../src/webhook/post');
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 404,
        isHttpSuccess: realWebhook.isHttpSuccess,
        isHttpPermanentFailure: realWebhook.isHttpPermanentFailure,
        isHttpDeadLetterFailure: realWebhook.isHttpDeadLetterFailure
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
                () => processMessageFile(filePath, { envelopeRecipients: ['nobody@example.test'] }),
                isPermanentProcessingError
            );
        });

    } finally {
        restoreWebhook();
        restoreConfig();
    }
});

test('processMessageFile holds the message for dead-letter when the webhook refuses the signature', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    // A 401 is what a mismatched WEBHOOK_SECRET produces. The classifiers stay
    // real, because what is under test is that it no longer counts as permanent.
    const realWebhook = require('../src/webhook/post');
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => 401,
        isHttpSuccess: realWebhook.isHttpSuccess,
        isHttpPermanentFailure: realWebhook.isHttpPermanentFailure,
        isHttpDeadLetterFailure: realWebhook.isHttpDeadLetterFailure
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
                () => processMessageFile(filePath, { envelopeRecipients: ['reports@example.test'] }),
                (err) => isDeadLetterProcessingError(err) && !isPermanentProcessingError(err)
            );
        });
    } finally {
        restoreWebhook();
        restoreConfig();
    }
});

test('processMessageFile rejects a report too large to forward', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml']),
        MAX_XML_BYTES_NUM: 8 * 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    let posted = false;
    const restoreWebhook = mockModule(path.resolve(__dirname, '../src/webhook/post.js'), {
        postWebhook: async () => {
            posted = true;
            return 200;
        },
        isHttpSuccess: () => true,
        isHttpPermanentFailure: () => false,
        isHttpDeadLetterFailure: () => false
    });

    // Random printable text barely compresses, so a report just under the XML
    // limit still comes to more than the backend accepts in one request.
    const charset = Buffer.from('!#$%()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~');
    const noise = Buffer.from(require('node:crypto').randomBytes(8 * 1024 * 1024 - 1024).map(byte => charset[byte % charset.length]));
    const xml = [
        '<feedback>',
        '  <report_metadata><org_name>',
        noise.toString('latin1'),
        '</org_name><report_id>id-1</report_id></report_metadata>',
        '  <policy_published><domain>example.com</domain></policy_published>',
        '  <record><row></row></record>',
        '</feedback>'
    ].join('');

    try {
        const { processMessageFile } = freshProcessMessageRequire();
        await withTempMessage(makeMessage(xml), async (filePath) => {
            await assert.rejects(
                () => processMessageFile(filePath, { envelopeRecipients: ['reports@example.test'] }),
                (err) => isPermanentProcessingError(err) && /too large to forward/.test(String(err?.message || ''))
            );
        });
        assert.equal(posted, false);
    } finally {
        restoreWebhook();
        restoreConfig();
    }
});
