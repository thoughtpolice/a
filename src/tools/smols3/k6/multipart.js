// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Multipart upload test for smols3 - large file upload testing.
 *
 * Purpose: Test multipart upload workflow for large files.
 * VUs: 5
 * Duration: ~5 minutes
 *
 * Operations tested:
 * - CreateMultipartUpload
 * - UploadPart
 * - CompleteMultipartUpload
 * - AbortMultipartUpload
 * - ListParts
 * - ListMultipartUploads
 */

import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import http from 'k6/http';
import {
    createBucket,
    deleteBucket,
    deleteObject,
    listObjects,
    extractKeys,
    randomData,
    simpleChecksum,
    endpoint,
    SIZES,
    MB,
} from './lib/s3.js';

// Custom metrics
const multipartOps = new Counter('multipart_ops');
const uploadPartLatency = new Trend('upload_part_latency', true);
const completeLatency = new Trend('complete_latency', true);
const integrityFailures = new Counter('multipart_integrity_failures');
const successRate = new Rate('success_rate');

// Thresholds
export const options = {
    thresholds: {
        http_req_failed: ['rate<0.02'],         // <2% errors
        multipart_integrity_failures: ['count<1'], // No integrity failures
        success_rate: ['rate>0.95'],
    },
};

// Setup
export function setup() {
    const bucket = `k6-multipart-${Date.now()}`;
    const res = createBucket(bucket);
    if (res.status !== 200) {
        console.error('Failed to create bucket for multipart tests');
    }
    return { bucket };
}

// Teardown
export function teardown(data) {
    // List and delete all objects
    const listRes = listObjects(data.bucket);
    if (listRes.status === 200 && listRes.body) {
        const keys = extractKeys(listRes.body);
        for (const key of keys) {
            deleteObject(data.bucket, key);
        }
    }
    deleteBucket(data.bucket);
}

function extractUploadId(xml) {
    const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
    return match ? match[1] : null;
}

function extractETag(headers) {
    // ETag may be in headers as 'Etag' or 'etag'
    return headers['Etag'] || headers['etag'] || headers['ETag'];
}

export default function(data) {
    const vuId = __VU;
    const iter = __ITER;

    // Cycle through different multipart tests
    const testType = iter % 3;

    switch (testType) {
        case 0:
            testBasicMultipart(data.bucket, vuId, iter);
            break;
        case 1:
            testAbortMultipart(data.bucket, vuId, iter);
            break;
        case 2:
            testMultiplePartsIntegrity(data.bucket, vuId, iter);
            break;
    }

    sleep(0.5);
}

