'use strict';

const { S3Client } = require('@aws-sdk/client-s3');
const {
    S3_REGION,
    S3_ENDPOINT,
    S3_FORCE_PATH_STYLE,
    S3_ACCESS_KEY,
    S3_SECRET_KEY
} = require('../config');

const s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: !!S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
});

module.exports = { s3 };
