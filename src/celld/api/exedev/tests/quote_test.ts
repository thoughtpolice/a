// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  base64Decode,
  base64Encode,
  detachedCommand,
  joinCommandLine,
  lobbyWordIssues,
  newExitMarker,
  parseExitMarker,
  quoteArg,
  scriptCommand,
  splitCommandLine,
  sshCommandLine,
  vmArgvCommand,
  vmShellCommand,
  withExitMarker,
} from "@celld/api/exedev";

function split(line: string): string[] {
  const result = splitCommandLine(line);
  if (!result.ok) throw new Error(`${line}: ${result.message}`);
  return result.words;
}

Deno.test("quoteArg matches the docs' quoter on its own examples", () => {
  // The examples of the command-quoter on https://exe.dev/docs/https-api-run-on-vm.
  const cases: [string, string][] = [
    ["whoami", "ssh my-vm whoami"],
    ["cd /srv && ls | head -3", "ssh my-vm 'cd /srv && ls | head -3'"],
    ["echo 'hello world'", `ssh my-vm "echo 'hello world'"`],
    [
      `printf '%s\\n' "it's ready"`,
      `ssh my-vm 'printf '\\''%s\\n'\\'' "it'\\''s ready"'`,
    ],
    [
      "setsid nohup ./build.sh > /tmp/build.log 2>&1 & echo started",
      "ssh my-vm 'setsid nohup ./build.sh > /tmp/build.log 2>&1 & echo started'",
    ],
  ];
  for (const [command, lobby] of cases) {
    assertEquals(sshCommandLine("my-vm", command), lobby, command);
  }
});

Deno.test("quoteArg leaves safe words bare and quotes everything else", () => {
  assertEquals(quoteArg(""), "''");
  assertEquals(quoteArg("--name=web-0"), "--name=web-0");
  assertEquals(quoteArg("a@b.com:8080/x,y+z%"), "a@b.com:8080/x,y+z%");
  assertEquals(quoteArg("two words"), "'two words'");
  assertEquals(quoteArg("${HOME}"), "'${HOME}'");
  assertEquals(quoteArg("it's"), `"it's"`);
  assertEquals(quoteArg(`it's "$x"`), `'it'\\''s "$x"'`);
  assertEquals(quoteArg("naïve"), "'naïve'");
});

Deno.test("splitCommandLine follows POSIX lexing without expansion", () => {
  assertEquals(split("  ls   -l\tweb-0  "), ["ls", "-l", "web-0"]);
  assertEquals(split(`a'b c'"d e"\\ f`), ["ab cd e f"]);
  assertEquals(split(`"\\$HOME \\"q\\" \\\\ \\x"`), [`$HOME "q" \\ \\x`]);
  assertEquals(split("'${X}' $Y"), ["${X}", "$Y"]);
  assertEquals(split("''"), [""]);
  assertEquals(split(""), []);
  for (const bad of ["'open", '"open', "trailing\\"]) {
    assert(!splitCommandLine(bad).ok, bad);
  }
});

Deno.test("every string survives quoteArg then the lexer (generated cases)", () => {
  const alphabet = [
    "a",
    "Z",
    "0",
    " ",
    "\t",
    "'",
    '"',
    "\\",
    "$",
    "`",
    "!",
    "*",
    "?",
    "&",
    ";",
    "|",
    "<",
    ">",
    "(",
    ")",
    "{",
    "}",
    "#",
    "~",
    "=",
    "-",
    "é",
    "日",
    "😀",
    "%",
    ",",
  ];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  for (let i = 0; i < 2000; i++) {
    const length = next() % 12;
    const word = Array.from(
      { length },
      () => alphabet[next() % alphabet.length],
    ).join("");
    assertEquals(split(quoteArg(word)), [word], JSON.stringify(word));
  }
});

Deno.test("joinCommandLine keeps each word one word", () => {
  const words = [
    "comment",
    "web-0",
    "staging copy; rm -rf /",
    "--root",
    "",
    "a'b",
  ];
  assertEquals(split(joinCommandLine(words)), words);
});

Deno.test("an argv survives both the lobby and the VM shell", () => {
  const argv = [
    "printf",
    "%s\\n",
    "it's $HOME",
    "a b",
    "--flag",
    "`id`",
    "",
    "*",
  ];
  const lobby = split(sshCommandLine("web-0", vmArgvCommand(argv)));
  assertEquals(lobby.length, 3);
  assertEquals(lobby.slice(0, 2), ["ssh", "web-0"]);
  assertEquals(split(lobby[2]), argv);
});

