// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Range read test for smols3 - verifies correct HTTP Range request handling
 * under load.
 *
 * Purpose: Ensure range reads return exact byte slices, correct status codes,
 * and proper Content-Range headers across varied object sizes and access
 * patterns.
 * VUs: 15
 * Duration: ~7 minutes
 *
 * This test covers:
 * - Basic range reads (bytes=start-end) with data integrity checks
 * - Prefix reads (first N bytes)
 * - Suffix reads (bytes=-N, last N bytes)
 * - Sequential range scans covering an entire object
 * - Single-byte range reads
 * - Range reads on large objects
 *
 * ZERO tolerance for data corruption in range reads.
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
    createBucket,
    deleteBucket,
    putObject,
    getObject,
    getObjectRange,
    getObjectSuffix,
    deleteObject,
    listObjects,
    extractKeys,
    randomData,
    simpleChecksum,
    SIZES,
} from './lib/s3.js';

const integrityFailures = new Counter('integrity_failures');
const rangeReadOps = new Counter('range_read_ops');
const sequentialScanOps = new Counter('sequential_scan_ops');
const suffixReadOps = new Counter('suffix_read_ops');
const successRate = new Rate('success_rate');
const rangeLatency = new Trend('range_latency', true);

export const options = {
    thresholds: {
        integrity_failures: ['count<1'],
        http_req_failed: ['rate<0.01'],
        success_rate: ['rate>0.99'],
        range_latency: ['p(95)<500'],
    },
};

export function setup() {
    const buckets = [];

    for (let i = 0; i < 5; i++) {
        const name = `k6-range-${i}-${Date.now()}`;
        const res = createBucket(name);
        if (res.status === 200) {
            buckets.push(name);
        }
    }

    // Pre-populate each bucket with a known object for range reads. We use a
    // deterministic pattern so every VU can independently derive the expected
    // byte values without coordination.
    const seedData = buildPatternData(SIZES.LARGE);
    const seedChecksum = simpleChecksum(seedData);

    for (const bucket of buckets) {
        putObject(bucket, 'seed-large', seedData);
    }

    // Smaller seed for quick tests
    const smallSeed = buildPatternData(SIZES.MEDIUM);
    const smallChecksum = simpleChecksum(smallSeed);

    for (const bucket of buckets) {
        putObject(bucket, 'seed-medium', smallSeed);
    }

    return {
        buckets,
        seedSize: seedData.length,
        seedChecksum,
        smallSize: smallSeed.length,
        smallChecksum,
    };
}

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

    const testType = iter % 6;

    switch (testType) {
        case 0:
            testBasicRangeRead(bucket, vuId, iter);
            break;
        case 1:
            testPrefixRead(bucket, vuId, iter);
            break;
        case 2:
            testSuffixRead(bucket, vuId, iter);
            break;
        case 3:
            testSequentialScan(bucket, data.smallSize);
            break;
        case 4:
            testSingleByteReads(bucket, vuId, iter);
            break;
        case 5:
            testLargeRangeRead(bucket, data.seedSize);
            break;
    }

    sleep(0.1);
}

// Build a repeating pattern string of the given size. The pattern is
// deterministic so that any substring can be independently recomputed for
// verification.
function buildPatternData(size) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < size; i++) {
        result += alphabet[i % alphabet.length];
    }
    return result;
}

// Reconstruct expected bytes for the pattern data at [start, end] (inclusive).
function expectedSlice(start, endInclusive) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = start; i <= endInclusive; i++) {
        result += alphabet[i % alphabet.length];
    }
    return result;
}

