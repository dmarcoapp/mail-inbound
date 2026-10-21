'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DeadLetterProcessingError,
    permanentProcessingError,
    temporaryProcessingError,
    isPermanentProcessingError,
    isTemporaryProcessingError,
    isDeadLetterProcessingError
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

    const deadLetter = new DeadLetterProcessingError('Refused by the backend');
    assert.equal(deadLetter instanceof Error, true);
    assert.equal(deadLetter.name, 'DeadLetterProcessingError');
    assert.equal(deadLetter.kind, 'dead-letter');
    assert.equal(isDeadLetterProcessingError(deadLetter), true);
    assert.equal(isDeadLetterProcessingError({ kind: 'dead-letter' }), true);
    assert.equal(isPermanentProcessingError(deadLetter), false);
    assert.equal(isTemporaryProcessingError(deadLetter), false);
    assert.equal(isDeadLetterProcessingError(permanent), false);
});