Deno.test("sshCommandLine puts the user in the target and guards a leading dash", () => {
  assertEquals(sshCommandLine("web-0", "id", "root"), "ssh root@web-0 id");
  const words = split(sshCommandLine("web-0", "-v"));
  assertEquals(words, ["ssh", "web-0", " -v"]);
});

Deno.test("scriptCommand ships any text base64-encoded", () => {
  const script = "#!/bin/sh\necho \"it's $1\"\nprintf '%s\\n' 'done'\n";
  const line = scriptCommand(script, {
    interpreter: "bash",
    args: ["a b"],
    name: "setup",
  });
  assert(!/[\r\n]/.test(line), "one line");
  const words = split(line);
  assertEquals(words[0], "bash");
  assertEquals(words[1], "-c");
  const match = /^\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)$/.exec(
    words[2],
  );
  assert(match !== null, words[2]);
  assertEquals(new TextDecoder().decode(base64Decode(match[1])), script);
  assertEquals(words.slice(3), ["setup", "a b"]);
  // And the lobby layer.
  assertEquals(split(split(sshCommandLine("vm", line))[2]), words);
});

Deno.test("base64 helpers round-trip bytes and accept URL-safe input", () => {
  const bytes = new Uint8Array(
    Array.from({ length: 300 }, (_, i) => (i * 37) % 256),
  );
  assertEquals(base64Decode(base64Encode(bytes)), bytes);
  assertEquals(base64Decode("-_8"), new Uint8Array([0xfb, 0xff]));
});

Deno.test("lobby words may not carry NUL, CR or LF", () => {
  assertEquals(lobbyWordIssues("fine words", ["x"]), []);
  for (const bad of ["a\nb", "a\rb", "a\0b"]) {
    assertEquals(lobbyWordIssues(bad, ["x"]).length, 1, JSON.stringify(bad));
  }
});

Deno.test("vmShellCommand accepts argv, {argv}, {script} and {shell}", () => {
  assertEquals(vmShellCommand(["echo", "a b"]), "echo 'a b'");
  assertEquals(vmShellCommand({ argv: ["id"] }), "id");
  assertEquals(vmShellCommand({ shell: "ls | wc -l" }), "ls | wc -l");
  assert(vmShellCommand({ script: "echo hi" }).startsWith("sh -c "), "script");
  for (const bad of [[], { shell: "  " }]) {
    try {
      vmShellCommand(bad as never);
      throw new Error("accepted");
    } catch (error) {
      assert(error instanceof RangeError, String(error));
    }
  }
});

Deno.test("exit markers wrap the command and parse back out of the output", () => {
  const marker = "__EXE_EXIT_0123456789abcdef__";
  const wrapped = withExitMarker("make test", marker);
  assertEquals(
    wrapped,
    `( make test ) </dev/null; rc=$?; printf '\\n${marker}%s\\n' "$rc"; exit "$rc"`,
  );
  const encode = (text: string) => new TextEncoder().encode(text);
  const cases: [string, string, number | null][] = [
    [`ok\n\n${marker}0\n`, "ok\n", 0],
    [`no newline\n${marker}2\n`, "no newline", 2],
    [`\n${marker}127`, "", 127],
    [`fake ${marker}9\nreal\n\n${marker}1\n`, `fake ${marker}9\nreal\n`, 1],
    [`truncated output`, "truncated output", null],
    [`\n${marker}\n`, `\n${marker}\n`, null],
    [`\n${marker}1234\n`, `\n${marker}1234\n`, null],
  ];
  for (const [output, text, code] of cases) {
    const parsed = parseExitMarker(encode(output), marker);
    assertEquals([new TextDecoder().decode(parsed.output), parsed.exitCode], [
      text,
      code,
    ], JSON.stringify(output));
  }
  assert(/^__EXE_EXIT_[0-9a-f]{24}__$/.test(newExitMarker()), "fresh marker");
  assert(newExitMarker() !== newExitMarker(), "random");
  try {
    withExitMarker("x", "bad marker!");
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof RangeError, String(error));
  }
});

Deno.test("detachedCommand uses setsid nohup and can record a status file", () => {
  assertEquals(
    detachedCommand("./build.sh", { log: "/tmp/build.log" }),
    "setsid nohup sh -c ./build.sh > /tmp/build.log 2>&1 < /dev/null & echo $!",
  );
  const line = detachedCommand("make all", { statusFile: "/tmp/s" });
  const words = split(line);
  assertEquals(words.slice(0, 3), ["setsid", "nohup", "sh"]);
  assertEquals(
    words[4],
    '( make all ); rc=$?; echo "$rc" > /tmp/s.tmp; mv -f /tmp/s.tmp /tmp/s',
  );
});
