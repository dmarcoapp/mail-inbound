'use strict';

class ProcessingError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ProcessingError';
        this.kind = options.kind || 'permanent';
        this.cause = options.cause;
    }
}

class PermanentProcessingError extends ProcessingError {
    constructor(message, options = {}) {
        super(message, { ...options, kind: 'permanent' });
        this.name = 'PermanentProcessingError';
    }
}

class TemporaryProcessingError extends ProcessingError {
    constructor(message, options = {}) {
        super(message, { ...options, kind: 'temporary' });
        this.name = 'TemporaryProcessingError';
    }
}

// Nothing is wrong with the message, but retrying cannot help either, because
// the backend refuses it for a reason only the operator can fix, such as a
// mismatched secret. The message goes straight to the dead-letter directory,
// where it waits to be replayed once that is fixed.
class DeadLetterProcessingError extends ProcessingError {
    constructor(message, options = {}) {
        super(message, { ...options, kind: 'dead-letter' });
        this.name = 'DeadLetterProcessingError';
    }
}

function permanentProcessingError(message, options = {}) {
    return new PermanentProcessingError(message, options);
}

function temporaryProcessingError(message, options = {}) {
    return new TemporaryProcessingError(message, options);
}

function isPermanentProcessingError(err) {
    return err instanceof PermanentProcessingError || err?.kind === 'permanent';
}

function isTemporaryProcessingError(err) {
    return err instanceof TemporaryProcessingError || err?.kind === 'temporary';
}

function isDeadLetterProcessingError(err) {
    return err instanceof DeadLetterProcessingError || err?.kind === 'dead-letter';
}

module.exports = {
    ProcessingError,
    PermanentProcessingError,
    TemporaryProcessingError,
    DeadLetterProcessingError,
    permanentProcessingError,
    temporaryProcessingError,
    isPermanentProcessingError,
    isTemporaryProcessingError,
    isDeadLetterProcessingError
};
