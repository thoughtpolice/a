// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The capped body read the harness's own examples share. The harness sits
 * below every library, so its examples cannot use `@celld/core/bounds`,
 * which every library's examples read bodies through; this is the part of
 * it they need. A `Content-Length` over the cap is refused before reading,
 * and a chunked body is counted as it arrives and cancelled the moment it
 * passes the cap.
 *
 * @module
 */

/** A body over its cap; the examples answer 413. */
export class TooLarge extends Error {
  constructor(maxBytes: number) {
    super(`body is over ${maxBytes} bytes`);
    this.name = "TooLarge";
  }
}

/** `request`'s body as UTF-8 text, at most `maxBytes` of it. */
export async function readCapped(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    request.body?.cancel().catch(() => {});
    throw new TooLarge(maxBytes);
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new TooLarge(maxBytes);
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
