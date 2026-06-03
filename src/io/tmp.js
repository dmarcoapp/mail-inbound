'use strict';

const fs = require('fs/promises');
const path = require('path');

const BASE = path.join('/tmp', 'mail-inbound-webhook');

async function ensureTmpDir() {
    await fs.mkdir(BASE, { recursive: true });
    return BASE;
}

async function safeUnlink(filePath) {
    try {
        await fs.unlink(filePath);
        return;
    } catch (e) {
        if (e?.code === 'ENOENT') return;

        // Ha nem tudjuk törölni, átnevezzük és a sweeper majd leszedni próbálja később.
        try {
            const renamed = `${filePath}.delete.${Date.now()}`;
            await fs.rename(filePath, renamed).catch(() => {});
        } catch {}
    }
}

function startTmpSweeper({ intervalMs = 60_000, maxAgeMs = 60 * 60_000 } = {}) {
    const t = setInterval(async () => {
        let dirents;
        try {
            dirents = await fs.readdir(BASE, { withFileTypes: true });
        } catch {
            return;
        }
        const now = Date.now();
        await Promise.allSettled(
            dirents
                .filter(d => d.isFile())
                .map(async (d) => {
                    const p = path.join(BASE, d.name);
                    try {
                        const st = await fs.stat(p);
                        if (now - st.mtimeMs > maxAgeMs) {
                            await fs.unlink(p).catch(() => {});
                        }
                    } catch {}
                })
        );
    }, intervalMs);
    if (typeof t.unref === 'function') t.unref();
}

module.exports = { ensureTmpDir, safeUnlink, startTmpSweeper, BASE };
