'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runMessageProcessorInChild } = require('../src/processor/runIsolated');

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.killSignals = [];
    }

    send(payload) {
        this.sentPayload = payload;
        if (typeof this.onSend === 'function') {
            this.onSend(payload);
        }
    }

    kill(signal) {
        this.killSignals.push(signal);
        if (typeof this.onKill === 'function') {
            this.onKill(signal);
        }
        return true;
    }
}

test('runMessageProcessorInChild resolves on successful child result', async () => {
    const child = new FakeChild();
    child.onSend = () => {
        setImmediate(() => child.emit('message', { ok: true }));
    };

    await runMessageProcessorInChild(
        '/tmp/message.eml',
        {
            envelopeRecipients: ['reports@example.test'],
            delivery: {
                recipient: 'reports@example.test',
                clientIp: '203.0.113.10'
            }
        },
        { forkImpl: () => child }
    );

    assert.equal(child.sentPayload.filePath, '/tmp/message.eml');
    assert.deepEqual(child.sentPayload.envelopeRecipients, ['reports@example.test']);
    assert.equal(child.sentPayload.delivery.clientIp, '203.0.113.10');
});

test('runMessageProcessorInChild maps permanent child failures to permanent processing errors', async () => {
    const child = new FakeChild();
    child.onSend = () => {
        setImmediate(() => child.emit('message', {
            ok: false,
            kind: 'permanent',
            message: 'Message rejected'
        }));
    };

    await assert.rejects(
        () => runMessageProcessorInChild('/tmp/message.eml', {}, { forkImpl: () => child }),
        (err) => err?.name === 'PermanentProcessingError' && err?.kind === 'permanent'
    );
});

test('runMessageProcessorInChild treats unexpected child exit as temporary failure', async () => {
    const child = new FakeChild();
    child.onSend = () => {
        setImmediate(() => child.emit('exit', 1, null));
    };

    await assert.rejects(
        () => runMessageProcessorInChild('/tmp/message.eml', {}, { forkImpl: () => child }),
        (err) => err?.name === 'TemporaryProcessingError'
            && err?.kind === 'temporary'
            && /exited unexpectedly/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild times out and escalates child termination', async () => {
    const child = new FakeChild();
    child.onKill = (signal) => {
        if (signal === 'SIGKILL') {
            setImmediate(() => child.emit('exit', null, 'SIGKILL'));
        }
    };

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 5
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && err?.kind === 'temporary'
            && /timed out/.test(String(err?.message || ''))
    );

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
});

test('runMessageProcessorInChild maps fork startup exceptions to temporary failure', async () => {
    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => {
                    throw new Error('fork-fail');
                }
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /failed to start/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild handles child error events before completion', async () => {
    const child = new FakeChild();
    child.onSend = () => {
        setImmediate(() => child.emit('error', new Error('child-start-fail')));
    };

    await assert.rejects(
        () => runMessageProcessorInChild('/tmp/message.eml', {}, { forkImpl: () => child }),
        (err) => err?.name === 'TemporaryProcessingError'
            && /failed to start/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild rejects immediately when timed out child cannot be terminated', async () => {
    const child = new FakeChild();
    child.kill = () => false;

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 5
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /timed out/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild rejects when timed out child has no kill method', async () => {
    const child = new EventEmitter();
    child.send = () => {};

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 5
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /timed out/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild treats kill exceptions as timeout failure', async () => {
    const child = new FakeChild();
    child.kill = () => {
        throw new Error('kill-failed');
    };

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 5
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /timed out/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild preserves timeout error when child emits error after timeout', async () => {
    const child = new FakeChild();
    child.onKill = (signal) => {
        if (signal === 'SIGTERM') {
            setImmediate(() => child.emit('error', new Error('late-startup-fail')));
        }
    };

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 50
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /timed out/.test(String(err?.message || ''))
    );
});

test('runMessageProcessorInChild rejects when SIGKILL escalation cannot terminate child', async () => {
    const child = new FakeChild();
    child.kill = (signal) => {
        child.killSignals.push(signal);
        return signal === 'SIGTERM';
    };

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 5
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /timed out/.test(String(err?.message || ''))
    );

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
});

test('runMessageProcessorInChild handles immediate SIGKILL mode when grace is disabled', async () => {
    const child = new FakeChild();
    child.kill = (signal) => {
        child.killSignals.push(signal);
        return signal === 'SIGTERM';
    };

    await assert.rejects(
        () => runMessageProcessorInChild(
            '/tmp/message.eml',
            {},
            {
                forkImpl: () => child,
                timeoutMs: 5,
                killGraceMs: 0
            }
        ),
        (err) => err?.name === 'TemporaryProcessingError'
            && /timed out/.test(String(err?.message || ''))
    );

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
});