// Test 1: Write an object, read a middle range, verify the bytes match.
function testBasicRangeRead(bucket, vuId, iter) {
    rangeReadOps.add(1);

    const key = `range/basic/vu${vuId}/iter${iter}`;
    const data = buildPatternData(SIZES.MEDIUM);

    const putRes = putObject(bucket, key, data);
    if (!check(putRes, { 'put for range': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read a range from the middle of the object
    const start = 100;
    const end = 511; // inclusive, so 412 bytes
    const startTs = Date.now();
    const rangeRes = getObjectRange(bucket, key, start, end);
    rangeLatency.add(Date.now() - startTs);

    if (!check(rangeRes, { 'range 206': (r) => r.status === 206 })) {
        integrityFailures.add(1);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    // Verify Content-Range header is present
    const contentRange = rangeRes.headers['Content-Range'];
    if (!check(rangeRes, {
        'has content-range': () => contentRange && contentRange.length > 0,
    })) {
        integrityFailures.add(1);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    // Verify returned bytes match the expected slice
    const expected = expectedSlice(start, end);
    const body = rangeRes.body;
    if (body !== expected) {
        integrityFailures.add(1);
        console.error(`RANGE INTEGRITY FAILURE: key=${key}, range=${start}-${end}, ` +
            `expected_len=${expected.length}, got_len=${body.length}`);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    // Verify body length
    if (!check(rangeRes, {
        'range length correct': (r) => r.body.length === (end - start + 1),
    })) {
        integrityFailures.add(1);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    successRate.add(true);
    deleteObject(bucket, key);
}

// Test 2: Read the first N bytes (prefix) of an object.
function testPrefixRead(bucket, vuId, iter) {
    rangeReadOps.add(1);

    const key = `range/prefix/vu${vuId}/iter${iter}`;
    const data = buildPatternData(SIZES.SMALL);

    const putRes = putObject(bucket, key, data);
    if (!check(putRes, { 'put for prefix': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read first 64 bytes
    const end = 63;
    const startTs = Date.now();
    const rangeRes = getObjectRange(bucket, key, 0, end);
    rangeLatency.add(Date.now() - startTs);

    if (!check(rangeRes, { 'prefix 206': (r) => r.status === 206 })) {
        integrityFailures.add(1);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    const expected = expectedSlice(0, end);
    if (rangeRes.body !== expected) {
        integrityFailures.add(1);
        console.error(`PREFIX INTEGRITY FAILURE: key=${key}`);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    successRate.add(true);
    deleteObject(bucket, key);
}

// Test 3: Read the last N bytes using suffix syntax (bytes=-N).
function testSuffixRead(bucket, vuId, iter) {
    suffixReadOps.add(1);

    const key = `range/suffix/vu${vuId}/iter${iter}`;
    const size = SIZES.SMALL;
    const data = buildPatternData(size);

    const putRes = putObject(bucket, key, data);
    if (!check(putRes, { 'put for suffix': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read last 128 bytes
    const suffixLen = 128;
    const startTs = Date.now();
    const rangeRes = getObjectSuffix(bucket, key, suffixLen);
    rangeLatency.add(Date.now() - startTs);

    if (!check(rangeRes, { 'suffix 206': (r) => r.status === 206 })) {
        integrityFailures.add(1);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    // The last suffixLen bytes of the pattern
    const expected = expectedSlice(size - suffixLen, size - 1);
    if (rangeRes.body !== expected) {
        integrityFailures.add(1);
        console.error(`SUFFIX INTEGRITY FAILURE: key=${key}, suffix=${suffixLen}`);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    if (!check(rangeRes, {
        'suffix length correct': (r) => r.body.length === suffixLen,
    })) {
        integrityFailures.add(1);
        successRate.add(false);
        deleteObject(bucket, key);
        return;
    }

    successRate.add(true);
    deleteObject(bucket, key);
}

// Test 4: Read an object in sequential non-overlapping chunks and reassemble.
// Verifies the concatenated ranges equal the full object.
function testSequentialScan(bucket, seedSize) {
    sequentialScanOps.add(1);

    const chunkSize = 4096;
    let assembled = '';
    let offset = 0;
    let failed = false;

    while (offset < seedSize) {
        const end = Math.min(offset + chunkSize - 1, seedSize - 1);
        const startTs = Date.now();
        const rangeRes = getObjectRange(bucket, 'seed-medium', offset, end);
        rangeLatency.add(Date.now() - startTs);

        if (!check(rangeRes, { 'scan chunk 206': (r) => r.status === 206 })) {
            integrityFailures.add(1);
            successRate.add(false);
            failed = true;
            break;
        }

        assembled += rangeRes.body;
        offset = end + 1;
    }

    if (failed) {
        return;
    }

    // Verify reassembled object matches expected full content
    const expectedFull = buildPatternData(seedSize);
    if (assembled !== expectedFull) {
        integrityFailures.add(1);
        console.error(`SEQUENTIAL SCAN INTEGRITY FAILURE: assembled_len=${assembled.length}, expected_len=${expectedFull.length}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);
}

// Test 5: Read individual bytes at specific offsets and verify each one.
function testSingleByteReads(bucket, vuId, iter) {
    rangeReadOps.add(1);

    const key = `range/singlebyte/vu${vuId}/iter${iter}`;
    const data = buildPatternData(SIZES.SMALL);

    const putRes = putObject(bucket, key, data);
    if (!check(putRes, { 'put for single-byte': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Read bytes at several offsets: first, middle, near-end
    const offsets = [0, 1, 61, 62, 500, SIZES.SMALL - 1];
    let failed = false;

    for (const off of offsets) {
        if (off >= data.length) continue;

        const startTs = Date.now();
        const rangeRes = getObjectRange(bucket, key, off, off);
        rangeLatency.add(Date.now() - startTs);

        if (!check(rangeRes, { [`byte@${off} 206`]: (r) => r.status === 206 })) {
            integrityFailures.add(1);
            failed = true;
            break;
        }

        const expected = expectedSlice(off, off);
        if (rangeRes.body !== expected) {
            integrityFailures.add(1);
            console.error(`SINGLE-BYTE INTEGRITY FAILURE: key=${key}, offset=${off}, ` +
                `expected='${expected}', got='${rangeRes.body}'`);
            failed = true;
            break;
        }

        if (!check(rangeRes, {
            [`byte@${off} length=1`]: (r) => r.body.length === 1,
        })) {
            integrityFailures.add(1);
            failed = true;
            break;
        }
    }

    successRate.add(!failed);
    deleteObject(bucket, key);
}

// Test 6: Range read on the pre-populated large (1MB) seed object.
function testLargeRangeRead(bucket, seedSize) {
    rangeReadOps.add(1);

    // Read a 64KB chunk from somewhere in the middle of the 1MB object
    const start = Math.floor(seedSize / 3);
    const end = start + SIZES.MEDIUM - 1;

    const startTs = Date.now();
    const rangeRes = getObjectRange(bucket, 'seed-large', start, end);
    rangeLatency.add(Date.now() - startTs);

    if (!check(rangeRes, { 'large range 206': (r) => r.status === 206 })) {
        integrityFailures.add(1);
        successRate.add(false);
        return;
    }

    if (!check(rangeRes, {
        'large range length': (r) => r.body.length === SIZES.MEDIUM,
    })) {
        integrityFailures.add(1);
        successRate.add(false);
        return;
    }

    // Verify the bytes match the expected pattern
    const expected = expectedSlice(start, end);
    if (rangeRes.body !== expected) {
        integrityFailures.add(1);
        console.error(`LARGE RANGE INTEGRITY FAILURE: start=${start}, end=${end}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);
}
