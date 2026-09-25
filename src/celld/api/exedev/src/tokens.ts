// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * exe.dev bearer tokens: their permissions, parsing, local minting and
 * verification.
 *
 * An **exe0** token is `exe0.<payload>.<signature>`: the permissions JSON and
 * an OpenSSH signature of exactly those bytes (SSHSIG, namespace `v0@exe.dev`,
 * or `v0@<vm>.exe.xyz` for a token scoped to one VM's HTTPS endpoints), both
 * base64url without padding. An **exe1** token is an opaque server-side
 * handle for an exe0 token (`exe0-to-exe1`), and cannot be inspected.
 *
 * The permissions JSON rules come from the HTTPS API page and are all
 * enforced before signing: only `exp`, `nbf`, `cmds` and `ctx` at the top
 * level; `exp`/`nbf` written as integers between 946684800 (2000-01-01) and
 * 4102444800 (2100-01-01); no duplicate keys at any depth; no leading or
 * trailing whitespace, newline, carriage return or NUL; the whole token at
 * most 8 KB (read here as 8192 bytes).
 *
 * `cmds` names commands, not flags: `"ssh-key list"` allows exactly that
 * subcommand, a parent never grants its subcommands, and `"ssh <vm>"` limits
 * `ssh` to one VM. Leaving it out means the server's default list,
 * {@link DEFAULT_CMDS}.
 *
 * @module
 */

import { v } from "@celld/sieve";
import { COMMANDS, commandSpec, resolveCommand } from "./catalog.ts";
import { issuesFrom } from "./decode.ts";
import {
  describeValue,
  formatIssues,
  isPlainObject,
  type Issue,
  type JsonValue,
  parseStrictJson,
} from "./json.ts";
import { defaultRuntime, type Runtime } from "./runtime.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  fingerprint,
  parsePublicKeyLine,
  parseSshsig,
  type SshPublicKey,
  type SshSignature,
  type SshSigner,
  sshsigSign,
  sshsigVerify,
} from "./sshsig.ts";

/** The `cmds` a token has when its permissions do not say. */
export const DEFAULT_CMDS: readonly string[] = Object.freeze([
  "help",
  "ls",
  "new",
  "whoami",
  "ssh-key list",
  "share show",
  "exe0-to-exe1",
  "team",
  "team members",
]);

/** The earliest `exp`/`nbf` accepted: 2000-01-01T00:00:00Z. */
export const MIN_TOKEN_TIMESTAMP = 946684800;
/** The latest `exp`/`nbf` accepted: 2100-01-01T00:00:00Z. */
export const MAX_TOKEN_TIMESTAMP = 4102444800;
/** The largest token accepted: "8KB", read as 8192 bytes. */
export const MAX_TOKEN_BYTES = 8192;
/** The signing namespace of tokens for the exe.dev API. */
export const API_NAMESPACE = "v0@exe.dev";

/** The signing namespace of tokens for one VM's HTTPS endpoints. */
export function vmNamespace(vm: string): string {
  return `v0@${vm}.exe.xyz`;
}

/** A token's permissions, as signed. */
export interface Permissions {
  /** Unix seconds after which the token is invalid. Default: never. */
  readonly exp?: number;
  /** Unix seconds before which the token is invalid. Default: always valid. */
  readonly nbf?: number;
  /** Commands the token may run. Default: {@link DEFAULT_CMDS}. */
  readonly cmds?: readonly string[];
  /** Your own data, passed to VM servers as `X-ExeDev-Token-Ctx`. */
  readonly ctx?: JsonValue;
}

/** Options for checking permissions. */
export interface PermissionOptions {
  /**
   * Refuse `cmds` entries that name no command in the catalog (other than
   * `ssh <vm>`). Default true; turn off for commands newer than this library.
   */
  readonly knownCommandsOnly?: boolean;
}

const FIELDS = new Set(["exp", "nbf", "cmds", "ctx"]);

function timestampIssues(name: string, value: unknown, issues: Issue[]): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({
      path: [name],
      message: `must be an integer, got ${describeValue(value)}`,
    });
  } else if (value < MIN_TOKEN_TIMESTAMP || value > MAX_TOKEN_TIMESTAMP) {
    issues.push({
      path: [name],
      message:
        `must be between ${MIN_TOKEN_TIMESTAMP} and ${MAX_TOKEN_TIMESTAMP}`,
    });
  }
}

