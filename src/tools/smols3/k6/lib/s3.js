// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared S3 client configuration and utilities for K6 load tests.
 *
 * Uses plain HTTP requests for compatibility with unauthenticated smols3.
 */

import http from 'k6/http';

// Get the endpoint URL
export const endpoint = __ENV.SMOLS3_ENDPOINT || 'http://localhost:8014';

// S3 operations via plain HTTP (no authentication required)

// Bucket operations
export function createBucket(bucketName) {
    return http.put(`${endpoint}/${bucketName}`, null, {
        headers: { 'Content-Type': 'application/xml' },
    });
}

export function deleteBucket(bucketName) {
    return http.del(`${endpoint}/${bucketName}`);
}

export function headBucket(bucketName) {
    return http.head(`${endpoint}/${bucketName}`);
}

export function listBuckets() {
    return http.get(`${endpoint}/`);
}

// Object operations
export function putObject(bucketName, key, data, contentType = 'application/octet-stream') {
    return http.put(`${endpoint}/${bucketName}/${key}`, data, {
        headers: { 'Content-Type': contentType },
    });
}

export function getObject(bucketName, key) {
    return http.get(`${endpoint}/${bucketName}/${key}`);
}

export function getObjectRange(bucketName, key, start, end) {
    return http.get(`${endpoint}/${bucketName}/${key}`, {
        headers: { 'Range': `bytes=${start}-${end}` },
    });
}

export function getObjectSuffix(bucketName, key, suffixLen) {
    return http.get(`${endpoint}/${bucketName}/${key}`, {
        headers: { 'Range': `bytes=-${suffixLen}` },
    });
}

export function headObject(bucketName, key) {
    return http.head(`${endpoint}/${bucketName}/${key}`);
}

export function deleteObject(bucketName, key) {
    return http.del(`${endpoint}/${bucketName}/${key}`);
}

export function copyObject(srcBucket, srcKey, dstBucket, dstKey) {
    return http.put(`${endpoint}/${dstBucket}/${dstKey}`, null, {
        headers: {
            'x-amz-copy-source': `/${srcBucket}/${srcKey}`,
        },
    });
}

export function listObjects(bucketName, prefix = '') {
    let url = `${endpoint}/${bucketName}?list-type=2`;
    if (prefix) {
        url += `&prefix=${encodeURIComponent(prefix)}`;
    }
    return http.get(url);
}

// Generate a unique bucket name with prefix
export function uniqueBucketName(prefix) {
    const suffix = Math.random().toString(36).substring(2, 10);
    return `${prefix}-${suffix}`;
}

// Generate a unique object key
export function uniqueKey(prefix) {
    const suffix = Math.random().toString(36).substring(2, 10);
    return `${prefix}-${suffix}`;
}

// Generate random data of specified size in bytes
export function randomData(sizeBytes) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < sizeBytes; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Generate random binary data as ArrayBuffer
export function randomBinaryData(sizeBytes) {
    const arr = new Uint8Array(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) {
        arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
}

// Compute a simple checksum for data integrity verification
export function simpleChecksum(data) {
    let hash = 0;
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
}

// Test bucket name for isolation (per-VU)
export function testBucketName(vuId) {
    return `k6-test-vu-${vuId}`;
}

// Extract keys from ListObjects XML response
export function extractKeys(xml) {
    const keys = [];
    const regex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
        keys.push(match[1]);
    }
    return keys;
}

// Size constants
export const KB = 1024;
export const MB = 1024 * KB;

// Common object sizes for testing
export const SIZES = {
    TINY: 100,           // 100 bytes
    SMALL: 1 * KB,       // 1 KB
    MEDIUM: 64 * KB,     // 64 KB
    LARGE: 1 * MB,       // 1 MB
    XLARGE: 5 * MB,      // 5 MB (for multipart)
};
