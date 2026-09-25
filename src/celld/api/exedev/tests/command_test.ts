// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  buildCommand,
  catalogDrift,
  COMMANDS,
  commandSpec,
  ExeInvalidRequestError,
  MAX_BODY_BYTES,
  rawCommand,
  resolveCommand,
  splitCommandLine,
  TOP_LEVEL_COMMANDS,
} from "@celld/api/exedev";

function refused(build: () => unknown): string[] {
  try {
    build();
  } catch (error) {
    if (error instanceof ExeInvalidRequestError) {
      return error.issues.map((issue) =>
        `${issue.path.join(".")}: ${issue.message}`
      );
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

Deno.test("buildCommand puts flags before arguments and attaches values", () => {
  const command = buildCommand({
    path: "share add",
    args: ["web-0", "alice@example.com"],
    flags: { "--root": true, "--message": "hi there", "--qr": false },
  });
  assertEquals(command.words, [
    "share",
    "add",
    "--root",
    "--message=hi there",
    "web-0",
    "alice@example.com",
  ]);
  assertEquals(
    command.line,
    "share add --root '--message=hi there' web-0 alice@example.com",
  );
  assertEquals(command.idempotent, false);
  assertEquals(splitCommandLine(command.line), {
    ok: true,
    words: [...command.words],
  });
});

Deno.test("repeatable flags repeat; others refuse lists", () => {
  const command = buildCommand({
    path: "new",
    flags: { "--tag": ["a", "b"], "--env": ["X=1"] },
  });
  assertEquals(command.words, ["new", "--tag=a", "--tag=b", "--env=X=1"]);
  assertEquals(
    refused(() =>
      buildCommand({ path: "new", flags: { "--name": ["a", "b"] } })
    ),
    [
      "flags.--name: may be given only once",
    ],
  );
});

Deno.test("caller data cannot become flags or extra words", () => {
  assertEquals(refused(() => buildCommand({ path: "rm", args: ["--all"] })), [
    "args.0: must not start with '-', or the lobby would read it as a flag",
  ]);
  const sneaky = buildCommand({
    path: "comment",
    args: ["web-0", "x --root; rm y"],
  });
  assertEquals(splitCommandLine(sneaky.line), {
    ok: true,
    words: ["comment", "web-0", "x --root; rm y"],
  });
  const value = buildCommand({ path: "new", flags: { "--name": "--root" } });
  assertEquals(value.words, ["new", "--name=--root"]);
  assertEquals(
    refused(() =>
      buildCommand({ path: "comment", args: ["web-0", "two\nlines"] })
    ),
    [
      "args.1: must not contain NUL, carriage return or newline",
    ],
  );
});

Deno.test("undocumented flags need extraFlags; bad names never pass", () => {
  assertEquals(
    refused(() => buildCommand({ path: "ls", flags: { "--all": true } })),
    [
      "flags.--all: ls has no documented flag --all; use extraFlags to pass it anyway",
    ],
  );
  const extra = buildCommand({
    path: "integrations add",
    args: ["stripe"],
    flags: { "--name": "pay" },
    extraFlags: { "--base-url": "https://x" },
  });
  assertEquals(extra.words.slice(-2), ["--base-url=https://x", "stripe"]);
  assertEquals(
    refused(() => buildCommand({ path: "ls", extraFlags: { "--a b": true } })),
    ["flags.--a b: not a flag name"],
  );
  assertEquals(
    refused(() => buildCommand({ path: "ls", extraFlags: { "x": "1" } })),
    ["flags.x: not a flag name"],
  );
});

Deno.test("switches and value flags are checked for their kind", () => {
  assertEquals(
    refused(() => buildCommand({ path: "new", flags: { "--name": true } })),
    ["flags.--name: needs a value"],
  );
  assertEquals(
    refused(() =>
      buildCommand({
        path: "share add",
        args: ["a", "team"],
        flags: { "--root": "yes" },
      })
    ),
    [
      "flags.--root: is a switch; pass true",
    ],
  );
  assertEquals(
    refused(() =>
      buildCommand({ path: "new", flags: { "--cpu": Number.NaN } })
    ),
    ["flags.--cpu: must be a finite number"],
  );
});

Deno.test("credential flags cannot read stdin and are redacted", () => {
  assertEquals(
    refused(() =>
      buildCommand({
        path: "integrations add",
        args: ["http-proxy"],
        flags: { "--name": "x", "--bearer": "-" },
      })
    ),
    ["flags.--bearer: the HTTPS API has no stdin, so '-' cannot be used; pass the value"],
  );
  const command = buildCommand({
    path: "integrations add",
    args: ["http-proxy"],
    flags: {
      "--name": "api",
      "--bearer": "sk-secret",
      "--header": ["X-Key:hunter2"],
    },
    secretFlags: ["--header"],
  });
  assert(command.line.includes("sk-secret"), "sent");
  assertEquals(
    command.redacted,
    "integrations add --name=api --bearer=*** --header=*** http-proxy",
  );
  const args = buildCommand({
    path: "exe0-to-exe1",
    args: ["exe0.a.b"],
    secretArgs: [0],
  });
  assertEquals(args.redacted, "exe0-to-exe1 ***");
});

Deno.test("empty arguments need allowEmptyArgs", () => {
  assertEquals(
    refused(() => buildCommand({ path: "comment", args: ["web-0", ""] })),
    ["args.1: must not be empty"],
  );
  assertEquals(
    buildCommand({ path: "comment", args: ["web-0", ""], allowEmptyArgs: true })
      .line,
    "comment web-0 ''",
  );
});

Deno.test("the 64 KiB body limit is enforced before sending", () => {
  const big = "x".repeat(MAX_BODY_BYTES);
  const issues = refused(() =>
    buildCommand({ path: "comment", args: ["web-0", big] })
  );
  assert(issues[0].includes("the HTTPS API accepts at most 65536"), issues[0]);
  refused(() => rawCommand("   "));
  refused(() => rawCommand("ls\nrm x"));
  assertEquals(rawCommand("ls -l", { idempotent: true }).idempotent, true);
  assertEquals(rawCommand("whoami").path, "whoami");
});

Deno.test("unknown command paths are refused", () => {
  assertEquals(refused(() => buildCommand({ path: "frobnicate" })), [
    'path: unknown command "frobnicate"',
  ]);
});

Deno.test("idempotency follows the catalog unless overridden", () => {
  assertEquals(buildCommand({ path: "ls" }).idempotent, true);
  assertEquals(buildCommand({ path: "new" }).idempotent, false);
  assertEquals(
    buildCommand({ path: "share port", args: ["web-0"], idempotent: true })
      .idempotent,
    true,
  );
  const reads = COMMANDS.filter((entry) => entry.idempotent).map((entry) =>
    entry.path
  );
  for (
    const mutating of [
      "new",
      "rm",
      "cp",
      "tag",
      "rename",
      "resize",
      "restart",
      "comment",
      "ssh",
      "billing credits buy",
      "team disable",
      "pool delete",
      "integrations add",
    ]
  ) {
    assert(!reads.includes(mutating), `${mutating} must not be retried`);
  }
});

Deno.test("resolveCommand finds the longest path and follows aliases", () => {
  const cases: [string[], string | undefined, string[]][] = [
    [["ls", "-l"], "ls", ["-l"]],
    [["share", "show", "web-0"], "share show", ["web-0"]],
    [["share", "add-share-link", "web-0"], "share add-link", ["web-0"]],
    [["int", "list"], "integrations list", []],
    [["team", "ls"], "team members", []],
    [["team", "vm", "list", "-l"], "team vm ls", ["-l"]],
    [["pool", "ls"], "pool list", []],
    [
      ["team", "settings", "vm-placement", "pool", "p1"],
      "team settings vm-placement pool",
      ["p1"],
    ],
    [["share", "web-0"], "share", ["web-0"]],
    [["nope"], undefined, []],
  ];
  for (const [words, path, rest] of cases) {
    const resolved = resolveCommand(words);
    assertEquals(resolved?.path, path, words.join(" "));
    if (resolved !== undefined) {
      assertEquals(resolved.rest, rest, words.join(" "));
    }
  }
});

Deno.test("the catalog covers every CLI reference page", () => {
  const pages = [
    "billing",
    "browser",
    "comment",
    "cp",
    "doc",
    "domain",
    "grant-support-root",
    "help",
    "integrations",
    "invite",
    "ls",
    "new",
    "pool",
    "rename",
    "resize",
    "restart",
    "rm",
    "set-region",
    "share",
    "shelley",
    "ssh-key",
    "ssh",
    "stat",
    "tag",
    "team",
    "whoami",
  ];
  for (const page of pages) assert(commandSpec(page) !== undefined, page);
  assert(TOP_LEVEL_COMMANDS.includes("exit"), "exit is listed (REPL only)");
  assertEquals(
    new Set(COMMANDS.map((entry) => entry.path)).size,
    COMMANDS.length,
  );
  for (const entry of COMMANDS) {
    assert(
      entry.flags["--json"] !== undefined &&
        entry.flags["--help"] !== undefined,
      entry.path,
    );
    const parent = entry.path.split(" ").slice(0, -1).join(" ");
    if (parent !== "") {
      assert(
        commandSpec(parent) !== undefined,
        `${entry.path} has a parent ${parent}`,
      );
    }
  }
});

Deno.test("catalogDrift reads help output leniently and reports differences", () => {
  const live = {
    commands: [
      ...COMMANDS.filter((entry) =>
        !entry.path.includes(" ") && entry.path !== "stat"
      ).map((entry) => ({
        name: entry.path,
        description: entry.summary,
        flags: [{ name: "json" }],
      })),
      { name: "teleport", description: "new!" },
      { name: "share frobnicate <vm>", description: "new subcommand" },
      { name: "--weird" },
    ],
  };
  const drift = catalogDrift(live as never);
  assertEquals(drift.unknown, ["share frobnicate", "teleport"]);
  assertEquals(drift.missing, ["stat"]);
  assertEquals(catalogDrift(["ls", "new"] as never).live, []);
  assertEquals(
    catalogDrift({ commands: [{ command: "int list" }] }).unknown,
    [],
  );
});
