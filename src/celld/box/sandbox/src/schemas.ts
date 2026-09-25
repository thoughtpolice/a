// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation for every argument that crosses RPC, with `@celld/sieve`.
 * Objects are strict: an unknown option is a mistake worth hearing about,
 * not something to ignore.
 *
 * @module
 */

import { utf8Length } from "@celld/core/bounds";
import { type AnySchema, type Output, SieveError, v } from "@celld/sieve";
import { SandboxError } from "./errors.ts";

const noNul = (text: string) => !text.includes("\0");

/** An environment variable name: a shell identifier. */
export const EnvName = v.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]{0,255}$/,
  "must be a shell identifier",
);

/**
 * The most bytes one argument (or one `NAME=value`) may have: Linux refuses
 * a single argument of 128 KiB or more (`MAX_ARG_STRLEN`) with E2BIG, and
 * every environment variable is an argument of `env -i`.
 */
export const MAX_ARG_BYTES = 120 * 1024;

const argBytes = (text: string) => utf8Length(text) <= MAX_ARG_BYTES;
const ARG_BYTES = `must be at most ${MAX_ARG_BYTES} bytes`;

/** An environment variable value: no NUL, at most 120 KiB. */
export const EnvValue = v.string().max(MAX_ARG_BYTES).refine(
  noNul,
  "must not contain NUL",
).refine(argBytes, ARG_BYTES);

/** A set of environment variables, at most 256 of them. */
export const Env = v.record(EnvName, EnvValue).refine(
  (env) => Object.keys(env).length <= 256,
  "at most 256 variables",
);

/** An argv: 1 to 4096 arguments without NUL, the first nonempty. */
export const Argv = v.array(
  v.string().max(MAX_ARG_BYTES).refine(noNul, "must not contain NUL").refine(
    argBytes,
    ARG_BYTES,
  ),
).min(1).max(4096).refine(
  (argv) => argv[0] !== "",
  "the command must not be empty",
);

/** A shell script for `sh -c`: one argument, so at most 120 KiB. */
export const Script = v.string().min(1).max(MAX_ARG_BYTES).refine(
  noNul,
  "must not contain NUL",
).refine(argBytes, ARG_BYTES);

/** Ids made of letters, digits, `_` and `-`. */
export const Id = v.string().regex(
  /^[A-Za-z0-9_-]{1,64}$/,
  "must be 1-64 of A-Z a-z 0-9 _ -",
);

// A timer's range: longer is refused, not silently cut to zero.
const Millis = v.int().positive().max(2_147_483_647);

/** A lease token as `acquireLease` makes them. */
export const LeaseToken = v.string().regex(
  /^[a-z2-7]{26}$/,
  "must be a lease token",
);

/** The workspace lease a mutating call holds (see `acquireLease`). */
const leaseShape = { lease: LeaseToken.optional() };

/** Options of a call whose only option is its lease. */
export const Leased = v.strictObject(leaseShape);

const commandShape = {
  cwd: v.string().optional(),
  env: Env.optional(),
  sessionId: Id.optional(),
};

const execShape = {
  ...commandShape,
  timeoutMs: Millis.optional(),
  maxOutputBytes: v.int().positive().max(2 ** 32).optional(),
  stdin: v.union([v.string(), v.bytes()]).optional(),
  combineOutput: v.boolean().optional(),
  ...leaseShape,
  mutates: v.boolean().optional(),
};

/** A token `cancel(token)` names an exec by; the client makes a random one. */
export const CancelToken = v.string().regex(
  /^[A-Za-z0-9_-]{16,64}$/,
  "must be 16-64 of A-Z a-z 0-9 _ -",
);

/** A signal in process, or a cancel token over RPC. */
const cancelShape = {
  signal: v.unknown().refine(
    (value) => value instanceof AbortSignal,
    "must be an AbortSignal",
  ).optional(),
  cancelToken: CancelToken.optional(),
};

/** Options of a direct `exec`: a signal in process, or a cancel token over RPC. */
export const ExecOptions = v.strictObject({
  ...execShape,
  ...cancelShape,
});

/** Options of a streamed exec, kept in its ticket: plain data only. */
export const StreamExecOptions = v.strictObject(execShape);

export const ProcessOptions = v.strictObject({
  ...commandShape,
  mutates: v.boolean().optional(),
  name: v.string().min(1).max(128).optional(),
  timeoutMs: Millis.optional(),
  ...leaseShape,
});

export const ReadFileOptions = v.strictObject({
  encoding: v.enum(["utf-8", "bytes"]).optional(),
  maxBytes: v.int().positive().max(2 ** 32).optional(),
  noFollow: v.boolean().optional(),
});

export const NoFollow = v.strictObject({ noFollow: v.boolean().optional() });

export const Mode = v.string().regex(/^[0-7]{3,4}$/, "must be octal, like 644");

export const WriteFileOptions = v.strictObject({
  encoding: v.enum(["utf-8", "base64"]).optional(),
  createParents: v.boolean().optional(),
  mode: Mode.optional(),
  ...leaseShape,
});

export const Content = v.union([v.string(), v.bytes()]);

export const Recursive = v.strictObject({
  recursive: v.boolean().optional(),
  ...leaseShape,
});

export const ListFilesOptions = v.strictObject({
  recursive: v.boolean().optional(),
  includeHidden: v.boolean().optional(),
  limit: v.int().positive().max(100_000).optional(),
  cursor: v.string().regex(
    /^\d{1,15}(\.[A-Za-z0-9_-]{1,16384})?$/,
    "must be a cursor from listFiles",
  ).optional(),
  sort: v.boolean().optional(),
  noFollow: v.boolean().optional(),
});

