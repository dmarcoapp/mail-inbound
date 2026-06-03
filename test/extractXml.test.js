'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const EventEmitter = require('node:events');
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

function freshRequire(modulePath) {
    const resolved = require.resolve(modulePath, { paths: [__dirname] });
    delete require.cache[resolved];
    return require(resolved);
}

function tmpFile(name) {
    return path.join(os.tmpdir(), `dmarco-${Date.now()}-${name}`);
}

test('extractXmlFromFile passes through XML file', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.xml');
    await fs.writeFile(p, '<xml/>');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        const res = await extractXmlFromFile({ filePath: p, filename: 'report.xml' });
        assert.equal(res.filePath, p);
        assert.equal(res.filename, 'report.xml');
        assert.equal(res.contentType, 'application/xml');
        assert.equal(res.cleanupPaths.length, 0);
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects plain XML over MAX_XML_BYTES', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 5,
        MAX_COMPRESSION_RATIO_NUM: 100
    });

    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report-large.xml');
    await fs.writeFile(p, '<xml>toolarge</xml>');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report-large.xml' }),
            isPermanentProcessingError
        );
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects non-XML file', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.txt');
    await fs.writeFile(p, 'nope');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.txt' }),
            isPermanentProcessingError
        );
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile ungzips to XML and enforces limits', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.xml.gz');
    const gz = zlib.gzipSync(Buffer.from('<xml>ok</xml>'));
    await fs.writeFile(p, gz);

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        const res = await extractXmlFromFile({ filePath: p, filename: 'report.xml.gz' });
        const content = await fs.readFile(res.filePath, 'utf8');
        assert.equal(content, '<xml>ok</xml>');
        assert.equal(res.filename, 'report.xml');
        await fs.unlink(res.filePath).catch(() => {});
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects gzip with non-xml base name', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.txt.gz');
    const gz = zlib.gzipSync(Buffer.from('nope'));
    await fs.writeFile(p, gz);

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.txt.gz' }),
            isPermanentProcessingError
        );
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects gzip bombs by size', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 5,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.xml.gz');
    const gz = zlib.gzipSync(Buffer.from('0123456789'));
    await fs.writeFile(p, gz);

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.xml.gz' }),
            isPermanentProcessingError
        );
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

function mockYauzlWithEntry({ fileName, uncompressedSize, compressedSize, data }) {
    const fake = new EventEmitter();
    fake.readEntry = () => {
        setImmediate(() => fake.emit('entry', {
            fileName,
            uncompressedSize,
            compressedSize
        }));
        setImmediate(() => fake.emit('end'));
    };
    fake.openReadStream = (entry, cb) => {
        const rs = Readable.from([data]);
        cb(null, rs);
    };
    fake.close = () => {};
    return (pathArg, opts, cb) => cb(null, fake);
}

function mockYauzlFromEntries(entries) {
    const fake = new EventEmitter();
    let idx = 0;
    fake.readEntry = () => {
        setImmediate(() => {
            if (idx >= entries.length) {
                fake.emit('end');
                return;
            }
            fake.emit('entry', entries[idx++]);
        });
    };
    fake.openReadStream = (entry, cb) => {
        if (entry.openReadStreamError) return cb(new Error('open-read-fail'));
        const rs = entry.stream || Readable.from([entry.data || '']);
        cb(null, rs);
    };
    fake.close = () => {};
    return (pathArg, opts, cb) => cb(null, fake);
}

test('extractXmlFromFile extracts single XML from zip with nested path', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const restoreYauzl = mockModule('yauzl', {
        open: mockYauzlWithEntry({
            fileName: 'nested/report.xml',
            uncompressedSize: 10,
            compressedSize: 5,
            data: '<xml/>'
        })
    });

    const p = tmpFile('report.zip');
    await fs.writeFile(p, 'fakezip');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        const res = await extractXmlFromFile({ filePath: p, filename: 'report.zip' });
        const content = await fs.readFile(res.filePath, 'utf8');
        assert.equal(content, '<xml/>');
        assert.equal(res.filename, 'report.xml');
        await fs.unlink(res.filePath).catch(() => {});
    } finally {
        restoreYauzl();
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects zip with non-xml entry', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const restoreYauzl = mockModule('yauzl', {
        open: mockYauzlWithEntry({
            fileName: 'report.txt',
            uncompressedSize: 10,
            compressedSize: 5,
            data: 'nope'
        })
    });

    const p = tmpFile('report.zip');
    await fs.writeFile(p, 'fakezip');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzl();
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects zip bombs by ratio', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 2
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const restoreYauzl = mockModule('yauzl', {
        open: mockYauzlWithEntry({
            fileName: 'report.xml',
            uncompressedSize: 10,
            compressedSize: 1,
            data: '<xml/>'
        })
    });

    const p = tmpFile('report.zip');
    await fs.writeFile(p, 'fakezip');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzl();
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects invalid gzip payload', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.xml.gz');
    await fs.writeFile(p, 'not-gzip-data');

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.xml.gz' }),
            isPermanentProcessingError
        );
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects invalid zip and traversal/multi-entry zips', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.zip');
    await fs.writeFile(p, 'fakezip');

    const restoreYauzlOpenErr = mockModule('yauzl', {
        open: (pathArg, opts, cb) => cb(new Error('zip-open-fail'))
    });

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlOpenErr();
    }

    const restoreYauzlTraversal = mockModule('yauzl', {
        open: mockYauzlFromEntries([{ fileName: '../evil.xml', uncompressedSize: 1, compressedSize: 1, data: 'x' }])
    });
    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlTraversal();
    }

    const restoreYauzlMulti = mockModule('yauzl', {
        open: (pathArg, opts, cb) => {
            const fake = new EventEmitter();
            fake.readEntry = () => {
                setImmediate(() => {
                    fake.emit('entry', { fileName: 'a.xml', uncompressedSize: 1, compressedSize: 1 });
                    fake.emit('entry', { fileName: 'b.xml', uncompressedSize: 1, compressedSize: 1 });
                    fake.emit('end');
                });
            };
            fake.openReadStream = (entry, cb2) => cb2(null, Readable.from(['a']));
            fake.close = () => {};
            cb(null, fake);
        }
    });
    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlMulti();
    }

    restoreUuid();
    restoreConfig();
    await fs.unlink(p).catch(() => {});
});

