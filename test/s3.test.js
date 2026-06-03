'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');

function mockModule(modulePath, exports) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    const prev = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return () => {
        if (prev) require.cache[resolved] = prev;
        else delete require.cache[resolved];
    };
}

function freshRequire(modulePath) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    delete require.cache[resolved];
    return require(resolved);
}

test('uploadToS3 sanitizes metadata and returns bucket/key', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        S3_BUCKET: 'my-bucket',
        S3_UPLOAD_TIMEOUT_MS_NUM: 50
    });

    const restoreClient = mockModule(path.resolve(__dirname, '../src/s3/client.js'), {
        s3: { stub: true }
    });

    let captured = null;
    const restoreUpload = mockModule('@aws-sdk/lib-storage', {
        Upload: class {
            constructor(opts) {
                captured = opts;
            }
            async done() {
                return {};
            }
            abort() {
            }
        }
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmarco-s3-'));
    const p = path.join(dir, `file-${Date.now()}.txt`);
    await fs.writeFile(p, 'hello');
    const originalCreateReadStream = fssync.createReadStream;
    fssync.createReadStream = () => {
        const rs = Readable.from(['hello']);
        rs.on('error', () => {});
        return rs;
    };

    try {
        const { uploadToS3 } = freshRequire('../src/s3/upload');
        const res = await uploadToS3({
            key: 'k1',
            filePath: p,
            meta: {
                filename: 'bad\u0001name',
                contentDisposition: 'x'.repeat(600),
                contentId: 'cid\u0007'
            }
        });

        assert.equal(res.bucket, 'my-bucket');
        assert.equal(res.key, 'k1');
        assert.equal(captured.params.Bucket, 'my-bucket');
        assert.equal(captured.params.Metadata.filename.includes('\u0001'), false);
        assert.equal(captured.params.Metadata.content_disposition.length <= 500, true);
        assert.equal(captured.params.Metadata.content_id.includes('\u0007'), false);
        assert.equal(captured.params.ContentType, 'application/octet-stream');
    } finally {
        fssync.createReadStream = originalCreateReadStream;
        restoreUpload();
        restoreClient();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
        await fs.rmdir(dir).catch(() => {});
    }
});

test('uploadToS3 times out and aborts', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        S3_BUCKET: 'my-bucket',
        S3_UPLOAD_TIMEOUT_MS_NUM: 10
    });

    const restoreClient = mockModule(path.resolve(__dirname, '../src/s3/client.js'), {
        s3: { stub: true }
    });

    let aborted = false;
    const restoreUpload = mockModule('@aws-sdk/lib-storage', {
        Upload: class {
            constructor() {}
            async done() {
                return new Promise(() => {});
            }
            abort() {
                aborted = true;
            }
        }
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmarco-s3-'));
    const p = path.join(dir, `file-${Date.now()}-timeout.txt`);
    await fs.writeFile(p, 'hello');
    const originalCreateReadStream = fssync.createReadStream;
    let bodyDestroyed = false;
    fssync.createReadStream = () => {
        const rs = Readable.from(['hello']);
        rs.destroy = () => {
            bodyDestroyed = true;
        };
        rs.on('error', () => {});
        return rs;
    };

    try {
        const { uploadToS3 } = freshRequire('../src/s3/upload');
        try {
            await uploadToS3({ key: 'k2', filePath: p, meta: {} });
            assert.fail('expected timeout');
        } catch (err) {
            assert.ok(/S3 upload timeout/.test(err && err.message));
        }
        assert.equal(aborted, true);
        assert.equal(bodyDestroyed, true);
    } finally {
        fssync.createReadStream = originalCreateReadStream;
        restoreUpload();
        restoreClient();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
        await fs.rmdir(dir).catch(() => {});
    }
});

test('uploadToS3 handles abort/destroy errors and finally destroy errors', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        S3_BUCKET: 'my-bucket',
        S3_UPLOAD_TIMEOUT_MS_NUM: 10
    });

    const restoreClient = mockModule(path.resolve(__dirname, '../src/s3/client.js'), {
        s3: { stub: true }
    });

    const restoreUpload = mockModule('@aws-sdk/lib-storage', {
        Upload: class {
            constructor() {}
            async done() {
                return new Promise(() => {});
            }
            abort() {
                throw new Error('abort-fail');
            }
        }
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmarco-s3-'));
    const p = path.join(dir, `file-${Date.now()}-timeout2.txt`);
    await fs.writeFile(p, 'hello');
    const originalCreateReadStream = fssync.createReadStream;
    fssync.createReadStream = () => {
        const rs = Readable.from(['hello']);
        rs.destroy = () => { throw new Error('destroy-fail'); };
        rs.on('error', () => {});
        return rs;
    };

    try {
        const { uploadToS3 } = freshRequire('../src/s3/upload');
        await assert.rejects(() => uploadToS3({ key: 'k3', filePath: p, meta: {} }), /S3 upload timeout/);
    } finally {
        fssync.createReadStream = originalCreateReadStream;
        restoreUpload();
        restoreClient();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
        await fs.rmdir(dir).catch(() => {});
    }
});

test('deleteFromS3 sends delete requests with bucket fallback', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        S3_BUCKET: 'my-bucket'
    });

    const sent = [];
    const restoreClient = mockModule(path.resolve(__dirname, '../src/s3/client.js'), {
        s3: {
            send: async (command) => {
                sent.push(command.input);
            }
        }
    });

    try {
        const { deleteFromS3 } = freshRequire('../src/s3/delete');
        await deleteFromS3({ key: 'k1' });
        await deleteFromS3({ bucket: 'override-bucket', key: 'k2' });
    } finally {
        restoreClient();
        restoreConfig();
    }

    assert.deepEqual(sent, [
        { Bucket: 'my-bucket', Key: 'k1' },
        { Bucket: 'override-bucket', Key: 'k2' }
    ]);
});