export const GitCheckoutOptions = v.strictObject({
  branch: v.string().regex(
    /^[A-Za-z0-9._\/-]{1,255}$/,
    "must be a plain branch or tag name",
  )
    .refine((name) => !name.startsWith("-"), "must not start with -")
    .optional(),
  depth: v.int().positive().max(1_000_000).optional(),
  targetDir: v.string().optional(),
  timeoutMs: Millis.optional(),
  unsafeSymlinks: v.boolean().optional(),
  ...leaseShape,
  ...cancelShape,
});

/** Only https URLs: no `file:`, `ext::` or ssh transports, no options. */
export const GitUrl = v.string().max(2048).regex(
  /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/%-]+$/,
  "must be an https URL of a repository",
);

export const Port = v.int().min(1).max(65535);

/** The longest a preview token lives: 30 days. */
export const MAX_PREVIEW_TTL_MS = 30 * 86_400_000;

const PreviewTtl = v.int().min(1).max(MAX_PREVIEW_TTL_MS);

export const ExposePortOptions = v.strictObject({
  name: v.string().min(1).max(64).optional(),
  ttlMs: PreviewTtl.optional(),
});

export const RotatePortOptions = v.strictObject({
  expectedToken: v.string().regex(/^[a-z2-7]{26}$/),
  ttlMs: PreviewTtl.optional(),
});

export const Signal = v.enum([
  "TERM",
  "KILL",
  "INT",
  "HUP",
  "QUIT",
  "USR1",
  "USR2",
]);

export const WaitForPortOptions = v.strictObject({
  timeoutMs: Millis.optional(),
  path: v.string().startsWith("/").max(2048).optional(),
});

export const WaitOptions = v.strictObject({ timeoutMs: Millis.optional() });

/** The longest lease: 10 minutes. */
export const MAX_LEASE_TTL_MS = 600_000;

export const LeaseOptions = v.strictObject({
  ttlMs: v.int().min(1).max(MAX_LEASE_TTL_MS).optional(),
});

export const ListProcessesOptions = v.strictObject({
  cursor: Id.optional(),
  limit: v.int().min(1).max(1000).optional(),
});

export const WaitForLogOptions = v.strictObject({
  timeoutMs: Millis.optional(),
  stream: v.enum(["stdout", "stderr", "both"]).optional(),
  regex: v.boolean().optional(),
});

const oneLine = (text: string) => !/[\0\n\r]/.test(text);

/** A literal `waitForLog` pattern: one line, at most 4 KiB. */
export const LiteralPattern = v.string().min(1).max(4096).refine(
  (text) => utf8Length(text) <= 4096,
  "must be at most 4096 bytes",
).refine(oneLine, "must be one line without NUL");

/** A `waitForLog` regular expression: one line, at most 256 bytes. */
export const RegexPattern = v.string().min(1).max(256).refine(
  (text) => utf8Length(text) <= 256,
  "must be at most 256 bytes",
).refine(oneLine, "must be one line without NUL");

export const EnvUpdate = v.record(EnvName, EnvValue.nullable());

export const SearchFilesOptions = v.strictObject({
  path: v.string().optional(),
  regex: v.boolean().optional(),
  ignoreCase: v.boolean().optional(),
  includeHidden: v.boolean().optional(),
  noFollow: v.boolean().optional(),
  maxMatches: v.int().min(1).max(100_000).optional(),
  maxOutputBytes: v.int().positive().max(2 ** 32).optional(),
  timeoutMs: Millis.optional(),
  ...cancelShape,
});

export const SessionOptions = v.strictObject({
  id: Id.optional(),
  cwd: v.string().optional(),
  env: Env.optional(),
});

export const SessionUpdate = v.strictObject({
  cwd: v.string().optional(),
  env: Env.optional(),
});

export const StreamRequest = v.discriminatedUnion("kind", [
  v.strictObject({
    kind: v.literal("exec"),
    argv: Argv,
    options: StreamExecOptions.optional(),
    bodyStdin: v.boolean().optional(),
  }).refine(
    (request) => !(request.bodyStdin && request.options?.stdin !== undefined),
    "stdin comes from the body or from options, not both",
  ),
  v.strictObject({
    kind: v.literal("shell"),
    script: Script,
    options: StreamExecOptions.optional(),
    bodyStdin: v.boolean().optional(),
  }).refine(
    (request) => !(request.bodyStdin && request.options?.stdin !== undefined),
    "stdin comes from the body or from options, not both",
  ),
  v.strictObject({
    kind: v.literal("logs"),
    processId: Id,
    fromStart: v.boolean().optional(),
  }),
  v.strictObject({ kind: v.literal("read"), path: v.string() }),
  v.strictObject({
    kind: v.literal("write"),
    path: v.string(),
    options: v.strictObject({
      createParents: v.boolean().optional(),
      mode: Mode.optional(),
      ...leaseShape,
    }).optional(),
  }),
]);

/** Parses `value`, throwing `SandboxError("invalid")` with every issue. */
export function parse<S extends AnySchema>(
  schema: S,
  value: unknown,
  what: string,
): Output<S> {
  try {
    return schema.parse(value) as Output<S>;
  } catch (error) {
    if (error instanceof SieveError) {
      const lines = error.issues.map((issue) =>
        issue.path.length === 0
          ? issue.message
          : `${issue.path.join(".")}: ${issue.message}`
      );
      throw new SandboxError("invalid", `${what}: ${lines.join("; ")}`);
    }
    throw error;
  }
}

/** Checked {@link ExecOptions}. */
export type ExecOptionsValue = Output<typeof ExecOptions>;

/** Checked {@link ProcessOptions}. */
export type ProcessOptionsValue = Output<typeof ProcessOptions>;
