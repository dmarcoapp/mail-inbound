'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { ensureTmpDir, safeUnlink } = require('./tmp');
const { randomId } = require('../randomId');

function asReadable(input) {
    if (Buffer.isBuffer(input)) return Readable.from(input);
    return input;
}

async function storeStreamToTmpFile(stream, prefix = 'blob') {
    const dir = await ensureTmpDir();
    const id = randomId();
    const filePath = path.join(dir, `${prefix}.${id}`);
    const ws = fs.createWriteStream(filePath, { flags: 'wx' });
    const source = asReadable(stream);

    return new Promise((resolve, reject) => {
        let done = false;

        function fail(err) {
            if (done) return;
            done = true;
            try { ws.destroy(); } catch {}
            try { source.destroy?.(err); } catch {}
            safeUnlink(filePath).catch(() => {});
            reject(err);
        }

        ws.on('error', fail);
        source.on('error', fail);

        source.on('data', (chunk) => {
            if (!ws.write(chunk)) {
                source.pause?.();
                ws.once('drain', () => source.resume?.());
            }
        });

        source.on('end', () => {
            try {
                ws.end();
            } catch (err) {
                fail(err);
            }
        });

        ws.on('close', () => {
            if (done) return;
            done = true;
            resolve({ id, filePath });
        });

        source.resume?.();
    });
}

module.exports = { storeStreamToTmpFile };
