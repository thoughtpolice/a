// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Derive a bounded opaque identity for storage keys and capability namespaces. */
export async function opaqueIdentity(
  secret: Uint8Array | CryptoKey,
  namespace: string,
  identity: string,
): Promise<string> {
  // Controls are intentionally excluded from the domain separator.
  // deno-lint-ignore no-control-regex
  const controls = /[\u0000-\u001f\u007f]/u;
  if (
    typeof namespace !== "string" || namespace.length === 0 ||
    namespace.length > 256 || controls.test(namespace)
  ) {
    throw new TypeError(
      "identity namespace must be 1–256 printable characters",
    );
  }
  if (
    typeof identity !== "string" || identity.length === 0 ||
    identity.length > 16384
  ) {
    throw new TypeError("canonical identity must be 1–16384 characters");
  }
  let key: CryptoKey;
  if (secret instanceof Uint8Array) {
    if (secret.byteLength < 32 || secret.byteLength > 4096) {
      throw new RangeError("identity secret must contain 32–4096 bytes");
    }
    key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } else {
    key = secret;
    const algorithm = key?.algorithm as HmacKeyAlgorithm | undefined;
    if (
      !(key instanceof CryptoKey) || key.type !== "secret" ||
      algorithm?.name !== "HMAC" || algorithm.hash?.name !== "SHA-256" ||
      algorithm.length < 256 || !key.usages.includes("sign")
    ) {
      throw new TypeError(
        "identity key must be an HMAC-SHA-256 signing key of at least 256 bits",
      );
    }
  }
  const input = new TextEncoder().encode(
    JSON.stringify(["celld.identity.v1", namespace, identity]),
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let buffer = 0;
  let result = "";
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}
