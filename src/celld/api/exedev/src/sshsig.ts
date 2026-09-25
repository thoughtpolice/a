// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenSSH signatures (`ssh-keygen -Y sign`) with Web Crypto.
 *
 * An exe0 token's signature is the binary body of an armored SSH signature
 * (OpenSSH's PROTOCOL.sshsig): the magic `SSHSIG`, version 1, the signer's
 * public key, the namespace, an empty reserved string, the hash algorithm
 * (`sha512`) and the signature. What is signed is the magic, namespace,
 * reserved string, hash algorithm and the SHA-512 of the message.
 *
 * Only Ed25519 keys are supported, since Web Crypto (and so celld) has
 * Ed25519 and the docs' own examples use `ssh-keygen -t ed25519`. Ed25519
 * signatures are deterministic, so a token minted here is byte-for-byte the
 * one `ssh-keygen -Y sign` makes from the same key and payload.
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/jwt";
import { base64Decode, base64Encode } from "./quote.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Builds SSH wire-format data (RFC 4251 `string` and `uint32`). */
export class WireWriter {
  #parts: Uint8Array[] = [];

  raw(bytes: Uint8Array): this {
    this.#parts.push(bytes);
    return this;
  }

  uint32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value);
    return this.raw(bytes);
  }

  string(value: Uint8Array | string): this {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    return this.uint32(bytes.length).raw(bytes);
  }

  bytes(): Uint8Array {
    const length = this.#parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of this.#parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Reads SSH wire-format data; every read throws on truncation. */
export class WireReader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  raw(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new SshFormatError("truncated SSH data");
    }
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint32(): number {
    const b = this.raw(4);
    return b[0] * 0x1000000 + (b[1] << 16) + (b[2] << 8) + b[3];
  }

  string(): Uint8Array {
    return this.raw(this.uint32());
  }

  text(): string {
    try {
      return decoder.decode(this.string());
    } catch {
      throw new SshFormatError("an SSH string is not UTF-8");
    }
  }
}

/** Malformed SSH key or signature data. */
export class SshFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshFormatError";
  }
}

/** The algorithm name of Ed25519 keys and signatures. */
export const ED25519 = "ssh-ed25519";

/** The hash algorithm `ssh-keygen -Y sign` uses. */
export const SSHSIG_HASH = "sha512";

/** An SSH public key in wire form, with its parts. */
export interface SshPublicKey {
  /** `ssh-ed25519`. */
  readonly type: string;
  /** The 32-byte Ed25519 public key. */
  readonly key: Uint8Array;
  /** The wire blob: string type, string key. */
  readonly blob: Uint8Array;
}

/** Encodes an Ed25519 public key as an SSH wire blob. */
export function ed25519PublicKey(key: Uint8Array): SshPublicKey {
  if (key.length !== 32) {
    throw new SshFormatError("an Ed25519 public key is 32 bytes");
  }
  return {
    type: ED25519,
    key,
    blob: new WireWriter().string(ED25519).string(key).bytes(),
  };
}

/** Reads a public key wire blob. */
export function parsePublicKeyBlob(blob: Uint8Array): SshPublicKey {
  const reader = new WireReader(blob);
  const type = reader.text();
  if (type !== ED25519) {
    throw new SshFormatError(
      `unsupported key type ${type}; only ssh-ed25519 is supported`,
    );
  }
  const key = reader.string();
  if (key.length !== 32 || reader.remaining !== 0) {
    throw new SshFormatError("malformed ssh-ed25519 public key");
  }
  return { type, key: key.slice(), blob: blob.slice() };
}

/** Reads an `authorized_keys` line: `ssh-ed25519 AAAA... comment`. */
export function parsePublicKeyLine(
  line: string,
): SshPublicKey & { comment: string } {
  const [type, data, ...comment] = line.trim().split(/\s+/);
  if (type === undefined || data === undefined) {
    throw new SshFormatError("expected '<type> <base64> [comment]'");
  }
  let blob: Uint8Array;
  try {
    blob = base64Decode(data);
  } catch {
    throw new SshFormatError("the key is not base64");
  }
  const key = parsePublicKeyBlob(blob);
  if (key.type !== type) {
    throw new SshFormatError(
      `the line says ${type} but the key is ${key.type}`,
    );
  }
  return { ...key, comment: comment.join(" ") };
}

/** Formats a public key as an `authorized_keys` line. */
export function formatPublicKeyLine(key: SshPublicKey, comment = ""): string {
  const line = `${key.type} ${base64Encode(key.blob)}`;
  return comment === "" ? line : `${line} ${comment}`;
}

