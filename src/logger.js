'use strict';

function toCauseMeta(err) {
    const cause = err?.cause;
    if (!cause) return {};

    return {
        causeError: String(cause?.message || cause || ''),
        causeName: cause?.name || '',
        causeKind: cause?.kind || '',
        causeCode: cause?.code || cause?.Code || '',
        causeStatusCode: cause?.$metadata?.httpStatusCode || cause?.statusCode || ''
    };
}

function log(level, scope, msg, meta = {}) {
    const line = `[${level}] [${scope}] [${new Date().toISOString()}] ${msg} ${JSON.stringify(meta)}`;
    if (level === 'ERROR') {
        console.error(line);
        return;
    }
    if (level === 'WARN') {
        console.warn(line);
        return;
    }
    console.log(line);
}

function info(scope, msg, meta = {}) {
    log('INFO', scope, msg, meta);
}

function warn(scope, msg, meta = {}) {
    log('WARN', scope, msg, meta);
}

function error(scope, msg, err, meta = {}) {
    log('ERROR', scope, msg, {
        ...meta,
        error: String(err?.message || err || ''),
        name: err?.name || '',
        kind: err?.kind || '',
        ...toCauseMeta(err)
    });
}

module.exports = {
    info,
    warn,
    error
};
