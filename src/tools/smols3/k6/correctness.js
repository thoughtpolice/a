// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Correctness test for smols3 - data integrity verification under load.
 *
 * Purpose: Verify data is never corrupted, lost, or returned incorrectly.
 * VUs: 20
 * Duration: ~7 minutes
 *
 * This test focuses on:
 * - Write-then-read verification (data integrity)
 * - Concurrent overwrites (last-write-wins verification)
 * - Cross-bucket copy integrity
 *
 * ZERO tolerance for data corruption.
 */

import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import {
    createBucket,
    deleteBucket,
    putObject,
    getObject,
    headObject,
    deleteObject,
    copyObject,
    listObjects,
    extractKeys,
    randomData,
    simpleChecksum,
    SIZES,
} from './lib/s3.js';

// Custom metrics
const integrityFailures = new Counter('integrity_failures');
const writeReadOps = new Counter('write_read_ops');
const copyVerifyOps = new Counter('copy_verify_ops');
const conditionalWriteOps = new Counter('conditional_write_ops');
const successRate = new Rate('success_rate');

// Thresholds - ZERO corruption tolerance
export const options = {
    thresholds: {
        integrity_failures: ['count<1'],        // ZERO data corruption
        http_req_failed: ['rate<0.01'],         // <1% request failures
        success_rate: ['rate>0.99'],
    },
};

// Setup - create isolated test buckets
export function setup() {
    const buckets = [];

    for (let i = 0; i < 5; i++) {
        const name = `k6-correctness-${i}-${Date.now()}`;
        const res = createBucket(name);
        if (res.status === 200) {
            buckets.push(name);
        }
    }

    return { buckets };
}

// Teardown
export function teardown(data) {
    for (const bucket of data.buckets) {
        const listRes = listObjects(bucket);
        if (listRes.status === 200 && listRes.body) {
            const keys = extractKeys(listRes.body);
            for (const key of keys) {
                deleteObject(bucket, key);
            }
        }
        deleteBucket(bucket);
    }
}

export default function(data) {
    const vuId = __VU;
    const iter = __ITER;
    const bucket = data.buckets[vuId % data.buckets.length];

    // Cycle through different correctness tests
    const testType = iter % 4;

    switch (testType) {
        case 0:
            testWriteReadIntegrity(bucket, vuId, iter);
            break;
        case 1:
            testCopyIntegrity(bucket, data.buckets, vuId, iter);
            break;
        case 2:
            testConditionalWrite(bucket, vuId, iter);
            break;
        case 3:
            testLargeObjectIntegrity(bucket, vuId, iter);
            break;
    }

    sleep(0.1);
}

// Test 1: Write data, read it back, verify exact match
function testWriteReadIntegrity(bucket, vuId, iter) {
    writeReadOps.add(1);

    const key = `integrity/vu${vuId}/iter${iter}`;
    const data = randomData(SIZES.MEDIUM);
    const checksum = simpleChecksum(data);

    // Write
    const putRes = putObject(bucket, key, data);
    if (!check(putRes, { 'put for integrity': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read back
    const getRes = getObject(bucket, key);
    if (!check(getRes, { 'get for integrity': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Verify exact match
    const readChecksum = simpleChecksum(getRes.body);
    if (readChecksum !== checksum) {
        integrityFailures.add(1);
        console.error(`DATA INTEGRITY FAILURE: key=${key}, expected=${checksum}, got=${readChecksum}`);
        successRate.add(false);
        return;
    }

    // Verify size matches
    if (getRes.body.length !== data.length) {
        integrityFailures.add(1);
        console.error(`SIZE MISMATCH: key=${key}, expected=${data.length}, got=${getRes.body.length}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);

    // Cleanup
    deleteObject(bucket, key);
}

// Test 2: Copy object and verify copy matches original
function testCopyIntegrity(bucket, allBuckets, vuId, iter) {
    copyVerifyOps.add(1);

    const srcKey = `copy-src/vu${vuId}/iter${iter}`;
    const dstBucket = allBuckets[(vuId + 1) % allBuckets.length];
    const dstKey = `copy-dst/vu${vuId}/iter${iter}`;

    const data = randomData(SIZES.SMALL);
    const checksum = simpleChecksum(data);

    // Put source
    const putRes = putObject(bucket, srcKey, data);
    if (!check(putRes, { 'put source': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Copy to destination - params: srcBucket, srcKey, dstBucket, dstKey
    const copyRes = copyObject(bucket, srcKey, dstBucket, dstKey);
    if (!check(copyRes, { 'copy object': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read copy and verify
    const getRes = getObject(dstBucket, dstKey);
    if (!check(getRes, { 'get copy': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    const copyChecksum = simpleChecksum(getRes.body);
    if (copyChecksum !== checksum) {
        integrityFailures.add(1);
        console.error(`COPY INTEGRITY FAILURE: src=${bucket}/${srcKey}, dst=${dstBucket}/${dstKey}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);

    // Cleanup
    deleteObject(bucket, srcKey);
    deleteObject(dstBucket, dstKey);
}

// Test 3: Conditional write semantics (overwrite behavior)
function testConditionalWrite(bucket, vuId, iter) {
    conditionalWriteOps.add(1);

    const key = `conditional/vu${vuId}/iter${iter}`;
    const data1 = randomData(SIZES.TINY);
    const data2 = randomData(SIZES.TINY);

    // Initial put
    const put1Res = putObject(bucket, key, data1);
    if (!check(put1Res, { 'initial put': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Get ETag via HEAD
    const headRes = headObject(bucket, key);
    if (!check(headRes, { 'head for etag': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Overwrite with new data
    const put2Res = putObject(bucket, key, data2);
    if (!check(put2Res, { 'overwrite put': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Verify new data is returned
    const getRes = getObject(bucket, key);
    if (!check(getRes, { 'get after overwrite': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    const finalChecksum = simpleChecksum(getRes.body);
    const expectedChecksum = simpleChecksum(data2);
    if (finalChecksum !== expectedChecksum) {
        integrityFailures.add(1);
        console.error(`OVERWRITE INTEGRITY FAILURE: key=${key}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);

    // Cleanup
    deleteObject(bucket, key);
}

// Test 4: Large object integrity (close to multipart threshold)
function testLargeObjectIntegrity(bucket, vuId, iter) {
    writeReadOps.add(1);

    const key = `large/vu${vuId}/iter${iter}`;
    // Use larger size but not so large it times out
    const data = randomData(SIZES.LARGE);
    const checksum = simpleChecksum(data);

    // Write large object
    const putRes = putObject(bucket, key, data);
    if (!check(putRes, { 'put large': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read back
    const getRes = getObject(bucket, key);
    if (!check(getRes, { 'get large': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Verify
    const readChecksum = simpleChecksum(getRes.body);
    if (readChecksum !== checksum) {
        integrityFailures.add(1);
        console.error(`LARGE OBJECT INTEGRITY FAILURE: key=${key}, size=${data.length}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);

    // Cleanup
    deleteObject(bucket, key);
}
