'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { warn } = require('./logger');

function sha256Hex() {
    return crypto.createHash('sha256');
}

function readSecret(name, fallbackEnv = null) {
    const p = `/run/secrets/${name}`;
    try {
        return fs.readFileSync(p, 'utf8').trim();
    } catch (err) {
        if (fallbackEnv && process.env[fallbackEnv]) {
            warn('secrets', 'using env fallback for secret', {
                path: p,
                fallbackEnv,
                reason: String(err.code || err.message || err)
            });
            return process.env[fallbackEnv];
        }

        const msg = err && err.code
            ? `${err.code}: ${err.message}`
            : String(err);

        throw new Error(`Missing secret: ${name} (path=${p}, error=${msg})`);
    }
}


module.exports = { sha256Hex, readSecret };
