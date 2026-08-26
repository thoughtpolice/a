// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Immutable, bounded JSON on R2. Addresses hash exact bytes, not reconstructed
 * objects or tdutil's inner digest. Conditional puts and verified reads protect
 * the evidence used by replayed Workflow steps. @module
 */
import type { ArtifactRef } from "../model.ts";
/** Bound buffering in the local prototype and celld R2 implementation. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** SHA-256 lowercase hexadecimal of exact bytes. */
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Reject inconsistent addresses and arbitrary R2 keys. */
export function artifactRef(value: unknown): ArtifactRef {
  const ref = value as ArtifactRef | null;
  if (
    !ref || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    ref.key !== `sha256/${ref.sha256}.json` ||
    !Number.isSafeInteger(ref.size) || ref.size < 1 ||
    ref.size > MAX_ARTIFACT_BYTES
  ) {
    throw new TypeError("invalid artifact reference");
  }
  return { key: ref.key, sha256: ref.sha256, size: ref.size };
}
/** Read an untrusted request body with a streaming size bound. */
export async function readUpload(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new TypeError("empty artifact");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new TypeError("artifact too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** Store JSON bytes create-only and return their address. */
export async function putBytes(
  bucket: R2Bucket,
  bytes: Uint8Array,
): Promise<ArtifactRef> {
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) {
    throw new TypeError("artifact size out of range");
  }
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const sha256 = await digest(bytes);
  const ref = { key: `sha256/${sha256}.json`, sha256, size: bytes.length };
  const stored = await bucket.put(ref.key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (stored === null) await getArtifact(bucket, ref);
  return ref;
}
/** Serialize an internal report into immutable JSON. */
export function putArtifact(
  bucket: R2Bucket,
  value: unknown,
): Promise<ArtifactRef> {
  return putBytes(bucket, new TextEncoder().encode(JSON.stringify(value)));
}
/** Verify length and digest before deserializing evidence. */
export async function getArtifact<T>(
  bucket: R2Bucket,
  value: ArtifactRef,
): Promise<T> {
  const ref = artifactRef(value);
  const object = await bucket.get(ref.key);
  if (!object) throw new Error(`missing artifact ${ref.key}`);
  if (object.size !== ref.size) throw new Error("artifact size mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== ref.size || await digest(bytes) !== ref.sha256) {
    throw new Error("artifact integrity mismatch");
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as T;
}
