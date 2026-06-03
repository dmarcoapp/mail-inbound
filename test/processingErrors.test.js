'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    permanentProcessingError,
    temporaryProcessingError,
    isPermanentProcessingError,
    isTemporaryProcessingError
} = require('../src/processingErrors');

test('processing error helpers classify correctly', () => {
    const permanent = permanentProcessingError('Permanent failure');
    const temporary = temporaryProcessingError('Temporary failure');

    assert.equal(permanent instanceof Error, true);
    assert.equal(permanent.name, 'PermanentProcessingError');
    assert.equal(permanent.kind, 'permanent');
    assert.equal(isPermanentProcessingError(permanent), true);
    assert.equal(isTemporaryProcessingError(permanent), false);

    assert.equal(temporary instanceof Error, true);
    assert.equal(temporary.name, 'TemporaryProcessingError');
    assert.equal(temporary.kind, 'temporary');
    assert.equal(isTemporaryProcessingError(temporary), true);
    assert.equal(isPermanentProcessingError(temporary), false);
});
