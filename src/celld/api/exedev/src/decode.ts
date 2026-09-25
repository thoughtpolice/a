// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Decoders for the JSON the lobby returns.
 *
 * Only a few shapes are documented: `ls --json` (the API page), the fields of
 * `new`/`cp` (exe.dev's own Flue connector parses `vm_name`, `ssh_host`,
 * `ssh_user`, `ssh_dest`), `whoami --json` (`ssh_keys[].fingerprint` and
 * `.current`, from exe.dev's `which_keys.sh`), and `integrations list --json`
 * (a top-level array with `name` and `config`, from the GCP guide). These
 * are decoded into types by named sieve schemas (`VmSummary`, `CreatedVm`,
 * `SshKeyInfo`, `IntegrationInfo`, `LsResponse`, `WhoamiResponse`):
 * required fields must be present with the right type, and the object as
 * received (unknown fields and all) is kept in `raw`, which each schema's
 * transform takes from its input. Every other
 * command returns {@link JsonValue} untouched, since guessing a shape would
 * turn a server change into a silent misread.
 *
 * Field names stay as the server sends them (`vm_name`, `ssh_dest`), so they
 * match the docs.
 *
 * @module
 */

import {
  type AnySchema,
  type Issue as SieveIssue,
  type Output,
  v,
} from "@celld/sieve";
import { ExeDecodeError } from "./errors.ts";
import {
  isPlainObject,
  type Issue,
  type JsonObject,
  type JsonValue,
  type Path,
} from "./json.ts";

/** Sieve issues as this library's {@link Issue}s, under `prefix`. */
export function issuesFrom(
  issues: readonly SieveIssue[],
  prefix: Path = [],
): Issue[] {
  return issues.map((issue) => ({
    path: [...prefix, ...issue.path],
    message: issue.message,
  }));
}

/**
 * Parses a response (or the part of one at `path`) with a sieve schema.
 *
 * @throws {ExeDecodeError} with every issue, located from the response's
 * root.
 */
export function decodeWith<S extends AnySchema>(
  schema: S,
  value: unknown,
  path: Path = [],
): Output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ExeDecodeError(issuesFrom(result.error.issues, path));
  }
  return result.data as Output<S>;
}

/** Drops absent (`undefined` or `null`) members, so results compare and clone cleanly. */
function defined<T>(value: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      item !== undefined && item !== null
    ),
  ) as T;
}

const text = v.string().nullish();

/** A string list, also accepting a comma-separated string. */
const stringList = v.union([v.string(), v.array(v.string())]).nullish();

function listOf(
  value: string | readonly string[] | null | undefined,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return [...value];
  return value.split(",").map((part) => part.trim()).filter((part) =>
    part !== ""
  );
}

/**
 * How to reach a VM over SSH, as `ls`, `new` and `cp` report it. `ssh_dest`
 * is a ready-to-use destination that may carry a `user@` routing prefix;
 * tools that dial need `ssh_host` and `ssh_user` (absent when any user works).
 */
export interface SshRoute {
  readonly ssh_dest?: string;
  readonly ssh_host?: string;
  readonly ssh_user?: string;
}

const route = { ssh_dest: text, ssh_host: text, ssh_user: text };

function routeOf(object: {
  readonly ssh_dest?: string | null;
  readonly ssh_host?: string | null;
  readonly ssh_user?: string | null;
}) {
  return {
    ssh_dest: object.ssh_dest,
    ssh_host: object.ssh_host,
    ssh_user: object.ssh_user,
  };
}

/** One VM, as `ls --json` lists it. */
export interface VmSummary extends SshRoute {
  /** The VM's name; `https://<name>.exe.xyz` serves it. */
  readonly vm_name: string;
  /** The VM's state, such as `running`. The docs list no other values. */
  readonly status: string;
  /** The region code, such as `lon`. */
  readonly region?: string;
  /** The region's display name, such as `London, UK`. */
  readonly region_display?: string;
  readonly https_url?: string;
  /**
   * Tags, when the listing includes them. The documented `ls --json` example
   * has none, so `undefined` means "not reported", not "no tags".
   */
  readonly tags?: readonly string[];
  /** The comment, when the listing includes it. */
  readonly comment?: string;
  /** The container image, when the listing includes it. */
  readonly image?: string;
  /** The whole entry as received, unknown fields included. */
  readonly raw: JsonObject;
}

/**
 * One `ls` entry: `vm_name` and `status` are required; the rest may be
 * absent or null. `tags` may be a list or comma-separated text.
 */