/** Whether `entry` is a valid `cmds` entry. */
function cmdIssues(entry: unknown, index: number, knownOnly: boolean): Issue[] {
  const path = ["cmds", index];
  if (typeof entry !== "string") {
    return [{ path, message: `must be a string, got ${describeValue(entry)}` }];
  }
  if (!/^[a-z0-9][a-z0-9-]*( [a-z0-9][a-z0-9._-]*)*$/.test(entry)) {
    return [{
      path,
      message:
        'must be command words separated by single spaces, such as "ssh-key list"',
    }];
  }
  if (!knownOnly) return [];
  const words = entry.split(" ");
  if (words[0] === "ssh" && words.length === 2) return [];
  if (commandSpec(entry) !== undefined) return [];
  return [{
    path,
    message:
      `names no known command; known ones are ${COMMANDS.length} catalog paths or "ssh <vm>"`,
  }];
}

function textIssues(text: string): Issue[] {
  const issues: Issue[] = [];
  if (text !== text.trim()) {
    issues.push({ path: [], message: "no leading or trailing whitespace" });
  }
  if (/[\r\n]/.test(text)) issues.push({ path: [], message: "no newlines" });
  if (text.includes("\0") || text.includes("\\u0000")) {
    issues.push({ path: [], message: "no NUL bytes" });
  }
  return issues;
}

/** Every rule a permissions value breaks, before it is encoded. */
export function permissionsIssues(
  value: unknown,
  options: PermissionOptions = {},
): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(value)) {
    return [{
      path: [],
      message: `permissions must be an object, got ${describeValue(value)}`,
    }];
  }
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key)) {
      issues.push({
        path: [key],
        message: "unknown field; only exp, nbf, cmds and ctx",
      });
    }
  }
  if (value.exp !== undefined) timestampIssues("exp", value.exp, issues);
  if (value.nbf !== undefined) timestampIssues("nbf", value.nbf, issues);
  if (
    typeof value.exp === "number" && typeof value.nbf === "number" &&
    value.nbf > value.exp
  ) {
    issues.push({
      path: ["nbf"],
      message: "is after exp, so the token is never valid",
    });
  }
  if (value.cmds !== undefined) {
    if (!Array.isArray(value.cmds)) {
      issues.push({
        path: ["cmds"],
        message: "must be an array of command names",
      });
    } else {
      const seen = new Set<string>();
      value.cmds.forEach((entry, index) => {
        issues.push(
          ...cmdIssues(entry, index, options.knownCommandsOnly ?? true),
        );
        if (typeof entry === "string") {
          if (seen.has(entry)) {
            issues.push({
              path: ["cmds", index],
              message: "repeats an earlier entry",
            });
          }
          seen.add(entry);
        }
      });
    }
  }
  if (value.ctx !== undefined) {
    const json = v.json().safeParse(value.ctx);
    if (!json.success) {
      issues.push(...issuesFrom(json.error.issues, ["ctx"]));
    } else {
      const text = JSON.stringify(value.ctx);
      if (text.includes("\\u0000")) {
        issues.push({ path: ["ctx"], message: "no NUL bytes" });
      }
    }
  }
  return issues;
}

/** Thrown when permissions or a token break the documented rules. */
export class TokenError extends Error {
  constructor(readonly issues: readonly Issue[], prefix = "invalid token") {
    super(`${prefix}: ${formatIssues(issues)}`);
    this.name = "TokenError";
  }
}

/**
 * Encodes permissions as compact JSON in a fixed field order (exp, nbf, cmds,
 * ctx), which is what gets signed.
 *
 * @throws {TokenError} when a rule is broken.
 */
export function encodePermissions(
  permissions: Permissions,
  options: PermissionOptions = {},
): string {
  const issues = permissionsIssues(permissions, options);
  if (issues.length > 0) throw new TokenError(issues, "invalid permissions");
  const ordered: Record<string, JsonValue> = {};
  if (permissions.exp !== undefined) ordered.exp = permissions.exp;
  if (permissions.nbf !== undefined) ordered.nbf = permissions.nbf;
  if (permissions.cmds !== undefined) ordered.cmds = [...permissions.cmds];
  if (permissions.ctx !== undefined) ordered.ctx = permissions.ctx;
  return JSON.stringify(ordered);
}

/** The result of {@link checkPermissionsText}. */
export type PermissionsCheck =
  | { readonly ok: true; readonly permissions: Permissions }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/**
 * Checks permissions JSON text exactly as it will be signed: the text rules
 * (whitespace, newlines, NUL), duplicate keys at any depth, integer literals
 * for `exp`/`nbf` (no `2e9`, no `2000000000.0`), then the value rules.
 */
