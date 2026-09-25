// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Building lobby command lines from typed input.
 *
 * {@link buildCommand} is the one place caller data becomes a command line,
 * and it keeps each value to exactly one word of the command it belongs to:
 *
 * - every word is quoted with `quoteArg`, so spaces, quotes and `$` are data;
 * - flag values are attached (`--name=value`), so a value such as `--root`
 *   can never be read as a flag of its own;
 * - positional arguments that start with `-` are refused, since the lobby
 *   accepts flags anywhere on the line and would read them as flags;
 * - NUL, CR and LF are refused anywhere, since the API takes one line;
 * - flags must be ones the catalog documents for that command, unless the
 *   caller passes them through `extraFlags` on purpose;
 * - credential flags may not be `-` (read from stdin), because `/exec` has no
 *   stdin.
 *
 * Flags go before positional arguments, which is what both styles of flag
 * parser accept.
 *
 * @module
 */

import { type CommandSpec, commandSpec, type FlagSpec } from "./catalog.ts";
import { ExeInvalidRequestError } from "./errors.ts";
import type { Issue } from "./json.ts";
import { joinCommandLine, lobbyWordIssues, quoteArg } from "./quote.ts";

/** The largest `/exec` body the server accepts: 64 KiB. */
export const MAX_BODY_BYTES = 64 * 1024;

/** A flag's value: a switch, a value, or repeated values. */
export type FlagValue =
  | boolean
  | string
  | number
  | readonly (string | number)[]
  | null
  | undefined;

/** What {@link buildCommand} takes. */
export interface CommandInput {
  /** A catalog command path, such as `"share add"`. */
  readonly path: string;
  /** Positional arguments, in order. */
  readonly args?: readonly (string | number)[];
  /** Documented flags, keyed as written (`"--name"`, `"-d"`). */
  readonly flags?: Readonly<Record<string, FlagValue>>;
  /**
   * Flags the catalog does not list for this command, passed through
   * deliberately (new server features, catalog-only integration flags).
   */
  readonly extraFlags?: Readonly<Record<string, FlagValue>>;
  /** Overrides the catalog's idempotency, e.g. for a read-only form. */
  readonly idempotent?: boolean;
  /** Indices of `args` to hide in error messages and logs. */
  readonly secretArgs?: readonly number[];
  /** Flags to hide in error messages and logs, besides credential flags. */
  readonly secretFlags?: readonly string[];
  /** Allow `args` entries that are empty strings (e.g. clearing a comment). */
  readonly allowEmptyArgs?: boolean;
}

/** A validated command, ready to send. */
export interface Command {
  /** The canonical command path. */
  readonly path: string;
  /** Every word, unquoted: path words, flags, then positional arguments. */
  readonly words: readonly string[];
  /** The command line: the words quoted and joined. */
  readonly line: string;
  /** The line with secrets replaced by `***`, for messages and logs. */
  readonly redacted: string;
  /** Whether repeating it cannot change anything, so it may be retried. */
  readonly idempotent: boolean;
}

const FLAG_NAME = /^-{1,2}[a-z0-9][a-z0-9-]*$/;

function flagWords(
  name: string,
  value: FlagValue,
  spec: FlagSpec | undefined,
  issues: Issue[],
  secret: boolean,
): { words: string[]; shown: string[] } {
  const words: string[] = [];
  const shown: string[] = [];
  if (!FLAG_NAME.test(name)) {
    issues.push({ path: ["flags", name], message: "not a flag name" });
    return { words, shown };
  }
  if (value === undefined || value === null || value === false) {
    return { words, shown };
  }
  const takesValue = spec?.value ?? typeof value !== "boolean";
  if (value === true) {
    if (takesValue) {
      issues.push({ path: ["flags", name], message: "needs a value" });
    } else {
      words.push(name);
      shown.push(name);
    }
    return { words, shown };
  }
  if (!takesValue) {
    issues.push({ path: ["flags", name], message: "is a switch; pass true" });
    return { words, shown };
  }
  const values = Array.isArray(value) ? value : [value as string | number];
  if (values.length > 1 && spec !== undefined && !spec.repeatable) {
    issues.push({ path: ["flags", name], message: "may be given only once" });
    return { words, shown };
  }
  values.forEach((item, index) => {
    const path = Array.isArray(value)
      ? ["flags", name, index]
      : ["flags", name];
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        issues.push({ path, message: "must be a finite number" });
        return;
      }
    } else if (typeof item !== "string") {
      issues.push({ path, message: "must be a string or number" });
      return;
    }
    const text = String(item);
    issues.push(...lobbyWordIssues(text, path));
    if (spec?.credential && text === "-") {
      issues.push({
        path,
        message:
          "the HTTPS API has no stdin, so '-' cannot be used; pass the value",
      });
    }
    words.push(`${name}=${text}`);
    shown.push(secret ? `${name}=***` : `${name}=${text}`);
  });
  return { words, shown };
}