/** `SHA256:<base64 without padding>`, as `ssh-keygen -l` prints it. */
export async function fingerprint(key: SshPublicKey): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", key.blob as Uint8Array<ArrayBuffer>),
  );
  return `SHA256:${base64Encode(digest).replace(/=+$/, "")}`;
}

/** An unencrypted Ed25519 private key read from OpenSSH's format. */
export interface OpenSshPrivateKey {
  readonly publicKey: SshPublicKey;
  /** The 32-byte Ed25519 seed. */
  readonly seed: Uint8Array;
  readonly comment: string;
}

const OPENSSH_MAGIC = "openssh-key-v1\0";

/**
 * Reads an unencrypted Ed25519 key in OpenSSH's format
 * (`-----BEGIN OPENSSH PRIVATE KEY-----`), as `ssh-keygen -t ed25519 -N ''`
 * writes it. Encrypted keys are refused: Workers have no way to prompt, so
 * store the key unencrypted in a secret binding.
 */
export function parseOpenSshPrivateKey(pem: string): OpenSshPrivateKey {
  const match =
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/
      .exec(pem);
  if (match === null) {
    throw new SshFormatError(
      "not an OpenSSH private key (BEGIN OPENSSH PRIVATE KEY)",
    );
  }
  let data: Uint8Array;
  try {
    data = base64Decode(match[1].replace(/\s+/g, ""));
  } catch {
    throw new SshFormatError("the private key is not base64");
  }
  const magic = encoder.encode(OPENSSH_MAGIC);
  if (
    data.length < magic.length ||
    !magic.every((byte, index) => data[index] === byte)
  ) {
    throw new SshFormatError("missing the openssh-key-v1 magic");
  }
  const reader = new WireReader(data);
  reader.raw(magic.length);
  const cipher = reader.text();
  const kdf = reader.text();
  reader.string();
  if (cipher !== "none" || kdf !== "none") {
    throw new SshFormatError(
      "the private key is encrypted; store an unencrypted key (ssh-keygen -N '')",
    );
  }
  if (reader.uint32() !== 1) {
    throw new SshFormatError("expected exactly one key");
  }
  const publicKey = parsePublicKeyBlob(reader.string());
  const section = new WireReader(reader.string());
  const check1 = section.uint32();
  const check2 = section.uint32();
  if (check1 !== check2) {
    throw new SshFormatError("corrupt private key (check ints differ)");
  }
  const type = section.text();
  if (type !== ED25519) {
    throw new SshFormatError(
      `unsupported key type ${type}; only ssh-ed25519 is supported`,
    );
  }
  const pub = section.string();
  const secret = section.string();
  const comment = section.text();
  if (
    secret.length !== 64 ||
    !pub.every((byte, index) => byte === publicKey.key[index]) ||
    !secret.subarray(32).every((byte, index) => byte === publicKey.key[index])
  ) {
    throw new SshFormatError("corrupt ssh-ed25519 private key");
  }
  return { publicKey, seed: secret.slice(0, 32), comment };
}

/** Anything that can make an SSH signature: a key in memory, an agent, an HSM. */
export interface SshSigner {
  /** The signer's public key. */
  readonly publicKey: SshPublicKey;
  /**
   * Signs `data` and returns the SSH signature blob (string algorithm,
   * string signature), or a bare 64-byte Ed25519 signature.
   */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
]);

/** A signer for an Ed25519 seed, using Web Crypto. */
export async function ed25519Signer(
  seed: Uint8Array,
  publicKey: SshPublicKey,
): Promise<SshSigner> {
  if (seed.length !== 32) {
    throw new SshFormatError("an Ed25519 seed is 32 bytes");
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return {
    publicKey,
    async sign(data) {
      return new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          key,
          data as Uint8Array<ArrayBuffer>,
        ),
      );
    },
  };
}

/** A signer from an unencrypted OpenSSH Ed25519 private key. */
export async function signerFromOpenSsh(pem: string): Promise<SshSigner> {
  const parsed = parseOpenSshPrivateKey(pem);
  return await ed25519Signer(parsed.seed, parsed.publicKey);
}

/** The parts of an SSHSIG signature blob. */
export interface SshSignature {
  readonly publicKey: SshPublicKey;
  readonly namespace: string;
  readonly hashAlgorithm: string;
  /** The signature's algorithm, `ssh-ed25519`. */
  readonly signatureType: string;
  /** The raw 64-byte Ed25519 signature. */
  readonly signature: Uint8Array;
}

