'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const yauzl = require('yauzl');

const { permanentProcessingError } = require('../processingErrors');
const { ensureTmpDir, safeUnlink } = require('../io/tmp');
const { MAX_XML_BYTES_NUM, MAX_COMPRESSION_RATIO_NUM } = require('../config');
const { randomId } = require('../randomId');

function isXmlFilename(name) {
    return String(name || '').toLowerCase().endsWith('.xml');
}

function isGzipFilename(name) {
    const lower = String(name || '').toLowerCase();
    return lower.endsWith('.gz') || lower.endsWith('.gzip');
}

function isZipFilename(name) {
    return String(name || '').toLowerCase().endsWith('.zip');
}

function safeBaseName(name) {
    return path.basename(String(name || '').trim());
}

function xmlContentType() {
    return 'application/xml';
}

function errNonXml() {
    return permanentProcessingError('Message rejected: attachment must be XML');
}

function errTooLarge() {
    return permanentProcessingError('Message rejected: attachment too large');
}

function errZipInvalid() {
    return permanentProcessingError('Message rejected: invalid zip attachment');
}

function errGzipInvalid() {
    return permanentProcessingError('Message rejected: invalid gzip attachment');
}

async function extractGzipToXml({ filePath, filename }) {
    const base = safeBaseName(filename);
    const xmlName = base.replace(/\.gzip$/i, '').replace(/\.gz$/i, '');
    if (!isXmlFilename(xmlName)) throw errNonXml();

    const st = await fsp.stat(filePath);
    const compressedSize = st.size || 0;

    const tmpDir = await ensureTmpDir();
    const outPath = path.join(tmpDir, `xml.${randomId()}.${path.basename(xmlName)}`);

    const rs = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    const ws = fs.createWriteStream(outPath, { flags: 'wx' });

    let seen = 0;
    const maxBytes = MAX_XML_BYTES_NUM;
    const maxRatio = MAX_COMPRESSION_RATIO_NUM;

    return new Promise((resolve, reject) => {
        let done = false;
        function fail(err) {
            if (done) return;
            done = true;
            try { rs.destroy(); } catch {}
            try { gunzip.destroy(); } catch {}
            try { ws.destroy(); } catch {}
            safeUnlink(outPath).catch(() => {});
            reject(err);
        }

        rs.on('error', fail);
        gunzip.on('error', () => fail(errGzipInvalid()));
        ws.on('error', fail);

        gunzip.on('data', (chunk) => {
            seen += chunk.length;
            if (seen > maxBytes) return fail(errTooLarge());
            if (compressedSize > 0 && seen > compressedSize * maxRatio) return fail(errTooLarge());
        });

        ws.on('close', () => {
            if (done) return;
            done = true;
            resolve({ filePath: outPath, filename: xmlName, contentType: xmlContentType(), cleanupPaths: [outPath] });
        });

        rs.pipe(gunzip).pipe(ws);
    });
}

function openZip(filePath) {
    return new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true, decodeStrings: true }, (err, zipfile) => {
            if (err) return reject(err);
            resolve(zipfile);
        });
    });
}

async function extractZipToXml({ filePath }) {
    const tmpDir = await ensureTmpDir();
    const outPath = path.join(tmpDir, `xml.${randomId()}.xml`);

    const zipfile = await openZip(filePath).catch(() => {
        throw errZipInvalid();
    });

    return new Promise((resolve, reject) => {
        let done = false;
        let foundEntry = null;

        function fail(err) {
            if (done) return;
            done = true;
            try { zipfile.close(); } catch {}
            safeUnlink(outPath).catch(() => {});
            reject(err);
        }

        zipfile.on('error', () => fail(errZipInvalid()));

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
            if (/\/$/.test(entry.fileName)) {
                zipfile.readEntry();
                return;
            }

            if (foundEntry) return fail(errZipInvalid());

            if (entry.fileName.includes('..') || entry.fileName.startsWith('/') || entry.fileName.startsWith('\\')) {
                return fail(errZipInvalid());
            }

            const base = safeBaseName(entry.fileName);
            if (!isXmlFilename(base)) return fail(errNonXml());

            if (entry.uncompressedSize > MAX_XML_BYTES_NUM) return fail(errTooLarge());
            if (entry.compressedSize > 0 && entry.uncompressedSize > entry.compressedSize * MAX_COMPRESSION_RATIO_NUM) {
                return fail(errTooLarge());
            }

            foundEntry = { entry, filename: base };

            zipfile.openReadStream(entry, (err, rs) => {
                if (err) return fail(errZipInvalid());

                const ws = fs.createWriteStream(outPath, { flags: 'wx' });
                let seen = 0;

                rs.on('error', () => fail(errZipInvalid()));
                ws.on('error', fail);

                rs.on('data', (chunk) => {
                    seen += chunk.length;
                    if (seen > MAX_XML_BYTES_NUM) return fail(errTooLarge());
                });

                ws.on('close', () => {
                    if (done) return;
                    done = true;
                    try { zipfile.close(); } catch {}
                    resolve({ filePath: outPath, filename: base, contentType: xmlContentType(), cleanupPaths: [outPath] });
                });

                rs.pipe(ws);
            });
        });

        zipfile.on('end', () => {
            if (!foundEntry) return fail(errZipInvalid());
        });
    });
}

async function extractXmlFromFile({ filePath, filename }) {
    const base = safeBaseName(filename);
    if (isXmlFilename(base)) {
        const st = await fsp.stat(filePath);
        if ((st?.size || 0) > MAX_XML_BYTES_NUM) throw errTooLarge();
        return { filePath, filename: base, contentType: xmlContentType(), cleanupPaths: [] };
    }

    if (isGzipFilename(base)) {
        return extractGzipToXml({ filePath, filename: base });
    }

    if (isZipFilename(base)) {
        return extractZipToXml({ filePath });
    }

    throw errNonXml();
}

module.exports = {
    extractXmlFromFile,
    isXmlFilename,
    isGzipFilename,
    isZipFilename
};