export function checkPermissionsText(
  text: string,
  options: PermissionOptions = {},
): PermissionsCheck {
  const issues = textIssues(text);
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, issues: [...issues, ...parsed.issues] };
  for (const name of ["exp", "nbf"]) {
    const number = parsed.numbers.get(name);
    if (number !== undefined && !/^-?\d+$/.test(number.text)) {
      issues.push({
        path: [name],
        message: `must be written as an integer, not ${number.text}`,
      });
    }
  }
  issues.push(...permissionsIssues(parsed.value, options));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, permissions: parsed.value as Permissions };
}

/** What {@link permissions} takes: {@link Permissions} with friendlier times. */
export interface PermissionsInput {
  /** Expiry as an instant or Unix seconds. */
  readonly expiresAt?: Temporal.Instant | number;
  /** Expiry relative to `now`, in seconds. */
  readonly expiresInSeconds?: number;
  /** Not-before as an instant or Unix seconds. */
  readonly notBefore?: Temporal.Instant | number;
  readonly cmds?: readonly string[];
  readonly ctx?: JsonValue;
  /** "Now" in milliseconds, for `expiresInSeconds`; default `Date.now()`. */
  readonly now?: number;
}

function seconds(value: Temporal.Instant | number): number {
  return typeof value === "number"
    ? value
    : Math.floor(value.epochMilliseconds / 1000);
}

/**
 * Builds and checks permissions. The docs strongly recommend always setting
 * an expiry; this does not force one.
 *
 * ```ts
 * permissions({ expiresInSeconds: 3600, cmds: ["ls", "ssh web-0"] });
 * ```
 *
 * @throws {TokenError} when a rule is broken.
 */
export function permissions(
  input: PermissionsInput,
  options: PermissionOptions = {},
): Permissions {
  if (input.expiresAt !== undefined && input.expiresInSeconds !== undefined) {
    throw new TokenError(
      [{
        path: ["exp"],
        message: "give expiresAt or expiresInSeconds, not both",
      }],
      "invalid permissions",
    );
  }
  const now = input.now ?? Date.now();
  const exp = input.expiresAt !== undefined
    ? seconds(input.expiresAt)
    : input.expiresInSeconds !== undefined
    ? Math.floor(now / 1000) + input.expiresInSeconds
    : undefined;
  const out: Record<string, unknown> = {};
  if (exp !== undefined) out.exp = exp;
  if (input.notBefore !== undefined) out.nbf = seconds(input.notBefore);
  if (input.cmds !== undefined) out.cmds = [...input.cmds];
  if (input.ctx !== undefined) out.ctx = input.ctx;
  const issues = permissionsIssues(out, options);
  if (issues.length > 0) throw new TokenError(issues, "invalid permissions");
  return out as Permissions;
}

/**
 * Whether `cmds` (or the default list) lets a token run the command at
 * `path`, a catalog path such as `"share show"`. For `ssh`, `vm` is the
 * target VM: `"ssh"` allows any VM, `"ssh <vm>"` only that one.
 */
export function cmdsAllow(
  cmds: readonly string[] | undefined,
  path: string,
  vm?: string,
): boolean {
  const list = cmds ?? DEFAULT_CMDS;
  if (path === "ssh") {
    return list.includes("ssh") ||
      (vm !== undefined && list.includes(`ssh ${vm}`));
  }
  return list.includes(path);
}

/** The command path a command line's words resolve to, for `cmds` checks. */
export function permissionPath(words: readonly string[]): string | undefined {
  return resolveCommand(words)?.path;
}

/** A parsed exe0 token. */
export interface Exe0Token {
  readonly kind: "exe0";
  readonly token: string;
  /** The permissions JSON exactly as signed. */
  readonly payload: string;
  /** The permissions, when the payload keeps the rules (see `issues`). */
  readonly permissions: Permissions;
  /** The rules the payload breaks; the server rejects such a token. */
  readonly issues: readonly Issue[];
  readonly signature: SshSignature;
}

/** A parsed exe1 token: an opaque handle. */
export interface Exe1Token {
  readonly kind: "exe1";
  readonly token: string;
}

/** Either kind of token. */
export type ParsedToken = Exe0Token | Exe1Token;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses a token. An exe0 token's payload and signature are decoded; an
 * exe1 token is only recognised.
 *
 * @throws {TokenError} for a malformed token.
 */
