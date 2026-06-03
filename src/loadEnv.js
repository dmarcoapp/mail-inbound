'use strict';

const path = require('path');
const dotenv = require('dotenv');

let loaded = false;

function loadEnv() {
    if (loaded) return;
    loaded = true;

    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
}

module.exports = { loadEnv };