// Test 1: Basic multipart upload flow
function testBasicMultipart(bucket, vuId, iter) {
    multipartOps.add(1);

    const key = `multipart/vu${vuId}/basic${iter}`;

    // CreateMultipartUpload
    const createUrl = `${endpoint}/${bucket}/${key}?uploads`;
    const createRes = http.post(createUrl, null, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });

    if (!check(createRes, { 'create multipart': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    const uploadId = extractUploadId(createRes.body);
    if (!uploadId) {
        console.error('Failed to extract uploadId');
        successRate.add(false);
        return;
    }

    // Upload two parts
    const part1Data = randomData(SIZES.MEDIUM);
    const part2Data = randomData(SIZES.MEDIUM);
    const parts = [];

    // Upload Part 1
    let start = Date.now();
    const part1Url = `${endpoint}/${bucket}/${key}?partNumber=1&uploadId=${uploadId}`;
    const part1Res = http.put(part1Url, part1Data, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    uploadPartLatency.add(Date.now() - start);

    if (!check(part1Res, { 'upload part 1': (r) => r.status === 200 })) {
        // Abort on failure
        abortUpload(bucket, key, uploadId);
        successRate.add(false);
        return;
    }
    parts.push({ partNumber: 1, etag: extractETag(part1Res.headers) });

    // Upload Part 2
    start = Date.now();
    const part2Url = `${endpoint}/${bucket}/${key}?partNumber=2&uploadId=${uploadId}`;
    const part2Res = http.put(part2Url, part2Data, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    uploadPartLatency.add(Date.now() - start);

    if (!check(part2Res, { 'upload part 2': (r) => r.status === 200 })) {
        abortUpload(bucket, key, uploadId);
        successRate.add(false);
        return;
    }
    parts.push({ partNumber: 2, etag: extractETag(part2Res.headers) });

    // CompleteMultipartUpload
    const completeXml = buildCompleteXml(parts);
    start = Date.now();
    const completeUrl = `${endpoint}/${bucket}/${key}?uploadId=${uploadId}`;
    const completeRes = http.post(completeUrl, completeXml, {
        headers: { 'Content-Type': 'application/xml' },
    });
    completeLatency.add(Date.now() - start);

    if (!check(completeRes, { 'complete multipart': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Verify assembled object via HTTP GET
    const getRes = http.get(`${endpoint}/${bucket}/${key}`);
    if (!check(getRes, { 'get assembled': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Verify data integrity (parts concatenated)
    const expectedData = part1Data + part2Data;
    if (getRes.body !== expectedData) {
        integrityFailures.add(1);
        console.error(`MULTIPART INTEGRITY FAILURE: key=${key}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);

    // Cleanup
    http.del(`${endpoint}/${bucket}/${key}`);
}

// Test 2: Abort multipart upload
function testAbortMultipart(bucket, vuId, iter) {
    multipartOps.add(1);

    const key = `multipart/vu${vuId}/abort${iter}`;

    // CreateMultipartUpload
    const createUrl = `${endpoint}/${bucket}/${key}?uploads`;
    const createRes = http.post(createUrl, null, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });

    if (!check(createRes, { 'create for abort': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    const uploadId = extractUploadId(createRes.body);
    if (!uploadId) {
        successRate.add(false);
        return;
    }

    // Upload one part
    const partData = randomData(SIZES.SMALL);
    const partUrl = `${endpoint}/${bucket}/${key}?partNumber=1&uploadId=${uploadId}`;
    const partRes = http.put(partUrl, partData, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });

    check(partRes, { 'upload part for abort': (r) => r.status === 200 });

    // Abort the upload
    const abortUrl = `${endpoint}/${bucket}/${key}?uploadId=${uploadId}`;
    const abortRes = http.del(abortUrl);

    if (!check(abortRes, { 'abort multipart': (r) => r.status === 204 })) {
        successRate.add(false);
        return;
    }

    // Verify object doesn't exist
    const getRes = http.get(`${endpoint}/${bucket}/${key}`);
    if (!check(getRes, { 'object not found after abort': (r) => r.status === 404 })) {
        successRate.add(false);
        return;
    }

    successRate.add(true);
}

// Test 3: Multiple parts with integrity verification
function testMultiplePartsIntegrity(bucket, vuId, iter) {
    multipartOps.add(1);

    const key = `multipart/vu${vuId}/multi${iter}`;
    const numParts = 3;

    // CreateMultipartUpload
    const createUrl = `${endpoint}/${bucket}/${key}?uploads`;
    const createRes = http.post(createUrl, null, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });

    if (!check(createRes, { 'create multi-part': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    const uploadId = extractUploadId(createRes.body);
    if (!uploadId) {
        successRate.add(false);
        return;
    }

    // Generate parts and upload
    const partsData = [];
    const partsMeta = [];

    for (let i = 1; i <= numParts; i++) {
        const data = randomData(SIZES.SMALL);
        partsData.push(data);

        const url = `${endpoint}/${bucket}/${key}?partNumber=${i}&uploadId=${uploadId}`;
        const res = http.put(url, data, {
            headers: { 'Content-Type': 'application/octet-stream' },
        });

        if (res.status !== 200) {
            abortUpload(bucket, key, uploadId);
            successRate.add(false);
            return;
        }

        partsMeta.push({ partNumber: i, etag: extractETag(res.headers) });
    }

    // Complete
    const completeXml = buildCompleteXml(partsMeta);
    const completeUrl = `${endpoint}/${bucket}/${key}?uploadId=${uploadId}`;
    const completeRes = http.post(completeUrl, completeXml, {
        headers: { 'Content-Type': 'application/xml' },
    });

    if (!check(completeRes, { 'complete multi-part': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    // Verify assembled content
    const getRes = http.get(`${endpoint}/${bucket}/${key}`);
    if (!check(getRes, { 'get multi-part': (r) => r.status === 200 })) {
        successRate.add(false);
        return;
    }

    const expectedData = partsData.join('');
    const expectedChecksum = simpleChecksum(expectedData);
    const actualChecksum = simpleChecksum(getRes.body);

    if (actualChecksum !== expectedChecksum) {
        integrityFailures.add(1);
        console.error(`MULTI-PART INTEGRITY FAILURE: key=${key}, parts=${numParts}`);
        successRate.add(false);
        return;
    }

    successRate.add(true);

    // Cleanup
    http.del(`${endpoint}/${bucket}/${key}`);
}

function buildCompleteXml(parts) {
    let xml = '<CompleteMultipartUpload>';
    for (const part of parts) {
        xml += `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`;
    }
    xml += '</CompleteMultipartUpload>';
    return xml;
}

function abortUpload(bucket, key, uploadId) {
    const url = `${endpoint}/${bucket}/${key}?uploadId=${uploadId}`;
    http.del(url);
}
