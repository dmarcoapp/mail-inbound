'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');

const { ensureTmpDir, safeUnlink, startTmpSweeper, BASE } = require('../src/io/tmp');
const { storeStreamToTmpFile } = require('../src/io/storeStreamToTmpFile');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('ensureTmpDir creates base directory', async () => {
    const dir = await ensureTmpDir();
    const st = await fs.stat(dir);
    assert.equal(st.isDirectory(), true);
    assert.equal(dir, BASE);
});

test('safeUnlink removes existing file and ignores missing', async () => {
    const dir = await ensureTmpDir();
    const p = path.join(dir, `tmp-${Date.now()}`);
    await fs.writeFile(p, 'x');

    await safeUnlink(p);
    await assert.rejects(() => fs.stat(p));
    await safeUnlink(p);
});

test('safeUnlink renames files when direct unlink fails', async () => {
    const fsPromises = require('node:fs/promises');
    const originalUnlink = fsPromises.unlink;
    const originalRename = fsPromises.rename;
    const dir = await ensureTmpDir();
    const p = path.join(dir, `rename-${Date.now()}`);
    await fs.writeFile(p, 'x');

    let renameTarget = '';
    fsPromises.unlink = async () => {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
    };
    fsPromises.rename = async (from, to) => {
        renameTarget = to;
        await originalRename(from, to);
    };

    try {
        await safeUnlink(p);
    } finally {
        fsPromises.unlink = originalUnlink;
        fsPromises.rename = originalRename;
    }

    assert.match(renameTarget, /\.delete\.\d+$/);
    await assert.rejects(() => fs.stat(p));
    await fs.unlink(renameTarget).catch(() => {});
});

test('startTmpSweeper removes old files', async () => {
    const dir = await ensureTmpDir();
    const p = path.join(dir, `old-${Date.now()}`);
    await fs.writeFile(p, 'old');

    const old = Date.now() - 120_000;
    await fs.utimes(p, old / 1000, old / 1000);

    startTmpSweeper({ intervalMs: 5, maxAgeMs: 60_000 });
    await delay(30);

    await assert.rejects(() => fs.stat(p));
});

test('startTmpSweeper tolerates a missing temp directory', async () => {
    const fsPromises = require('node:fs/promises');
    const originalReaddir = fsPromises.readdir;

    fsPromises.readdir = async () => {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
    };

    try {
        startTmpSweeper({ intervalMs: 5, maxAgeMs: 60_000 });
        await delay(15);
    } finally {
        fsPromises.readdir = originalReaddir;
    }
});

test('storeStreamToTmpFile writes stream content', async () => {
    const result = await storeStreamToTmpFile(Readable.from(['hello']), 'blob');
    const saved = await fs.readFile(result.filePath, 'utf8');
    assert.equal(saved, 'hello');
    await fs.unlink(result.filePath);
});

test('storeStreamToTmpFile writes buffer content', async () => {
    const result = await storeStreamToTmpFile(Buffer.from('buffer-data'), 'blob');
    const saved = await fs.readFile(result.filePath, 'utf8');
    assert.equal(saved, 'buffer-data');
    await fs.unlink(result.filePath);
});

test('storeStreamToTmpFile rejects when the source stream errors', async () => {
    const source = new Readable({
        read() {
            this.destroy(new Error('source-fail'));
        }
    });

    await assert.rejects(
        () => storeStreamToTmpFile(source, 'blob'),
        /source-fail/
    );
});

test('storeStreamToTmpFile rejects when ending the write stream throws', async () => {
    const originalCreateWriteStream = fssync.createWriteStream;

    fssync.createWriteStream = () => {
        const ws = new Writable({
            write(_chunk, _enc, cb) {
                cb();
            }
        });
        ws.end = () => {
            throw new Error('end-fail');
        };
        return ws;
    };

    try {
        await assert.rejects(
            () => storeStreamToTmpFile(Readable.from(['data']), 'blob'),
            /end-fail/
        );
    } finally {
        fssync.createWriteStream = originalCreateWriteStream;
    }
});