/**
 * Validates `input` against the catalog and returns the command line.
 *
 * @throws {ExeInvalidRequestError} with every problem found.
 */
export function buildCommand(input: CommandInput): Command {
  const issues: Issue[] = [];
  const spec: CommandSpec | undefined = commandSpec(input.path);
  if (spec === undefined) {
    throw new ExeInvalidRequestError([{
      path: ["path"],
      message: `unknown command ${JSON.stringify(input.path)}`,
    }]);
  }
  const words = input.path.split(" ");
  const shown = [...words];
  const secretFlags = new Set(input.secretFlags ?? []);
  for (const [name, value] of Object.entries(input.flags ?? {})) {
    const flag = spec.flags[name];
    if (flag === undefined) {
      issues.push({
        path: ["flags", name],
        message:
          `${input.path} has no documented flag ${name}; use extraFlags to pass it anyway`,
      });
      continue;
    }
    const secret = flag.credential === true || secretFlags.has(name);
    const rendered = flagWords(name, value, flag, issues, secret);
    words.push(...rendered.words);
    shown.push(...rendered.shown);
  }
  for (const [name, value] of Object.entries(input.extraFlags ?? {})) {
    const flag = spec.flags[name];
    const secret = flag?.credential === true || secretFlags.has(name);
    const rendered = flagWords(name, value, flag, issues, secret);
    words.push(...rendered.words);
    shown.push(...rendered.shown);
  }
  const secretArgs = new Set(input.secretArgs ?? []);
  (input.args ?? []).forEach((arg, index) => {
    const path = ["args", index];
    if (typeof arg === "number") {
      if (!Number.isFinite(arg)) {
        issues.push({ path, message: "must be a finite number" });
        return;
      }
    } else if (typeof arg !== "string") {
      issues.push({ path, message: "must be a string or number" });
      return;
    }
    const text = String(arg);
    if (text === "" && !input.allowEmptyArgs) {
      issues.push({ path, message: "must not be empty" });
    }
    if (text.startsWith("-")) {
      issues.push({
        path,
        message:
          "must not start with '-', or the lobby would read it as a flag",
      });
    }
    issues.push(...lobbyWordIssues(text, path));
    words.push(text);
    shown.push(secretArgs.has(index) ? "***" : text);
  });
  if (issues.length > 0) throw new ExeInvalidRequestError(issues);
  const line = joinCommandLine(words);
  checkBodySize(line);
  return {
    path: input.path,
    words,
    line,
    redacted: shown.map((word) =>
      /^(-{1,2}[a-z0-9-]+=)?\*\*\*$/.test(word) ? word : quoteArg(word)
    )
      .join(" "),
    idempotent: input.idempotent ?? spec.idempotent,
  };
}

/** Refuses a command line over the server's 64 KiB body limit. */
export function checkBodySize(line: string): void {
  const bytes = new TextEncoder().encode(line).length;
  if (bytes > MAX_BODY_BYTES) {
    throw new ExeInvalidRequestError([{
      path: [],
      message:
        `the command is ${bytes} bytes; the HTTPS API accepts at most ${MAX_BODY_BYTES}`,
    }]);
  }
  if (line.trim() === "") {
    throw new ExeInvalidRequestError([{
      path: [],
      message: "the command is empty",
    }]);
  }
}

/**
 * A command from a line the caller already quoted, for commands or forms the
 * catalog does not cover. It is checked for size and line breaks only, and
 * is never retried unless `idempotent` says so.
 */
export function rawCommand(
  line: string,
  options: { readonly idempotent?: boolean; readonly path?: string } = {},
): Command {
  const issues = lobbyWordIssues(line, []);
  if (issues.length > 0) throw new ExeInvalidRequestError(issues);
  checkBodySize(line);
  return {
    path: options.path ?? line.trim().split(/\s+/)[0],
    words: [],
    line,
    redacted: line,
    idempotent: options.idempotent ?? false,
  };
}
