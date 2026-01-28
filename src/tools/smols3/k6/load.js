// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Load test for smols3 - sustained production-like workload.
 *
 * Purpose: Test the server under typical production load patterns.
 * VUs: 10-20
 * Duration: ~14 minutes (ramp up, sustain, ramp down)
 *
 * Workload distribution (simulating realistic S3 usage):
 * - 50% GET operations (reads dominate)
 * - 30% PUT operations
 * - 10% LIST operations
 * - 5% HEAD operations
 * - 5% DELETE operations
 */

import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import {
    createBucket,
    deleteBucket,
    putObject,
    getObject,
    headObject,
    deleteObject,
    listObjects,
    extractKeys,
    uniqueKey,
    randomData,
    SIZES,
} from './lib/s3.js';

// Custom metrics
const operationErrors = new Counter('operation_errors');
const putLatency = new Trend('put_latency', true);
const getLatency = new Trend('get_latency', true);
const listLatency = new Trend('list_latency', true);
const successRate = new Rate('success_rate');

// Thresholds for load test
export const options = {
    thresholds: {
        http_req_failed: ['rate<0.01'],         // <1% errors
        http_req_duration: ['p(95)<500'],       // p95 < 500ms
        success_rate: ['rate>0.99'],            // >99% success
    },
};

// Setup function - create test buckets
export function setup() {
    const buckets = [];

    // Create a few shared buckets for the test
    for (let i = 0; i < 5; i++) {
        const name = `k6-load-${i}-${Date.now()}`;
        const res = createBucket(name);
        if (res.status === 200) {
            buckets.push(name);
        }
    }

    return { buckets };
}

// Teardown function - clean up test buckets
export function teardown(data) {
    for (const bucket of data.buckets) {
        // List and delete all objects
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

// Track objects per VU for get/delete operations
const vuObjects = {};

export default function(data) {
    const vuId = __VU;
    const bucket = data.buckets[vuId % data.buckets.length];

    // Initialize VU object tracking
    if (!vuObjects[vuId]) {
        vuObjects[vuId] = [];
    }

    // Weighted random operation selection
    const op = selectOperation();
    let success = false;
    let start = Date.now();

    switch (op) {
        case 'PUT':
            success = doPut(bucket, vuId);
            putLatency.add(Date.now() - start);
            break;
        case 'GET':
            success = doGet(bucket, vuId);
            getLatency.add(Date.now() - start);
            break;
        case 'LIST':
            success = doList(bucket);
            listLatency.add(Date.now() - start);
            break;
        case 'HEAD':
            success = doHead(bucket, vuId);
            break;
        case 'DELETE':
            success = doDelete(bucket, vuId);
            break;
    }

    successRate.add(success);
    if (!success) {
        operationErrors.add(1);
    }

    // Small pause between operations
    sleep(0.1 + Math.random() * 0.2);
}

function selectOperation() {
    const r = Math.random() * 100;
    if (r < 50) return 'GET';
    if (r < 80) return 'PUT';
    if (r < 90) return 'LIST';
    if (r < 95) return 'HEAD';
    return 'DELETE';
}

function doPut(bucket, vuId) {
    const key = uniqueKey(`vu${vuId}`);
    // Vary object sizes
    const sizeChoice = Math.random();
    let size = SIZES.SMALL;
    if (sizeChoice > 0.9) size = SIZES.LARGE;
    else if (sizeChoice > 0.6) size = SIZES.MEDIUM;

    const data = randomData(size);
    const res = putObject(bucket, key, data);

    if (check(res, { 'put success': (r) => r.status === 200 })) {
        // Track object for later get/delete
        vuObjects[vuId].push(key);
        // Keep list manageable
        if (vuObjects[vuId].length > 100) {
            vuObjects[vuId].shift();
        }
        return true;
    }
    return false;
}

function doGet(bucket, vuId) {
    const objects = vuObjects[vuId] || [];
    if (objects.length === 0) {
        // No objects yet, do a put instead
        return doPut(bucket, vuId);
    }

    const key = objects[Math.floor(Math.random() * objects.length)];
    const res = getObject(bucket, key);
    return check(res, { 'get success': (r) => r.status === 200 || r.status === 404 });
}

function doList(bucket) {
    const res = listObjects(bucket);
    return check(res, { 'list success': (r) => r.status === 200 });
}

function doHead(bucket, vuId) {
    const objects = vuObjects[vuId] || [];
    if (objects.length === 0) {
        return true; // Skip if no objects
    }

    const key = objects[Math.floor(Math.random() * objects.length)];
    const res = headObject(bucket, key);
    return check(res, { 'head success': (r) => r.status === 200 || r.status === 404 });
}

function doDelete(bucket, vuId) {
    const objects = vuObjects[vuId] || [];
    if (objects.length === 0) {
        return true; // Skip if no objects
    }

    const idx = Math.floor(Math.random() * objects.length);
    const key = objects[idx];
    const res = deleteObject(bucket, key);

    if (check(res, { 'delete success': (r) => r.status === 204 })) {
        objects.splice(idx, 1);
        return true;
    }
    return false;
}
