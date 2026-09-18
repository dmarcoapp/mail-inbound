'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { validateAggregateDmarcReport } = require('../src/dmarc/validateReport');
const { isPermanentProcessingError } = require('../src/processingErrors');

async function withTempFile(name, contents, fn) {
    const filePath = path.join(os.tmpdir(), `dmarc-${Date.now()}-${name}`);
    await fs.writeFile(filePath, contents, 'utf8');
    try {
        await fn(filePath);
    } finally {
        await fs.unlink(filePath).catch(() => {});
    }
}

test('validateAggregateDmarcReport accepts aggregate report xml', async () => {
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feedback>',
        '  <report_metadata>',
        '    <org_name>Example Reporter</org_name>',
        '    <report_id>abc-123</report_id>',
        '  </report_metadata>',
        '  <policy_published>',
        '    <domain>example.com</domain>',
        '  </policy_published>',
        '  <record>',
        '    <row></row>',
        '  </record>',
        '</feedback>'
    ].join('\n');

    await withTempFile('valid.xml', xml, async (filePath) => {
        const result = await validateAggregateDmarcReport({ filePath });
        assert.equal(result.reportId, 'abc-123');
        assert.equal(result.orgName, 'Example Reporter');
    });
});

test('validateAggregateDmarcReport accepts namespace-prefixed tags', async () => {
    const xml = [
        '<ns:feedback xmlns:ns="urn:ietf:params:xml:ns:dmarc-1.0">',
        '  <ns:report_metadata>',
        '    <ns:org_name>Example Reporter</ns:org_name>',
        '  </ns:report_metadata>',
        '  <ns:policy_published></ns:policy_published>',
        '  <ns:record></ns:record>',
        '</ns:feedback>'
    ].join('\n');

    await withTempFile('valid-ns.xml', xml, async (filePath) => {
        const result = await validateAggregateDmarcReport({ filePath });
        assert.equal(result.orgName, 'Example Reporter');
    });
});

test('validateAggregateDmarcReport rejects non-aggregate xml', async () => {
    const xml = [
        '<feedback>',
        '  <report_metadata></report_metadata>',
        '  <policy_published></policy_published>',
        '</feedback>'
    ].join('\n');

    await withTempFile('invalid.xml', xml, async (filePath) => {
        await assert.rejects(
            () => validateAggregateDmarcReport({ filePath }),
            isPermanentProcessingError
        );
    });
});

test('validateAggregateDmarcReport still extracts text after an unclosed tag', async () => {
    const xml = [
        '<feedback>',
        '  <report_metadata>',
        '    <org_name>Example Reporter</org_name>',
        '    <report_id>abc-123</report_id>',
        '    <comment><report_id>',
        '  </report_metadata>',
        '  <policy_published></policy_published>',
        '  <record></record>',
        '</feedback>'
    ].join('\n');

    await withTempFile('unclosed.xml', xml, async (filePath) => {
        const result = await validateAggregateDmarcReport({ filePath });
        assert.equal(result.reportId, 'abc-123');
        assert.equal(result.orgName, 'Example Reporter');
    });
});

// Locating both tags with one pattern needs a lazy match between them and a
// quantified attribute list in the opening tag. Either one rescans the rest of
// the document from every candidate tag, so the cost grows quadratically: at
// 3 MiB these payloads already took 105 and 347 seconds, far past the worker
// timeout, and one attachment stalled a worker through its whole retry run.
const PADDINGS = {
    'unclosed opening tags': '<report_id>',
    'an opening tag that never ends': '<report_id a'
};

for (const [label, atom] of Object.entries(PADDINGS)) {
    test(`validateAggregateDmarcReport handles a report padded with ${label} in linear time`, async () => {
        const padding = atom.repeat(Math.round(10 * 1024 * 1024 / atom.length));
        const xml = [
            '<feedback>',
            '  <report_metadata></report_metadata>',
            '  <policy_published></policy_published>',
            '  <record></record>',
            `  ${padding}`,
            '</feedback>'
        ].join('\n');

        await withTempFile('padded.xml', xml, async (filePath) => {
            const startedAt = Date.now();
            const result = await validateAggregateDmarcReport({ filePath });
            const elapsedMs = Date.now() - startedAt;

            assert.equal(result.reportId, '');
            assert.ok(elapsedMs < 5000, `validation took ${elapsedMs}ms`);
        });
    });
}
