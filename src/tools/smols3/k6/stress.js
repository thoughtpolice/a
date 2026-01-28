// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Stress test for smols3 - push to find breaking points.
 *
 * Purpose: Identify performance limits and failure thresholds.
 * VUs: 50-150 (progressive ramp)
 * Duration: ~17 minutes
 *
 * This test intentionally pushes beyond normal limits to find:
 * - Maximum throughput
 * - Latency degradation points
 * - Error rate thresholds
 * - Resource exhaustion patterns
 */

import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import {
    createBucket,
    deleteBucket,
    putObject,
    getObject,
    deleteObject,
    listObjects,
    extractKeys,
    randomData,
    SIZES,
} from './lib/s3.js';

// Custom metrics
const operationErrors = new Counter('operation_errors');
const putLatency = new Trend('put_latency', true);
const getLatency = new Trend('get_latency', true);
const successRate = new Rate('success_rate');
const concurrentOps = new Gauge('concurrent_ops');

// Thresholds for stress test - more lenient (finding limits)
export const options = {
    thresholds: {
        http_req_failed: ['rate<0.05'],         // <5% errors (stress test)
        http_req_duration: ['p(95)<2000'],      // p95 < 2s under stress
    },
};

// Setup - create test buckets across shards
export function setup() {
    const buckets = [];

    // More buckets for stress test to distribute load
    for (let i = 0; i < 10; i++) {
        const name = `k6-stress-${i}-${Date.now()}`;
        const res = createBucket(name);
        if (res.status === 200) {
            buckets.push(name);
        }
    }

    return { buckets, startTime: Date.now() };
}

// Teardown - clean up
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

// Per-VU object tracking
const vuObjects = {};

export default function(data) {
    const vuId = __VU;
    const iter = __ITER;
    const bucket = data.buckets[vuId % data.buckets.length];

    if (!vuObjects[vuId]) {
        vuObjects[vuId] = [];
    }

    concurrentOps.add(1);

    // Under stress, focus on write-heavy workload to stress the system
    // 60% PUT, 30% GET, 10% LIST
    const op = selectOperation();
    let success = false;
    let start = Date.now();

    switch (op) {
        case 'PUT':
            success = doStressPut(bucket, vuId, iter);
            putLatency.add(Date.now() - start);
            break;
        case 'GET':
            success = doStressGet(bucket, vuId);
            getLatency.add(Date.now() - start);
            break;
        case 'LIST':
            success = doStressList(bucket);
            break;
    }

    successRate.add(success);
    if (!success) {
        operationErrors.add(1);
    }

    // Minimal sleep under stress
    sleep(0.01);
}

function selectOperation() {
    const r = Math.random() * 100;
    if (r < 60) return 'PUT';
    if (r < 90) return 'GET';
    return 'LIST';
}

function doStressPut(bucket, vuId, iter) {
    const key = `vu${vuId}/iter${iter}/${Date.now()}`;

    // Under stress, use varied sizes to test different code paths
    const sizeChoice = Math.random();
    let size = SIZES.TINY;
    if (sizeChoice > 0.95) size = SIZES.LARGE;
    else if (sizeChoice > 0.8) size = SIZES.MEDIUM;
    else if (sizeChoice > 0.5) size = SIZES.SMALL;

    const body = randomData(size);
    const res = putObject(bucket, key, body);

    if (res.status === 200) {
        vuObjects[vuId].push(key);
        // Aggressive cleanup to avoid memory pressure
        if (vuObjects[vuId].length > 50) {
            vuObjects[vuId].shift();
        }
        return true;
    }
    return false;
}

function doStressGet(bucket, vuId) {
    const objects = vuObjects[vuId] || [];
    if (objects.length === 0) {
        return true; // No objects yet, skip
    }

    const key = objects[Math.floor(Math.random() * objects.length)];
    const res = getObject(bucket, key);
    // 404 is acceptable if object was deleted by another test
    return res.status === 200 || res.status === 404;
}

function doStressList(bucket) {
    const res = listObjects(bucket);
    return res.status === 200;
}