const SSHSIG_MAGIC = encoder.encode("SSHSIG");

/** The bytes an SSHSIG signs for `message` in `namespace`. */
export async function sshsigSignedData(
  message: Uint8Array,
  namespace: string,
  hashAlgorithm = SSHSIG_HASH,
): Promise<Uint8Array> {
  const hashName = hashAlgorithm === "sha512"
    ? "SHA-512"
    : hashAlgorithm === "sha256"
    ? "SHA-256"
    : undefined;
  if (hashName === undefined) {
    throw new SshFormatError(`unsupported SSHSIG hash ${hashAlgorithm}`);
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(hashName, message as Uint8Array<ArrayBuffer>),
  );
  return new WireWriter()
    .raw(SSHSIG_MAGIC)
    .string(namespace)
    .string("")
    .string(hashAlgorithm)
    .string(digest)
    .bytes();
}

/**
 * Signs `message` in `namespace` and returns the SSHSIG blob, the bytes
 * inside `-----BEGIN SSH SIGNATURE-----` armor.
 */
export async function sshsigSign(
  signer: SshSigner,
  message: Uint8Array,
  namespace: string,
): Promise<Uint8Array> {
  if (namespace === "") {
    throw new SshFormatError("the namespace must not be empty");
  }
  const signed = await signer.sign(await sshsigSignedData(message, namespace));
  const signatureBlob = signed.length === 64
    ? new WireWriter().string(ED25519).string(signed).bytes()
    : signed;
  return new WireWriter()
    .raw(SSHSIG_MAGIC)
    .uint32(1)
    .string(signer.publicKey.blob)
    .string(namespace)
    .string("")
    .string(SSHSIG_HASH)
    .string(signatureBlob)
    .bytes();
}

/** Reads an SSHSIG blob. */
export function parseSshsig(blob: Uint8Array): SshSignature {
  const reader = new WireReader(blob);
  const magic = reader.raw(6);
  if (!magic.every((byte, index) => byte === SSHSIG_MAGIC[index])) {
    throw new SshFormatError("missing the SSHSIG magic");
  }
  const version = reader.uint32();
  if (version !== 1) {
    throw new SshFormatError(`unsupported SSHSIG version ${version}`);
  }
  const publicKey = parsePublicKeyBlob(reader.string());
  const namespace = reader.text();
  reader.string();
  const hashAlgorithm = reader.text();
  const inner = new WireReader(reader.string());
  const signatureType = inner.text();
  const signature = inner.string().slice();
  if (reader.remaining !== 0 || inner.remaining !== 0) {
    throw new SshFormatError("trailing data in the SSHSIG blob");
  }
  if (signatureType !== ED25519 || signature.length !== 64) {
    throw new SshFormatError(`unsupported signature type ${signatureType}`);
  }
  return { publicKey, namespace, hashAlgorithm, signatureType, signature };
}

/** Checks an SSHSIG signature over `message` against its embedded key. */
export async function sshsigVerify(
  signature: SshSignature,
  message: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    signature.publicKey.key as Uint8Array<ArrayBuffer>,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "Ed25519",
    key,
    signature.signature as Uint8Array<ArrayBuffer>,
    await sshsigSignedData(
      message,
      signature.namespace,
      signature.hashAlgorithm,
    ) as Uint8Array<ArrayBuffer>,
  );
}

/** Wraps an SSHSIG blob in the armor `ssh-keygen -Y sign` writes. */
export function armorSshsig(blob: Uint8Array): string {
  const text = base64Encode(blob);
  const lines = text.match(/.{1,70}/g) ?? [];
  return [
    "-----BEGIN SSH SIGNATURE-----",
    ...lines,
    "-----END SSH SIGNATURE-----",
    "",
  ].join("\n");
}

/** Reads an armored SSH signature back into its blob. */
export function dearmorSshsig(armored: string): Uint8Array {
  const match =
    /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/
      .exec(armored);
  if (match === null) throw new SshFormatError("not an armored SSH signature");
  return base64Decode(match[1].replace(/\s+/g, ""));
}

/** base64url without padding, as exe0 tokens use. */
export function base64UrlEncode(data: Uint8Array | string): string {
  return toBase64Url(data);
}

/**
 * Decodes canonical, unpadded base64url.
 *
 * @throws {SshFormatError} on anything else.
 */
export function base64UrlDecode(text: string): Uint8Array {
  const bytes = fromBase64Url(text);
  if (bytes === null) throw new SshFormatError("not base64url");
  return bytes;
}
