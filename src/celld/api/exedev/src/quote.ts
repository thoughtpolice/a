// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Quoting for the two parsers a command passes through.
 *
 * The body of `POST /exec` is a command line, which the lobby splits with a
 * shell lexer: whitespace separates words, single quotes are literal, double
 * quotes allow `\"`, `\\`, `` \` `` and `\$`, and a backslash outside quotes
 * escapes the next character. It expands nothing (`${X}` stays as written).
 * `ssh <vm> <command...>` then hands the rest to the VM, which parses it
 * again with a shell. {@link quoteArg} is the same function exe.dev's docs
 * use for their interactive quoter, so its output is what the lobby expects,
 * and {@link splitCommandLine} is the lexer it targets (the test fake uses
 * it, and the tests check the two round-trip).
 *
 * Nothing here expands or interprets anything, so caller data can never turn
 * into extra words or flags: every value becomes exactly one word.
 *
 * @module
 */

import type { Issue } from "./json.ts";

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quotes one word so a POSIX shell lexer (the lobby's, or the VM shell's)
 * reads it back unchanged: bare when it only has safe characters, `''` when
 * empty, in double quotes when it holds a `'` but nothing special to double
 * quotes, and in single quotes (with `'\''` for each `'`) otherwise.
 */
export function quoteArg(word: string): string {
  if (word === "") return "''";
  if (SAFE.test(word)) return word;
  if (word.includes("'")) {
    return /["\\$`]/.test(word)
      ? `'${word.replace(/'/g, "'\\''")}'`
      : `"${word}"`;
  }
  return `'${word}'`;
}

/** Joins words into one command line, quoting each with {@link quoteArg}. */
export function joinCommandLine(words: readonly string[]): string {
  return words.map(quoteArg).join(" ");
}

/** The result of {@link splitCommandLine}. */
export type SplitResult =
  | { readonly ok: true; readonly words: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Splits a command line the way the lobby's shell lexer does (see the module
 * notes). An unbalanced quote or a trailing backslash is an error, which the
 * lobby answers with 400.
 */
export function splitCommandLine(line: string): SplitResult {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      i++;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { ok: false, message: "unbalanced single quote" };
      word += line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= line.length) {
          return { ok: false, message: "unbalanced double quote" };
        }
        const d = line[i];
        if (d === '"') {
          i++;
          break;
        }
        if (
          d === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])
        ) {
          if (line[i + 1] !== "\n") word += line[i + 1];
          i += 2;
          continue;
        }
        word += d;
        i++;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= line.length) {
        return { ok: false, message: "trailing backslash" };
      }
      if (line[i + 1] !== "\n") word += line[i + 1];
      i += 2;
      continue;
    }
    word += c;
    i++;
  }
  if (inWord) words.push(word);
  return { ok: true, words };
}

/**
 * Problems with a word that will travel in the lobby's command line: a NUL,
 * carriage return or newline. The HTTPS API reads one command line, and how
 * the lobby treats a line break inside quotes is not documented, so these are
 * refused rather than guessed at. Text that needs them (scripts) is sent
 * base64-encoded instead; see {@link scriptCommand}.
 */
export function lobbyWordIssues(word: string, path: Issue["path"]): Issue[] {
  if (/[\0\r\n]/.test(word)) {
    return [{
      path,
      message: "must not contain NUL, carriage return or newline",
    }];
  }
  return [];
}

/**
 * A POSIX shell command line for the VM that runs `argv` as one command,
 * each element quoted to arrive as exactly one argument.
 */
export function vmArgvCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new RangeError("argv must not be empty");
  return joinCommandLine(argv);
}

/** Standard base64 of UTF-8 text or bytes (no line breaks). */
export function base64Encode(data: string | Uint8Array): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Decodes standard or URL-safe base64, with or without padding. */
export function base64Decode(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** How to run a script on the VM. */
export interface ScriptOptions {
  /** The interpreter; default `sh`. Anything that accepts `-c` works. */
  readonly interpreter?: string;
  /** Arguments, available as `$1`, `$2`, ... inside the script. */
  readonly args?: readonly string[];
  /** `$0` inside the script; default `exedev-script`. */
  readonly name?: string;
}

/**
 * A VM command line that runs `script` (any text, newlines and quotes
 * included) under `interpreter -c`. The script travels base64-encoded, so it
 * crosses both parsers as safe characters only, and is decoded on the VM with
 * `base64 -d` (coreutils, present on exeuntu). Trailing newlines of the
 * script are dropped by the shell's `$(...)`, which is harmless for scripts.
 */
export function scriptCommand(
  script: string,
  options: ScriptOptions = {},
): string {
  const interpreter = options.interpreter ?? "sh";
  const encoded = base64Encode(script);
  return [
    quoteArg(interpreter),
    "-c",
    `"$(printf %s ${encoded} | base64 -d)"`,
    quoteArg(options.name ?? "exedev-script"),
    ...(options.args ?? []).map(quoteArg),
  ].join(" ");
}

/**
 * The lobby command line for `ssh <vm> <vmCommand>`: the VM's command line
 * becomes one quoted lobby word, which the lobby hands to the VM whole. A
 * command starting with `-` gets a leading space so the lobby cannot read it
 * as an `ssh` flag (the VM's shell ignores the space).
 */
export function sshCommandLine(
  vm: string,
  vmCommand: string,
  user?: string,
): string {
  const target = user === undefined ? vm : `${user}@${vm}`;
  const command = vmCommand.startsWith("-") ? ` ${vmCommand}` : vmCommand;
  return `ssh ${quoteArg(target)} ${quoteArg(command)}`;
}
