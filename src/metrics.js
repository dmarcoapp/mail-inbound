'use strict';

const { info } = require('./logger');

const counters = new Map();

function incrementMetric(name, value = 1) {
    const key = String(name || '').trim();
    if (!key) return;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return;
    counters.set(key, (counters.get(key) || 0) + amount);
}

function snapshotMetrics() {
    return Object.fromEntries(counters.entries());
}

function resetMetrics() {
    counters.clear();
}

function startMetricsLogger({ intervalMs = 60_000, logger = info } = {}) {
    const ms = Number(intervalMs);
    if (!Number.isFinite(ms) || ms <= 0) {
        return () => {};
    }

    const timer = setInterval(() => {
        logger('metrics', 'processor summary', snapshotMetrics());
    }, ms);

    timer.unref?.();
    return () => clearInterval(timer);
}

module.exports = {
    incrementMetric,
    snapshotMetrics,
    resetMetrics,
    startMetricsLogger
};
