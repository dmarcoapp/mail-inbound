'use strict';

const crypto = require('crypto');

function randomId() {
    return crypto.randomUUID();
}

module.exports = { randomId };
