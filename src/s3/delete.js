'use strict';

const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./client');
const { S3_BUCKET } = require('../config');

async function deleteFromS3({ key, bucket = S3_BUCKET }) {
    await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
    }));
}

module.exports = { deleteFromS3 };
