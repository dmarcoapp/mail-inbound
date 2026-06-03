'use strict';

const fs = require('fs');
const { SMTP_HOSTNAME } = require('../config');
const {
    PermanentProcessingError,
    TemporaryProcessingError
} = require('../processingErrors');

function firstAddress(addressObject) {
    if (!addressObject || !Array.isArray(addressObject.value) || addressObject.value.length === 0) {
        return '';
    }

    return String(addressObject.value[0]?.address || '').trim().toLowerCase();
}

function toDomain(address) {
    const current = String(address || '').trim().toLowerCase();
    const atIndex = current.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === current.length - 1) return '';
    return current.slice(atIndex + 1);
}

function normalizeStatus(value) {
    const current = String(value || '').trim().toLowerCase();
    return current || '';
}

function pickStatus(current) {
    if (!current) return '';
    if (typeof current === 'string') return current;
    if (typeof current?.result === 'string') return current.result;
    if (typeof current?.status?.result === 'string') return current.status.result;
    if (typeof current?.status === 'string') return current.status;
    return '';
}

function pickPolicy(current) {
    return normalizeStatus(
        current?.policy
        || current?.p
        || current?.record?.p
        || current?.rr?.p
        || current?.status?.policy
    );
}

function readHeaderResult(headers, label) {
    const pattern = new RegExp(`(?:^|;)\\s*${label}=([a-z_]+)`, 'i');
    const match = String(headers || '').match(pattern);
    return normalizeStatus(match ? match[1] : '');
}

function dkimStatuses(current, headers) {
    const statuses = [];

    if (Array.isArray(current?.results)) {
        for (const entry of current.results) {
            const status = normalizeStatus(pickStatus(entry));
            if (status) statuses.push(status);
        }
    }

    const headerStatus = readHeaderResult(headers, 'dkim');
    if (headerStatus) statuses.push(headerStatus);

    return statuses;
}

async function resolveDmarcPolicy(fromDomain, authDmarc) {
    const embedded = pickPolicy(authDmarc);
    if (embedded) return embedded;
    if (!fromDomain) return '';

    let getDmarcRecord = null;
    try {
        const loaded = require('mailauth/lib/dmarc/get-dmarc-record');
        getDmarcRecord = typeof loaded === 'function'
            ? loaded
            : (loaded?.default || loaded?.getDmarcRecord || null);
    } catch {
        getDmarcRecord = null;
    }

    if (typeof getDmarcRecord !== 'function') {
        return '';
    }

    try {
        const record = await getDmarcRecord(fromDomain);
        return pickPolicy(record);
    } catch (err) {
        throw new TemporaryProcessingError('Message deferred: DMARC policy lookup failed', { cause: err });
    }
}

async function validateMessageAuthentication(filePath, { parsed = null, delivery = {} } = {}) {
    let authenticate;
    try {
        ({ authenticate } = require('mailauth'));
    } catch (err) {
        throw new TemporaryProcessingError('Message deferred: authentication checks unavailable', { cause: err });
    }

    const fromAddress = firstAddress(parsed?.from);
    if (!fromAddress) {
        throw new PermanentProcessingError('Message rejected: missing From address');
    }

    const sender = String(delivery?.mailFrom || '').trim().toLowerCase() || fromAddress;
    const ip = String(delivery?.clientIp || '').trim();
    const helo = String(delivery?.helo || delivery?.clientName || '').trim();
    const trustReceived = !(ip && sender);

    let auth;
    try {
        auth = await authenticate(fs.createReadStream(filePath), {
            sender: sender || undefined,
            ip: ip || undefined,
            helo: helo || undefined,
            trustReceived,
            disableArc: true,
            mta: SMTP_HOSTNAME || undefined
        });
    } catch (err) {
        throw new TemporaryProcessingError('Message deferred: authentication checks unavailable', { cause: err });
    }

    const headers = String(auth?.headers || '');
    const spf = normalizeStatus(pickStatus(auth?.spf) || readHeaderResult(headers, 'spf')) || 'none';
    const dmarc = normalizeStatus(pickStatus(auth?.dmarc) || readHeaderResult(headers, 'dmarc')) || 'none';
    const dkimResults = dkimStatuses(auth?.dkim, headers);
    const dkimPass = dkimResults.includes('pass');
    const dkim = dkimPass ? 'pass' : (dkimResults[0] || 'none');
    const dmarcPolicy = await resolveDmarcPolicy(toDomain(fromAddress), auth?.dmarc);

    if (spf === 'temperror' || dmarc === 'temperror' || dkimResults.includes('temperror')) {
        throw new TemporaryProcessingError('Message deferred: authentication checks temporary failure');
    }

    if (dmarc === 'fail' && (dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine')) {
        throw new PermanentProcessingError(`Message rejected: DMARC policy ${dmarcPolicy} failed`);
    }

    return {
        spf,
        dkim,
        dmarc,
        dmarcPolicy: dmarcPolicy || 'none'
    };
}

module.exports = {
    validateMessageAuthentication
};