export function parseToken(token: string): ParsedToken {
  const bytes = new TextEncoder().encode(token).length;
  if (bytes > MAX_TOKEN_BYTES) {
    throw new TokenError([{
      path: [],
      message: `is ${bytes} bytes; at most ${MAX_TOKEN_BYTES}`,
    }]);
  }
  if (/^exe1\.[A-Za-z0-9_-]+$/.test(token)) return { kind: "exe1", token };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "exe0") {
    throw new TokenError([{
      path: [],
      message: "expected exe0.<payload>.<signature> or exe1.<handle>",
    }]);
  }
  let payload: string;
  let signature: SshSignature;
  try {
    payload = utf8.decode(base64UrlDecode(parts[1]));
  } catch {
    throw new TokenError([{
      path: ["payload"],
      message: "is not base64url UTF-8",
    }]);
  }
  try {
    signature = parseSshsig(base64UrlDecode(parts[2]));
  } catch (error) {
    throw new TokenError([{
      path: ["signature"],
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
  const check = checkPermissionsText(payload, { knownCommandsOnly: false });
  let permissions: Permissions = {};
  if (check.ok) {
    permissions = check.permissions;
  } else {
    try {
      const loose = JSON.parse(payload);
      if (isPlainObject(loose)) permissions = loose as Permissions;
    } catch {
      // The issues say why.
    }
  }
  return {
    kind: "exe0",
    token,
    payload,
    permissions,
    issues: check.ok ? [] : check.issues,
    signature,
  };
}

/** What {@link mintExe0} takes. */
export interface MintOptions {
  /** Permissions to sign, or permissions JSON text to sign byte for byte. */
  readonly permissions: Permissions | string;
  /** The key that signs; its public key must be on the exe.dev account. */
  readonly signer: SshSigner;
  /** Scope the token to this VM's HTTPS endpoints (`v0@<vm>.exe.xyz`). */
  readonly vm?: string;
  /** An explicit namespace; default `v0@exe.dev`, or the VM's. */
  readonly namespace?: string;
  readonly permissionOptions?: PermissionOptions;
}

/**
 * Mints an exe0 token locally, the way the docs do with `ssh-keygen -Y sign`,
 * using Web Crypto Ed25519. No network is involved.
 *
 * @throws {TokenError} when the permissions break a rule, or the token would
 * be over 8 KB.
 */
export async function mintExe0(options: MintOptions): Promise<string> {
  let payload: string;
  if (typeof options.permissions === "string") {
    const check = checkPermissionsText(
      options.permissions,
      options.permissionOptions,
    );
    if (!check.ok) throw new TokenError(check.issues, "invalid permissions");
    payload = options.permissions;
  } else {
    payload = encodePermissions(options.permissions, options.permissionOptions);
  }
  if (options.vm !== undefined && options.namespace !== undefined) {
    throw new TokenError([{
      path: ["namespace"],
      message: "give vm or namespace, not both",
    }]);
  }
  const namespace = options.namespace ??
    (options.vm === undefined ? API_NAMESPACE : vmNamespace(options.vm));
  const message = new TextEncoder().encode(payload);
  const blob = await sshsigSign(options.signer, message, namespace);
  const token = `exe0.${base64UrlEncode(message)}.${base64UrlEncode(blob)}`;
  const bytes = new TextEncoder().encode(token).length;
  if (bytes > MAX_TOKEN_BYTES) {
    throw new TokenError([{
      path: [],
      message: `the token would be ${bytes} bytes; at most ${MAX_TOKEN_BYTES}`,
    }]);
  }
  return token;
}

/** What {@link verifyExe0} checks besides the signature. */
export interface VerifyOptions {
  /** The namespace the token must be signed in; default any. */
  readonly namespace?: string;
  /** Shorthand for `namespace: v0@<vm>.exe.xyz`. */
  readonly vm?: string;
  /**
   * Keys allowed to sign: public keys, `authorized_keys` lines or
   * `SHA256:` fingerprints. Default: any key (the signature still verifies).
   */
  readonly keys?: readonly (SshPublicKey | string)[];
  /** Check `exp` and `nbf` against this time in milliseconds. */
  readonly now?: number;
}

/** The result of {@link verifyExe0}. */
export type VerifyResult =
  | {
    readonly ok: true;
    readonly permissions: Permissions;
    readonly namespace: string;
    /** The signing key's `SHA256:` fingerprint. */
    readonly fingerprint: string;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies an exe0 token the way exe.dev would, short of knowing which keys
 * are on the account: the payload keeps the rules, the signature verifies
 * with the embedded key, the namespace and key are the expected ones, and it
 * is within `nbf`..`exp` when `now` is given.
 */
export async function verifyExe0(
  token: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  let parsed: ParsedToken;
  try {
    parsed = parseToken(token);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (parsed.kind !== "exe0") {
    return {
      ok: false,
      reason: "exe1 tokens are opaque; only the server can check them",
    };
  }
  if (parsed.issues.length > 0) {
    return {
      ok: false,
      reason: `the payload breaks the rules: ${formatIssues(parsed.issues)}`,
    };
  }
  const expected = options.namespace ??
    (options.vm === undefined ? undefined : vmNamespace(options.vm));
  if (expected !== undefined && parsed.signature.namespace !== expected) {
    return {
      ok: false,
      reason: `signed for ${parsed.signature.namespace}, expected ${expected}`,
    };
  }
  const message = new TextEncoder().encode(parsed.payload);
  if (!await sshsigVerify(parsed.signature, message)) {
    return { ok: false, reason: "the signature does not verify" };
  }
  const print = await fingerprint(parsed.signature.publicKey);
  if (options.keys !== undefined) {
    let allowed = false;
    for (const key of options.keys) {
      if (typeof key === "string" && key.startsWith("SHA256:")) {
        allowed = key === print;
      } else {
        const candidate = typeof key === "string"
          ? parsePublicKeyLine(key)
          : key;
        allowed =
          candidate.blob.length === parsed.signature.publicKey.blob.length &&
          candidate.blob.every((byte, index) =>
            byte === parsed.signature.publicKey.blob[index]
          );
      }
      if (allowed) break;
    }
    if (!allowed) {
      return { ok: false, reason: `signed by an unknown key ${print}` };
    }
  }
  if (options.now !== undefined) {
    const now = Math.floor(options.now / 1000);
    const { exp, nbf } = parsed.permissions;
    if (exp !== undefined && now > exp) return { ok: false, reason: "expired" };
    if (nbf !== undefined && now < nbf) {
      return { ok: false, reason: "not yet valid" };
    }
  }
  return {
    ok: true,
    permissions: parsed.permissions,
    namespace: parsed.signature.namespace,
    fingerprint: print,
  };
}

/** Supplies a bearer token, possibly minting or refreshing one. */
export interface TokenSource {
  token(): Promise<string>;
}

/** What {@link mintingTokenSource} takes. */
export interface MintingTokenSourceOptions {
  readonly signer: SshSigner;
  /** `cmds` and `ctx` of every minted token; `exp` is set from `ttlSeconds`. */
  readonly cmds?: readonly string[];
  readonly ctx?: JsonValue;
  /** Lifetime of each token; default 3600 s. */
  readonly ttlSeconds?: number;
  /** Mint a fresh token this long before expiry; default 300 s. */
  readonly refreshBeforeSeconds?: number;
  readonly vm?: string;
  readonly runtime?: Pick<Runtime, "now">;
}

/**
 * A token source that mints short-lived exe0 tokens with `signer` and reuses
 * each until shortly before it expires, following the docs' advice to keep
 * `exp` small since tokens have no replay protection.
 */
export function mintingTokenSource(
  options: MintingTokenSourceOptions,
): TokenSource {
  const ttl = options.ttlSeconds ?? 3600;
  const early = options.refreshBeforeSeconds ?? 300;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new RangeError("ttlSeconds must be a positive integer");
  }
  if (!Number.isFinite(early) || early < 0 || early >= ttl) {
    throw new RangeError(
      "refreshBeforeSeconds must be from 0 to below ttlSeconds",
    );
  }
  const runtime = options.runtime ?? defaultRuntime;
  let current: { token: string; exp: number } | null = null;
  let pending: Promise<string> | null = null;
  return {
    token() {
      const now = Math.floor(runtime.now() / 1000);
      if (current !== null && now < current.exp - early) {
        return Promise.resolve(current.token);
      }
      pending ??= (async () => {
        try {
          const exp = now + ttl;
          const token = await mintExe0({
            signer: options.signer,
            vm: options.vm,
            permissions: {
              exp,
              ...(options.cmds === undefined ? {} : { cmds: options.cmds }),
              ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
            },
          });
          current = { token, exp };
          return token;
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
  };
}

/** A token source for a fixed token. */
export function staticTokenSource(token: string): TokenSource {
  return { token: () => Promise.resolve(token) };
}
