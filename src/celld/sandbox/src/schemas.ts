// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation for every argument that crosses RPC, with `@celld/sieve`.
 * Objects are strict: an unknown option is a mistake worth hearing about,
 * not something to ignore.
 *
 * @module
 */

import { type AnySchema, type Output, SieveError, v } from "@celld/sieve";
import { SandboxError } from "./errors.ts";

const noNul = (text: string) => !text.includes("\0");

/** An environment variable name: a shell identifier. */
export const EnvName = v.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]{0,255}$/,
  "must be a shell identifier",
);

/** An environment variable value: no NUL, at most 128 KiB. */
export const EnvValue = v.string().max(128 * 1024).refine(
  noNul,
  "must not contain NUL",
);

/** A set of environment variables, at most 256 of them. */
export const Env = v.record(EnvName, EnvValue).refine(
  (env) => Object.keys(env).length <= 256,
  "at most 256 variables",
);

/** An argv: 1 to 4096 arguments without NUL, the first nonempty. */
export const Argv = v.array(
  v.string().max(128 * 1024).refine(noNul, "must not contain NUL"),
).min(1).max(4096).refine(
  (argv) => argv[0] !== "",
  "the command must not be empty",
);

/** A shell script for `sh -c`. */
export const Script = v.string().min(1).max(256 * 1024).refine(
  noNul,
  "must not contain NUL",
);

/** Ids made of letters, digits, `_` and `-`. */
export const Id = v.string().regex(
  /^[A-Za-z0-9_-]{1,64}$/,
  "must be 1-64 of A-Z a-z 0-9 _ -",
);

const Millis = v.int().positive();

const commandShape = {
  cwd: v.string().optional(),
  env: Env.optional(),
  sessionId: Id.optional(),
};

export const ExecOptions = v.strictObject({
  ...commandShape,
  timeoutMs: Millis.optional(),
  maxOutputBytes: v.int().positive().optional(),
  stdin: v.union([v.string(), v.bytes()]).optional(),
  combineOutput: v.boolean().optional(),
});

export const ProcessOptions = v.strictObject({
  ...commandShape,
  name: v.string().min(1).max(128).optional(),
  timeoutMs: Millis.optional(),
});

export const ReadFileOptions = v.strictObject({
  encoding: v.enum(["utf-8", "bytes"]).optional(),
  maxBytes: v.int().positive().optional(),
});

export const Mode = v.string().regex(/^[0-7]{3,4}$/, "must be octal, like 644");

export const WriteFileOptions = v.strictObject({
  encoding: v.enum(["utf-8", "base64"]).optional(),
  createParents: v.boolean().optional(),
  mode: Mode.optional(),
});

export const Content = v.union([v.string(), v.bytes()]);

export const Recursive = v.strictObject({ recursive: v.boolean().optional() });

export const ListFilesOptions = v.strictObject({
  recursive: v.boolean().optional(),
  includeHidden: v.boolean().optional(),
  limit: v.int().positive().max(100_000).optional(),
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
});

/** Only https URLs: no `file:`, `ext::` or ssh transports, no options. */
export const GitUrl = v.string().max(2048).regex(
  /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/%-]+$/,
  "must be an https URL of a repository",
);

export const Port = v.int().min(1).max(65535);

export const ExposePortOptions = v.strictObject({
  name: v.string().min(1).max(64).optional(),
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

export const WaitForLogOptions = v.strictObject({
  timeoutMs: Millis.optional(),
  stream: v.enum(["stdout", "stderr", "both"]).optional(),
});

export const EnvUpdate = v.record(EnvName, EnvValue.nullable());

export const SessionOptions = v.strictObject({
  id: Id.optional(),
  cwd: v.string().optional(),
  env: Env.optional(),
});

export const StreamRequest = v.discriminatedUnion("kind", [
  v.strictObject({
    kind: v.literal("exec"),
    argv: Argv,
    options: ExecOptions.optional(),
  }),
  v.strictObject({
    kind: v.literal("shell"),
    script: Script,
    options: ExecOptions.optional(),
  }),
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