export const VmSummary: v.Schema<VmSummary, unknown> = v.looseObject({
  vm_name: v.string(),
  status: v.string(),
  ...route,
  region: text,
  region_display: text,
  https_url: text,
  tags: stringList,
  comment: text,
  image: text,
}).transform((object, { input }) =>
  defined<VmSummary>({
    vm_name: object.vm_name,
    status: object.status,
    ...routeOf(object),
    region: object.region,
    region_display: object.region_display,
    https_url: object.https_url,
    tags: listOf(object.tags),
    comment: object.comment,
    image: object.image,
    raw: input as JsonObject,
  })
).meta({ id: "VmSummary" });

/** The result of `ls`. */
export interface LsResult {
  readonly vms: readonly VmSummary[];
  /** The whole response as received. */
  readonly raw: JsonObject;
}

/** `ls --json`: `{"vms": [...]}`. */
export const LsResponse: v.Schema<LsResult, unknown> = v.looseObject({
  vms: v.array(VmSummary),
}).transform(({ vms }, { input }): LsResult => ({
  vms,
  raw: input as JsonObject,
})).meta({ id: "LsResponse" });

/** Decodes `ls --json`: `{"vms": [...]}` with `vm_name` and `status` each. */
export function decodeLs(value: unknown): LsResult {
  return decodeWith(LsResponse, value);
}

/** The result of `new` or `cp`. */
export interface CreatedVm extends SshRoute {
  /** The new VM's name. */
  readonly vm_name: string;
  readonly https_url?: string;
  readonly status?: string;
  readonly region?: string;
  /** The whole response as received. */
  readonly raw: JsonObject;
}

/**
 * `new --json` or `cp --json`. `vm_name` is required; the older spelling
 * `name` is accepted for it, as exe.dev's own connector does.
 */
export const CreatedVm: v.Schema<CreatedVm, unknown> = v.looseObject({
  vm_name: text,
  name: text,
  ...route,
  https_url: text,
  status: text,
  region: text,
}).check((ctx) => {
  if (!ctx.value.vm_name && !ctx.value.name) {
    ctx.addIssue({ path: ["vm_name"], message: "is missing" });
  }
}, {
  // Alongside other fields' issues, once the two names are readable.
  when: ({ issues }) =>
    issues.every((issue) =>
      issue.path[0] !== "vm_name" && issue.path[0] !== "name"
    ),
}).transform((object, { input }) =>
  defined<CreatedVm>({
    vm_name: object.vm_name || object.name,
    ...routeOf(object),
    https_url: object.https_url,
    status: object.status,
    region: object.region,
    raw: input as JsonObject,
  })
).meta({ id: "CreatedVm" });

/** Decodes `new --json` or `cp --json`; see {@link CreatedVm}. */
export function decodeCreatedVm(value: unknown): CreatedVm {
  return decodeWith(CreatedVm, value);
}

/** One SSH key, as `whoami` or `ssh-key list` report it. */
export interface SshKeyInfo {
  /** `SHA256:...`, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string;
  /** Whether this key made the request (for SSH; tokens name their key). */
  readonly current?: boolean;
  readonly name?: string;
  readonly public_key?: string;
  readonly raw: JsonObject;
}

/** One SSH key: a `fingerprint` is required. */
export const SshKeyInfo: v.Schema<SshKeyInfo, unknown> = v.looseObject({
  fingerprint: v.string(),
  current: v.boolean().nullish(),
  name: text,
  public_key: text,
}).transform((object, { input }) =>
  defined<SshKeyInfo>({
    fingerprint: object.fingerprint,
    current: object.current,
    name: object.name,
    public_key: object.public_key,
    raw: input as JsonObject,
  })
).meta({ id: "SshKeyInfo" });

/** The result of `whoami`. */
export interface WhoamiResult {
  readonly email?: string;
  /** The account's keys, when reported. */
  readonly ssh_keys?: readonly SshKeyInfo[];
  readonly raw: JsonObject;
}

/** `whoami --json`: `ssh_keys`, when present, needs fingerprints. */
export const WhoamiResponse: v.Schema<WhoamiResult, unknown> = v.looseObject({
  email: text,
  ssh_keys: v.array(SshKeyInfo).nullish(),
}).transform(({ email, ssh_keys }, { input }) =>
  defined<WhoamiResult>({ email, ssh_keys, raw: input })
).meta({ id: "WhoamiResponse" });

/** Decodes `whoami --json`; see {@link WhoamiResponse}. */
export function decodeWhoami(value: unknown): WhoamiResult {
  return decodeWith(WhoamiResponse, value);
}

/**
 * The list in a response that is either a top-level array or an object
 * holding it under one of `keys`, with its path. The first key is the path
 * reported when there is none.
 */