test('extractXmlFromFile rejects zip stream/open/write errors', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const p = tmpFile('report.zip');
    await fs.writeFile(p, 'fakezip');

    const restoreYauzlOpenStreamErr = mockModule('yauzl', {
        open: mockYauzlFromEntries([{ fileName: 'a.xml', uncompressedSize: 1, compressedSize: 1, openReadStreamError: true }])
    });

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlOpenStreamErr();
    }

    const badStream = new Readable({
        read() {
            this.destroy(new Error('stream-read-fail'));
        }
    });
    badStream.on('error', () => {});

    const restoreYauzlReadErr = mockModule('yauzl', {
        open: mockYauzlFromEntries([{ fileName: 'a.xml', uncompressedSize: 1, compressedSize: 1, stream: badStream }])
    });
    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlReadErr();
    }

    const fssync = require('fs');
    const originalCreate = fssync.createWriteStream;
    fssync.createWriteStream = () => {
        const ws = new EventEmitter();
        ws.write = () => true;
        ws.end = () => {};
        ws.destroy = () => {};
        ws.once = ws.once.bind(ws);
        ws.on = ws.on.bind(ws);
        setImmediate(() => ws.emit('error', new Error('ws-fail')));
        return ws;
    };

    const restoreYauzlOk = mockModule('yauzl', {
        open: mockYauzlFromEntries([{ fileName: 'a.xml', uncompressedSize: 1, compressedSize: 1, data: 'x' }])
    });
    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'report.zip' }),
            /ws-fail/
        );
    } finally {
        fssync.createWriteStream = originalCreate;
        restoreYauzlOk();
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile skips zip directory entries', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });
    const p = tmpFile('report-dir.zip');
    await fs.writeFile(p, 'fakezip');

    const restoreYauzl = mockModule('yauzl', {
        open: mockYauzlFromEntries([
            { fileName: 'nested/', uncompressedSize: 0, compressedSize: 0 },
            { fileName: 'nested/report.xml', uncompressedSize: 5, compressedSize: 5, data: '<a/>' }
        ])
    });

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        const res = await extractXmlFromFile({ filePath: p, filename: 'report-dir.zip' });
        assert.equal(res.filename, 'report.xml');
        await fs.unlink(res.filePath).catch(() => {});
    } finally {
        restoreYauzl();
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects gzip bombs by compression ratio', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 5
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => `fixed-ratio-${Date.now()}` });

    const p = tmpFile('ratio.xml.gz');
    const gz = zlib.gzipSync(Buffer.from('A'.repeat(20_000)));
    await fs.writeFile(p, gz);

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'ratio.xml.gz' }),
            isPermanentProcessingError
        );
    } finally {
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects gzip read stream errors', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });

    const fssync = require('fs');
    const originalCreateRead = fssync.createReadStream;
    fssync.createReadStream = () => {
        const rs = new Readable({
            read() {
                this.destroy(new Error('gzip-read-fail'));
            }
        });
        rs.on('error', () => {});
        return rs;
    };

    const p = tmpFile('read-fail.xml.gz');
    const gz = zlib.gzipSync(Buffer.from('<xml/>'));
    await fs.writeFile(p, gz);

    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'read-fail.xml.gz' }),
            /gzip-read-fail/
        );
    } finally {
        fssync.createReadStream = originalCreateRead;
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});

test('extractXmlFromFile rejects zipfile error events and empty zips', async () => {
    const restoreConfig = mockModule(path.resolve(__dirname, '../src/config.js'), {
        MAX_XML_BYTES_NUM: 1024 * 1024,
        MAX_COMPRESSION_RATIO_NUM: 100
    });
    const restoreUuid = mockModule(path.resolve(__dirname, '../src/randomId.js'), { randomId: () => 'fixed' });
    const p = tmpFile('zip-edge.zip');
    await fs.writeFile(p, 'fakezip');

    const restoreYauzlErrorEvent = mockModule('yauzl', {
        open: (pathArg, opts, cb) => {
            const fake = new EventEmitter();
            fake.readEntry = () => setImmediate(() => fake.emit('error', new Error('zipfile-error')));
            fake.openReadStream = (_entry, cb2) => cb2(null, Readable.from(['x']));
            fake.close = () => {};
            cb(null, fake);
        }
    });
    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'zip-edge.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlErrorEvent();
    }

    const restoreYauzlEmpty = mockModule('yauzl', {
        open: (pathArg, opts, cb) => {
            const fake = new EventEmitter();
            fake.readEntry = () => setImmediate(() => fake.emit('end'));
            fake.openReadStream = (_entry, cb2) => cb2(null, Readable.from(['x']));
            fake.close = () => {};
            cb(null, fake);
        }
    });
    try {
        const { extractXmlFromFile } = freshRequire('../src/attachments/extractXml');
        await assert.rejects(
            () => extractXmlFromFile({ filePath: p, filename: 'zip-edge.zip' }),
            isPermanentProcessingError
        );
    } finally {
        restoreYauzlEmpty();
        restoreUuid();
        restoreConfig();
        await fs.unlink(p).catch(() => {});
    }
});
