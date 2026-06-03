'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    incrementMetric,
    resetMetrics,
    snapshotMetrics,
    startMetricsLogger
} = require('../src/metrics');

test('metrics counters can be incremented and reset', () => {
    resetMetrics();

    incrementMetric('messages_accepted_total');
    incrementMetric('messages_accepted_total', 2);
    incrementMetric('');
    incrementMetric('ignored', Number.NaN);

    assert.deepEqual(snapshotMetrics(), {
        messages_accepted_total: 3
    });

    resetMetrics();
    assert.deepEqual(snapshotMetrics(), {});
});

test('metrics logger can be disabled', () => {
    const stop = startMetricsLogger({ intervalMs: 0 });
    assert.equal(typeof stop, 'function');
    stop();
});