function listIn(
  value: unknown,
  keys: readonly string[],
): { readonly list: unknown; readonly path: Path } {
  if (!isPlainObject(value)) return { list: value, path: [] };
  const key = keys.find((name) => Array.isArray(value[name]));
  return key === undefined
    ? { list: undefined, path: [keys[0]] }
    : { list: value[key], path: [key] };
}

/**
 * Decodes `ssh-key list --json`. Its shape is not documented: this accepts a
 * top-level array or an object holding the array under `ssh_keys` or `keys`,
 * and requires a `fingerprint` on each key.
 */
export function decodeSshKeys(value: unknown): SshKeyInfo[] {
  const { list, path } = listIn(value, ["ssh_keys", "keys"]);
  return decodeWith(v.array(SshKeyInfo), list, path);
}

/** One integration, as `integrations list --json` reports it. */
export interface IntegrationInfo {
  readonly name: string;
  /** `http-proxy`, `github`, `llm`, `reflection`, `wif`, a catalog handle... */
  readonly type?: string;
  readonly comment?: string;
  /** Type-specific settings; secrets appear as `***`. */
  readonly config?: JsonObject;
  /** With `--usage`: when a VM last used it. */
  readonly lastUsedAt?: string;
  /** With `--usage`: the VMs that used it. */
  readonly usedByVMs?: readonly string[];
  readonly raw: JsonObject;
}

function vmName(vm: unknown): string {
  if (typeof vm === "string") return vm;
  if (isPlainObject(vm) && typeof vm.name === "string") return vm.name;
  if (isPlainObject(vm) && typeof vm.vm_name === "string") return vm.vm_name;
  return JSON.stringify(vm);
}

/**
 * One integration: a `name` is required, and `config`, when present, is an
 * object. `usedByVMs` entries may be names or objects with `name` or
 * `vm_name`.
 */
export const IntegrationInfo: v.Schema<IntegrationInfo, unknown> = v
  .looseObject({
    name: v.string(),
    type: text,
    comment: text,
    config: v.looseObject({}).nullish(),
    lastUsedAt: text,
    usedByVMs: v.unknown(),
  }).transform((object, { input }) =>
    defined<IntegrationInfo>({
      name: object.name,
      type: object.type,
      comment: object.comment,
      config: object.config,
      lastUsedAt: object.lastUsedAt,
      usedByVMs: Array.isArray(object.usedByVMs)
        ? object.usedByVMs.map(vmName)
        : undefined,
      raw: input as JsonObject,
    })
  ).meta({ id: "IntegrationInfo" });

/**
 * Decodes `integrations list --json`: a top-level array of objects with a
 * `name` (the GCP guide reads `.[] | .name` and `.config.issuer_id`). An
 * object with an `integrations` array is accepted too.
 */
export function decodeIntegrations(value: unknown): IntegrationInfo[] {
  const { list, path } = isPlainObject(value) &&
      Array.isArray(value.integrations)
    ? { list: value.integrations, path: ["integrations"] }
    : { list: value, path: [] };
  return decodeWith(v.array(IntegrationInfo), list, path);
}

const TOKEN = /^exe[01]\.[A-Za-z0-9_.=-]+$/;

/** Finds the first string that looks like an exe0 or exe1 token. */
export function findToken(
  value: JsonValue,
  prefer: readonly string[] = ["token", "api_key", "key"],
): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return TOKEN.test(trimmed) ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findToken(item, prefer);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const key of prefer) {
    const item = value[key];
    if (typeof item === "string" && TOKEN.test(item.trim())) return item.trim();
  }
  for (const item of Object.values(value)) {
    const found = findToken(item as JsonValue, prefer);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A token the server issued, with the response it came in. */
export interface IssuedToken {
  readonly token: string;
  readonly raw: JsonValue;
}

/**
 * Decodes the response of `ssh-key generate-api-key` or `exe0-to-exe1`.
 * Neither JSON shape is documented, so the token is the first `exe0.`/`exe1.`
 * string found (preferring `token`, `api_key`, `key`); its absence is a
 * decode error.
 */
export function decodeIssuedToken(
  value: unknown,
  prefix?: "exe0" | "exe1",
): IssuedToken {
  const token = findToken(value as JsonValue);
  if (
    token === undefined ||
    (prefix !== undefined && !token.startsWith(`${prefix}.`))
  ) {
    throw new ExeDecodeError([{
      path: [],
      message: `no ${prefix ?? "exe0/exe1"} token in the response`,
    }]);
  }
  return { token, raw: value as JsonValue };
}
