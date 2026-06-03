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

module.exports = {
    ProcessingError,
    PermanentProcessingError,
    TemporaryProcessingError,
    permanentProcessingError,
    temporaryProcessingError,
    isPermanentProcessingError,
    isTemporaryProcessingError
};
