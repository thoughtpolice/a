// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke test for smols3 - quick validation of basic S3 operations.
 *
 * Purpose: Verify the server is functioning correctly with minimal load.
 * VUs: 1
 * Duration: 30s
 *
 * Operations tested:
 * - CreateBucket / DeleteBucket / HeadBucket / ListBuckets
 * - PutObject / GetObject / HeadObject / DeleteObject
 * - CopyObject / ListObjects
 */

import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
    createBucket,
    deleteBucket,
    headBucket,
    listBuckets,
    putObject,
    getObject,
    headObject,
    deleteObject,
    copyObject,
    listObjects,
    uniqueBucketName,
    uniqueKey,
    randomData,
    SIZES,
} from './lib/s3.js';

// Custom metrics
const operationErrors = new Counter('operation_errors');
const putLatency = new Trend('put_latency', true);
const getLatency = new Trend('get_latency', true);

// Thresholds for smoke test - very strict
export const options = {
    thresholds: {
        http_req_failed: ['rate<0.001'],        // <0.1% errors
        http_req_duration: ['p(99)<200'],       // p99 < 200ms
        operation_errors: ['count<1'],          // Zero operation errors
    },
};

export default function() {
    const bucketName = uniqueBucketName('smoke');

    // Create bucket
    let res = createBucket(bucketName);
    if (!check(res, { 'bucket created': (r) => r.status === 200 })) {
        operationErrors.add(1);
        return;
    }

    // Head bucket (verify exists)
    res = headBucket(bucketName);
    check(res, { 'bucket exists': (r) => r.status === 200 });

    // List buckets
    res = listBuckets();
    check(res, { 'list buckets': (r) => r.status === 200 });

    // Put object
    const key = uniqueKey('obj');
    const data = randomData(SIZES.SMALL);
    let start = Date.now();
    res = putObject(bucketName, key, data);
    putLatency.add(Date.now() - start);
    if (!check(res, { 'object put': (r) => r.status === 200 })) {
        operationErrors.add(1);
    }

    // Head object
    res = headObject(bucketName, key);
    check(res, { 'object head': (r) => r.status === 200 });

    // Get object
    start = Date.now();
    res = getObject(bucketName, key);
    getLatency.add(Date.now() - start);
    if (!check(res, { 'object get': (r) => r.status === 200 })) {
        operationErrors.add(1);
    }
    check(res, { 'data matches': (r) => r.body === data });

    // List objects
    res = listObjects(bucketName);
    check(res, { 'list objects': (r) => r.status === 200 });

    // Copy object - params: srcBucket, srcKey, dstBucket, dstKey
    const copyKey = uniqueKey('copy');
    res = copyObject(bucketName, key, bucketName, copyKey);
    check(res, { 'object copied': (r) => r.status === 200 });

    // Verify copy
    res = getObject(bucketName, copyKey);
    check(res, {
        'copy get': (r) => r.status === 200,
        'copy data matches': (r) => r.body === data,
    });

    // Delete objects
    res = deleteObject(bucketName, key);
    check(res, { 'object deleted': (r) => r.status === 204 });

    res = deleteObject(bucketName, copyKey);
    check(res, { 'copy deleted': (r) => r.status === 204 });

    // Delete bucket
    res = deleteBucket(bucketName);
    check(res, { 'bucket deleted': (r) => r.status === 204 });

    sleep(0.5);
}
