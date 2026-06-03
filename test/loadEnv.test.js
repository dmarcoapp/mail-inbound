'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('loadEnv loads .env and applies .env.local overrides', async () => {
    const cwd = process.cwd();
    const keys = ['LOAD_ENV_BASE', 'LOAD_ENV_OVERRIDE', 'LOAD_ENV_LOCAL_ONLY'];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'load-env-'));

    try {
        for (const key of keys) {
            delete process.env[key];
        }

        await fs.writeFile(
            path.join(dir, '.env'),
            [
                'LOAD_ENV_BASE=base',
                'LOAD_ENV_OVERRIDE=base'
            ].join('\n')
        );
        await fs.writeFile(
            path.join(dir, '.env.local'),
            [
                'LOAD_ENV_OVERRIDE=local',
                'LOAD_ENV_LOCAL_ONLY=local'
            ].join('\n')
        );

        process.chdir(dir);
        const modulePath = require.resolve('../src/loadEnv');
        delete require.cache[modulePath];
        const { loadEnv } = require(modulePath);

        loadEnv();

        assert.equal(process.env.LOAD_ENV_BASE, 'base');
        assert.equal(process.env.LOAD_ENV_OVERRIDE, 'local');
        assert.equal(process.env.LOAD_ENV_LOCAL_ONLY, 'local');
    } finally {
        process.chdir(cwd);
        for (const key of keys) {
            const value = previous.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(dir, { recursive: true, force: true });
    }
});
