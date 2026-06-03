'use strict';

const net = require('net');
const fs = require('fs/promises');
const {
    CLAMAV_SCAN_ENABLED_BOOL,
    CLAMAV_HOST,
    CLAMAV_PORT_NUM,
    CLAMAV_TIMEOUT_MS_NUM
} = require('../config');

async function writeToSocket(socket, buffer) {
    await new Promise((resolve, reject) => {
        if (!socket.writable) {
            reject(new Error('ClamAV socket is not writable'));
            return;
        }

        const onError = (err) => {
            socket.off('drain', onDrain);
            reject(err);
        };
        const onDrain = () => {
            socket.off('error', onError);
            resolve();
        };

        socket.once('error', onError);

        if (socket.write(buffer)) {
            socket.off('error', onError);
            resolve();
            return;
        }

        socket.once('drain', onDrain);
    });
}

function parseClamavResponse(chunks) {
    const raw = Buffer.concat(chunks).toString('utf8').replace(/\u0000/g, '').trim();

    if (/ FOUND$/i.test(raw)) {
        const match = raw.match(/: (.+) FOUND$/i);
        return {
            clean: false,
            virus: match ? match[1] : 'unknown'
        };
    }

    if (/ OK$/i.test(raw)) {
        return {
            clean: true,
            virus: ''
        };
    }

    throw new Error(raw || 'Unexpected ClamAV response');
}

async function scanFileWithClamav(
    filePath,
    {
        enabled = CLAMAV_SCAN_ENABLED_BOOL,
        host = CLAMAV_HOST || 'clamav',
        port = CLAMAV_PORT_NUM || 3310,
        timeoutMs = CLAMAV_TIMEOUT_MS_NUM || 10_000,
        chunkSize = 64 * 1024
    } = {}
) {
    if (!enabled) {
        return {
            clean: true,
            virus: '',
            skipped: true
        };
    }

    const body = await fs.readFile(filePath);

    return await new Promise((resolve, reject) => {
        const chunks = [];
        const socket = net.createConnection({ host, port });
        let settled = false;

        function finish(fn, value) {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            fn(value);
        }

        socket.setTimeout(timeoutMs, () => {
            finish(reject, new Error(`ClamAV scan timeout after ${timeoutMs}ms`));
        });

        socket.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
        });

        socket.once('end', () => {
            try {
                finish(resolve, parseClamavResponse(chunks));
            } catch (err) {
                finish(reject, err);
            }
        });

        socket.once('error', (err) => {
            finish(reject, err);
        });

        socket.once('connect', async () => {
            try {
                await writeToSocket(socket, Buffer.from('zINSTREAM\0', 'utf8'));

                for (let offset = 0; offset < body.length; offset += chunkSize) {
                    const chunk = body.subarray(offset, Math.min(offset + chunkSize, body.length));
                    const header = Buffer.allocUnsafe(4);
                    header.writeUInt32BE(chunk.length, 0);
                    await writeToSocket(socket, header);
                    await writeToSocket(socket, chunk);
                }

                const tail = Buffer.alloc(4);
                tail.writeUInt32BE(0, 0);
                await writeToSocket(socket, tail);
                socket.end();
            } catch (err) {
                finish(reject, err);
            }
        });
    });
}

module.exports = {
    scanFileWithClamav
};
