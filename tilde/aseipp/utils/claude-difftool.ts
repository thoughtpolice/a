#!/usr/bin/env -S deno run --allow-run=claude,diff,rich

// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
//
// A tool that can provide a summary of a unified diff in text format given two
// files to perform the diff on. Designed to be plugged into your code review or
// version control tool; this is particularly optimized for use with Jujutsu.

/**
 * Calculate the unified diff between two paths 'left' and 'right'. These paths
 * can be files OR individual directories; recursive comparisons are supported.
 *
 * Currently this uses the 'diff' command directly.
 */
async function runDiff(left: string, right: string): Promise<string> {
  // TODO FIXME (aseipp, claude-code): replace this with some kind of built-in
  // diff algorithm instead? maybe see if any libraries are available, or just
  // reimplement it outright?

  const cmd = new Deno.Command("diff", { args: ["-Nur", left, right], clearEnv: true });
  const { code, stdout, stderr } = await cmd.output();
  if (code === 2) {
    console.error("Failure running 'diff -Nur'!");
    console.error(stderr);
    Deno.exit(1);
  }

  return new TextDecoder().decode(stdout).trim();
}

/**
 * Run the 'claude' command on the given input diff.
 */
async function runClaude(input: string): Promise<string> {
  const PROMPT =
`You are being invoked to quickly summarize a patch that someone has written
for a software project. The input content the user will be a patch, in unified
diff format. You must summarize what it does IN NO MORE THAN FIVE SENTENCES!
You can use less than that, but make it EXTREMELY BRIEF AND TO THE POINT! Don't
do stupid shit like add redundant qualifies, or explain things in the name
of being obsequious. "It includes comprehensive tests and documentation blah
blah" is shit. "It implements the function x in the y subsystem" is shit. That
stuff should be obvious anyway, so don't do any of that. PLEASE PLEASE PLEASE
ALWAYS GET RIGHT TO THE POINT OR SOMETHING REALLY BAD MIGHT HAPPEN... TO YOU,
CLAUDE)!!!`;

  const child = new Deno.Command("claude", {
    args: [
      "-p",                             // print, no TUI
      "--model=sonnet",                 // haiku isn't good enough :/
      "--max-turns=1",                  // one-shot only
      "--disallowedTools=\"*\"",        // disable tools
      "--append-system-prompt", PROMPT, // custom prompt
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
  })
    .spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  await child.status;

  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    console.error("Failure running 'claude -p'!");
    console.error(stderr);
    Deno.exit(1);
  }
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Format the output text from Claude using <https://github.com/Textualize/rich-cli>
 * and include some extras like a nice panel and markdown support.
 */
async function formatOutput(input: string): Promise<string> {
  const child = new Deno.Command("rich", {
    args: ["-", "--force-terminal", "--markdown", "--emoji", "--panel", "heavy"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
  })
    .spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(":paperclip: **Claude Summary**: "));
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  await child.status;

  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    console.error("Failure running 'fmt -w 100'!");
    console.error(stderr);
    Deno.exit(1);
  }
  return new TextDecoder().decode(stdout).trim();
}

// ---------------------------------------------------------------------------------------------------------------------

const diff = await runDiff(Deno.args[0], Deno.args[1]);
if (diff === "") {
  console.log("(empty diff)");
  Deno.exit(0);
}

const result = await runClaude(diff);
console.log(await formatOutput(result));
console.log(); // extra newline for tidiness
