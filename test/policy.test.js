'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function withMockedConfig(mockExports, fn) {
    const configPath = path.resolve(__dirname, '../src/config.js');
    const previous = require.cache[configPath];
    require.cache[configPath] = {
        id: configPath,
        filename: configPath,
        loaded: true,
        exports: mockExports
    };

    try {
        fn();
    } finally {
        if (previous) require.cache[configPath] = previous;
        else delete require.cache[configPath];
    }
}

function freshRequire(modulePath) {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
}

test('attachmentPolicy enforces required attachments and extension allowlist', () => {
    withMockedConfig({
        REQUIRE_ATTACHMENTS_BOOL: true,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set(['.xml', '.zip'])
    }, () => {
        const { validateAttachmentsOrThrow, getSafeFilename } = freshRequire('../src/policy/attachmentPolicy');

        assert.throws(() => validateAttachmentsOrThrow([]), /attachment required/);
        assert.equal(getSafeFilename({ filename: '../report.XML' }), 'report.XML');
        assert.throws(() => validateAttachmentsOrThrow([{ filename: 'report.exe' }]), /extension not allowed/);
        assert.doesNotThrow(() => validateAttachmentsOrThrow([{ filename: 'report.XML' }]));
    });
});

test('attachmentPolicy enforces max attachment count and filename presence', () => {
    withMockedConfig({
        REQUIRE_ATTACHMENTS_BOOL: false,
        MAX_ATTACHMENTS_NUM: 1,
        ALLOWED_ATTACHMENT_EXTENSIONS_SET: new Set()
    }, () => {
        const { validateAttachmentsOrThrow } = freshRequire('../src/policy/attachmentPolicy');

        assert.throws(() => validateAttachmentsOrThrow([{ filename: 'a.txt' }, { filename: 'b.txt' }]), /too many attachments/);
        assert.throws(() => validateAttachmentsOrThrow([{ filename: '   ' }]), /filename required/);
    });
});
