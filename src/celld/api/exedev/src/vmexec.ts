// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Running commands on a VM through `POST /exec` with `ssh <vm> <command>`.
 *
 * The response body is the command's stdout and stderr combined, and the docs
 * put the exit code in an `X-Exe-Exit` HTTP **trailer**. `fetch` does not
 * expose trailers (not in Deno, not in Workers, not in browsers), so a client
 * built on `fetch` cannot read it unless a server also sends it as a header.
 * The default here is therefore an **exit marker**: the VM command becomes
 *
 * ```sh
 * ( <command> ) </dev/null; rc=$?; printf '\n<marker>%s\n' "$rc"; exit "$rc"
 * ```
 *
 * and the client strips the marker line from the end of the output and reads
 * the status from it. The marker holds a random nonce, so output cannot fake
 * it. The wrapper exits with the command's status, so an `X-Exe-Exit` the
 * server reports (as a header, when it sends one) is the command's too, and
 * the two must agree. Commands still get EOF on stdin (`/exec` has
 * no stdin) and run under the VM user's shell, which on exeuntu is POSIX.
 *
 * @module
 */

import {
  quoteArg,
  scriptCommand,
  type ScriptOptions,
  vmArgvCommand,
} from "./quote.ts";

/**
 * A command for the VM:
 *
 * - an argv array (or `{argv}`): each element arrives as one argument;
 * - `{script}`: any text, run by an interpreter (sent base64-encoded);
 * - `{shell}`: a VM shell command line you have quoted yourself.
 */
export type VmCommand =
  | readonly string[]
  | { readonly argv: readonly string[] }
  | ({ readonly script: string } & ScriptOptions)
  | { readonly shell: string };

/** The VM shell command line for a {@link VmCommand}. */
export function vmShellCommand(command: VmCommand): string {
  if (Array.isArray(command)) return vmArgvCommand(command);
  const object = command as Exclude<VmCommand, readonly string[]>;
  if ("argv" in object) return vmArgvCommand(object.argv);
  if ("script" in object) return scriptCommand(object.script, object);
  if ("shell" in object) {
    if (object.shell.trim() === "") {
      throw new RangeError("shell must not be empty");
    }
    return object.shell;
  }
  throw new TypeError(
    "a VmCommand is an argv array, {argv}, {script} or {shell}",
  );
}

const MARKER = /^[A-Za-z0-9_]{8,64}$/;

/** A fresh exit marker: `__EXE_EXIT_<24 random hex digits>__`. */
export function newExitMarker(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `__EXE_EXIT_${
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }__`;
}

/**
 * Wraps a VM command line so it reports its exit status after its output
 * (see the module notes). `marker` must be 8 to 64 of `[A-Za-z0-9_]`.
 */
export function withExitMarker(vmCommand: string, marker: string): string {
  if (!MARKER.test(marker)) {
    throw new RangeError("the marker must be 8-64 of [A-Za-z0-9_]");
  }
  return `( ${vmCommand} ) </dev/null; rc=$?; printf '\\n${marker}%s\\n' "$rc"; exit "$rc"`;
}

/** The output with the marker line removed, and the status it carried. */
export interface MarkedOutput {
  readonly output: Uint8Array;
  /** The status, or null when the marker was not found (the VM never ran it). */
  readonly exitCode: number | null;
}

/** Finds and removes the trailing exit marker in `output`. */
export function parseExitMarker(
  output: Uint8Array,
  marker: string,
): MarkedOutput {
  const needle = new TextEncoder().encode(`\n${marker}`);
  outer: for (let start = output.length - needle.length; start >= 0; start--) {
    for (let i = 0; i < needle.length; i++) {
      if (output[start + i] !== needle[i]) continue outer;
    }
    let end = start + needle.length;
    let digits = "";
    while (end < output.length && output[end] >= 0x30 && output[end] <= 0x39) {
      digits += String.fromCharCode(output[end]);
      end++;
    }
    if (digits === "" || digits.length > 3) continue;
    if (end < output.length && output[end] === 0x0a) end++;
    if (end !== output.length) continue;
    return { output: output.slice(0, start), exitCode: Number(digits) };
  }
  return { output, exitCode: null };
}

/** How to detach a command from the request. */
export interface DetachOptions {
  /** Where stdout and stderr go; default `/dev/null`. */
  readonly log?: string;
  /**
   * A file that receives the exit status when the command finishes (written
   * to `<file>.tmp` and renamed, so a reader never sees a partial write).
   */
  readonly statusFile?: string;
}

/**
 * A VM command line that starts `vmCommand` in its own session with
 * `setsid nohup`, as the docs suggest, and prints its process id at once.
 */
export function detachedCommand(
  vmCommand: string,
  options: DetachOptions = {},
): string {
  let inner = vmCommand;
  if (options.statusFile !== undefined) {
    const file = quoteArg(options.statusFile);
    const tmp = quoteArg(`${options.statusFile}.tmp`);
    inner =
      `( ${vmCommand} ); rc=$?; echo "$rc" > ${tmp}; mv -f ${tmp} ${file}`;
  }
  return `setsid nohup sh -c ${quoteArg(inner)} > ${
    quoteArg(options.log ?? "/dev/null")
  } 2>&1 < /dev/null & echo $!`;
}
