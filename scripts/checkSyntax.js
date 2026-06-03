'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = process.argv.slice(2);
if (roots.length === 0) {
    roots.push('src', 'test');
}

function collectJsFiles(target, files = []) {
    if (!fs.existsSync(target)) return files;

    const stat = fs.statSync(target);
    if (stat.isFile()) {
        if (target.endsWith('.js')) files.push(target);
        return files;
    }

    if (!stat.isDirectory()) return files;

    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        collectJsFiles(path.join(target, entry.name), files);
    }

    return files;
}

const files = roots.flatMap((root) => collectJsFiles(root)).sort();
let failed = false;

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) {
        failed = true;
    }
}

if (failed) {
    process.exitCode = 1;
}
