// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { customTool, GptClient, ToolRegistry } from "@celld/api/openai";
import {
  ApplyPatchError,
  codingTools,
  type FileSystem,
  grepFilesTool,
  MemoryFileSystem,
  readOnlyTools,
} from "@celld/api/openai/coding";
import {
  disassemble,
  ListingChangedError,
  PartialPatchError,
  reverseEngineerFile,
  reviewCheckout,
  sandboxApplyPatch,
  sandboxCodingTools,
  sandboxDirectoryView,
  sandboxFileSystem,
  sandboxShellRunner,
  sandboxWriteFile,
  TruncatedListingError,
  withWorkspaceLease,
  WORKSPACE_LEASE,
  WorkspaceLeaseError,
} from "@celld/api/openai/sandbox";
import {
  FakeResponses,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/openai/testing";
import type {
  ExecOptions,
  ExecResult,
  GitCheckoutOptions,
  ListFilesOptions,
  SandboxApi,
} from "@celld/box/sandbox";
import { SandboxClient } from "@celld/box/sandbox";
import { type LocalSandbox, localSandbox } from "@celld/box/sandbox/testing";

const signal = new AbortController().signal;

async function withSandbox(
  body: (local: LocalSandbox) => Promise<void>,
): Promise<void> {
  const local = await localSandbox();
  try {
    await body(local);
  } finally {
    await local.close();
  }
}

type Box = Pick<
  SandboxApi,
  | "readFile"
  | "writeFile"
  | "deleteFile"
  | "renameFile"
  | "exists"
  | "stat"
  | "remove"
  | "listFiles"
  | "searchFiles"
  | "exec"
  | "execShell"
  | "gitCheckout"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
>;

/** The sandbox's methods, bound, with some replaced. */
function boxOf(sandbox: SandboxApi, overrides: Partial<Box> = {}): Box {
  return {
    readFile: sandbox.readFile.bind(sandbox),
    writeFile: sandbox.writeFile.bind(sandbox),
    deleteFile: sandbox.deleteFile.bind(sandbox),
    renameFile: sandbox.renameFile.bind(sandbox),
    exists: sandbox.exists.bind(sandbox),
    stat: sandbox.stat.bind(sandbox),
    remove: sandbox.remove.bind(sandbox),
    listFiles: sandbox.listFiles.bind(sandbox),
    searchFiles: sandbox.searchFiles.bind(sandbox),
    exec: sandbox.exec.bind(sandbox),
    execShell: sandbox.execShell.bind(sandbox),
    gitCheckout: sandbox.gitCheckout.bind(sandbox),
    acquireLease: sandbox.acquireLease.bind(sandbox),
    renewLease: sandbox.renewLease.bind(sandbox),
    releaseLease: sandbox.releaseLease.bind(sandbox),
    ...overrides,
  };
}

function client(fake: FakeResponses): GptClient {
  return new GptClient({
    fetch: fake.fetch,
    runtime: virtualRuntime(),
    model: "gpt-5.5",
  });
}

function textOf(request: RecordedRequest): string {
  return request.body.input[0].content[0].text as string;
}

async function modeOf(box: Box, path: string): Promise<string> {
  return (await box.exec(["stat", "-c", "%a", "--", path])).stdout.trim();
}

async function everything(box: Box): Promise<string[]> {
  return await sandboxFileSystem(box).list("");
}

Deno.test("the file system adapter behaves like openai's FileSystem", () =>
  withSandbox(async ({ sandbox }) => {
    const fs = sandboxFileSystem(sandbox);
    assertEquals(await fs.read("missing.txt"), null);
    // Writes go through the leased writers (DB-REV-OAI-8), never `fs`.
    const unleased = await assertRejects(fs.write("src/main.ts", "x"));
    assert(unleased.message.includes("sandboxWriteFile"), unleased.message);
    await sandboxWriteFile(sandbox, "src/main.ts", "export {};\n");
    await sandboxWriteFile(sandbox, ".gitignore", "dist\n");
    assertEquals(await fs.read("src/main.ts"), "export {};\n");
    assertEquals(await fs.read("src"), null);
    assertEquals(await fs.kind("src"), "dir");
    assertEquals(await fs.kind("src/main.ts"), "file");
    assertEquals(await fs.kind("nothing"), null);
    assertEquals(await fs.list(""), [".gitignore", "src/main.ts"]);
    assertEquals(await fs.list("src"), ["src/main.ts"]);
    assertEquals(await fs.list("absent"), []);
    await assertRejects(fs.remove("src/main.ts"));
    await sandbox.deleteFile("src/main.ts");
    assertEquals(await fs.read("src/main.ts"), null);
    await sandbox.writeFile("binary", new Uint8Array([0xff, 0xfe]));
    assertEquals(await fs.read("binary"), null);
    const escape = await assertRejects(fs.read("../escape"));
    assert(escape instanceof Error, "paths outside the workspace still throw");
  }));

Deno.test("a listing cut short by its limit is an error, never a partial list", () =>
  withSandbox(async ({ sandbox }) => {
    for (const name of ["a", "b", "c", "d"]) {
      await sandbox.writeFile(`src/${name}.ts`, "");
    }
    const asked: (ListFilesOptions | undefined)[] = [];
    const box = boxOf(sandbox, {
      listFiles(path, options) {
        asked.push(options);
        return sandbox.listFiles(path, options);
      },
    });
    assertEquals((await sandboxFileSystem(box).list("src")).length, 4);
    assertEquals(asked[0]?.limit, 20_000);
    const small = sandboxFileSystem(box, { maxEntries: 3 });
    const error = await assertRejects(small.list("src"));
    assert(error instanceof TruncatedListingError, String(error));
    assertEquals([error.directory, error.maxEntries], ["src", 3]);
    assert(
      error.message.includes("src") && error.message.includes("3"),
      error.message,
    );
    const root = await assertRejects(small.list(""));
    assert(root.message.includes("the workspace root"), root.message);
    // A sandbox that says it cut the listing is believed, whatever it holds.
    const lying = sandboxFileSystem(boxOf(sandbox, {
      listFiles: () => Promise.resolve({ entries: [], truncated: true }),
    }));
    assert(
      await assertRejects(lying.list("")) instanceof TruncatedListingError,
      "truncated is read",
    );
    for (const bad of [0, 1.5, 100_001, Number.NaN]) {
      let refused = false;
      try {
        sandboxFileSystem(box, { maxEntries: bad });
      } catch (caught) {
        refused = caught instanceof RangeError;
      }
      assert(refused, `maxEntries ${bad} is refused`);
    }
  }));

Deno.test("the shell adapter runs lines and argv with combined output", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const shell = sandboxShellRunner(sandbox);
    await sandbox.mkdir("pkg");
    const line = await shell.run({
      command: "pwd; echo err >&2; exit 3",
      workdir: "pkg",
      timeoutMs: 5_000,
      signal,
    });
    assertEquals(line.exitCode, 3);
    assert(
      line.output.includes(`${workspace}/pkg`) && line.output.includes("err"),
      line.output,
    );
    const argv = await shell.run({
      command: ["echo", "$HOME"],
      workdir: null,
      timeoutMs: 5_000,
      signal,
    });
    assertEquals(argv.output, "$HOME\n");
    const slow = await shell.run({
      command: "sleep 10",
      workdir: null,
      timeoutMs: 200,
      signal,
    });
    assertEquals([slow.exitCode, slow.timedOut], [null, true]);
    const cut = await sandboxShellRunner(sandbox, { maxOutputBytes: 10 }).run({
      command: "echo 0123456789abcdef",
      workdir: null,
      timeoutMs: 5_000,
      signal,
    });
    assertEquals(cut.output, "0123456789\n…[output truncated]");
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    const refused = await assertRejects(shell.run({
      command: "true",
      workdir: null,
      timeoutMs: 1_000,
      signal: aborted.signal,
    }));
    assertEquals(refused.message, "stop");
  }));

const PATCH = [
  "*** Begin Patch",
  "*** Add File: src/lib/new.ts",
  "+export const added = true;",
  "*** Update File: run.sh",
  "@@",
  "-echo old",
  "+echo new",
  "*** Update File: notes/a.txt",
  "*** Move to: notes/b.txt",
  "@@",
  " keep",
  "-drop",
  "+moved",
  "*** Delete File: gone.txt",
  "*** End Patch",
  "",
].join("\n");

async function seed(box: Box): Promise<void> {
  await box.writeFile("run.sh", "#!/bin/sh\necho old\n", { mode: "755" });
  await box.writeFile("notes/a.txt", "keep\ndrop\n");
  await box.writeFile("gone.txt", "bye\n");
}

Deno.test("apply_patch over the sandbox stages, renames and keeps modes", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await seed(box);
    const applied = await sandboxApplyPatch(box, PATCH);
    assertEquals(
      applied.summary,
      [
        "Success. Updated the following files:",
        "A src/lib/new.ts",
        "M run.sh",
        "M notes/b.txt",
        "D gone.txt",
        "",
      ].join("\n"),
    );
    const fs = sandboxFileSystem(box);
    assertEquals(await everything(box), [
      "notes/b.txt",
      "run.sh",
      "src/lib/new.ts",
    ]);
    assertEquals(await fs.read("run.sh"), "#!/bin/sh\necho new\n");
    assertEquals(await fs.read("notes/b.txt"), "keep\nmoved\n");
    assertEquals(
      await fs.read("src/lib/new.ts"),
      "export const added = true;\n",
    );
    assertEquals(await modeOf(box, "run.sh"), "755");
    assertEquals((await box.exec(["./run.sh"])).stdout, "new\n");
  }));

Deno.test("a patch that does not fit changes nothing", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await seed(box);
    const error = await assertRejects(sandboxApplyPatch(
      box,
      PATCH.replace("-echo old", "-echo older"),
    ));
    assert(error instanceof ApplyPatchError, String(error));
    assertEquals((error as ApplyPatchError).kind, "apply");
    assertEquals(await everything(box), ["gone.txt", "notes/a.txt", "run.sh"]);
    assertEquals(
      await sandboxFileSystem(box).read("run.sh"),
      "#!/bin/sh\necho old\n",
    );
  }));

Deno.test("a failed rename reports what was and was not applied", () =>
  withSandbox(async ({ sandbox }) => {
    let renames = 0;
    const box = boxOf(sandbox, {
      async renameFile(from, to, options) {
        if (++renames === 2) throw new Error("disk on fire");
        await sandbox.renameFile(from, to, options);
      },
    });
    await seed(box);
    const error = await assertRejects(sandboxApplyPatch(box, PATCH));
    assert(error instanceof PartialPatchError, String(error));
    const partial = error as PartialPatchError;
    assertEquals(partial.committed, ["src/lib/new.ts"]);
    assertEquals(partial.pending, [
      "run.sh",
      "notes/b.txt",
      "notes/a.txt",
      "gone.txt",
    ]);
    assert(partial.message.includes("disk on fire"), partial.message);
    // No temporary files are left behind.
    assertEquals(await everything(box), [
      "gone.txt",
      "notes/a.txt",
      "run.sh",
      "src/lib/new.ts",
    ]);
  }));

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function present(box: Box, path: string): Promise<boolean> {
  return (await box.exists(path)).exists;
}

Deno.test("an aborted shell command is killed before the runner returns", () =>
  withSandbox(async ({ sandbox }) => {
    const shell = sandboxShellRunner(sandbox);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 150);
    const started = Date.now();
    const error = await assertRejects(shell.run({
      command: "sleep 1; touch late",
      workdir: null,
      timeoutMs: 10_000,
      signal: controller.signal,
    }));
    assertEquals(error.message, "stop");
    assert(Date.now() - started < 900, "the runner returned early");
    await delay(1_300);
    assert(!await present(boxOf(sandbox), "late"), "the command was killed");
  }));

Deno.test("a tool timeout kills the sandbox command before it is reported", () =>
  withSandbox(async ({ sandbox }) => {
    const shell = sandboxShellRunner(sandbox);
    const tool = customTool({
      name: "slow",
      description: "d",
      timeoutMs: 150,
      run: async (_input, context) =>
        (await shell.run({
          command: "sleep 1; touch late",
          workdir: null,
          timeoutMs: 10_000,
          signal: context.signal,
        })).output,
    });
    const [result] = await new ToolRegistry([tool]).execute([
      { kind: "custom", callId: "s", name: "slow", input: "" },
    ]);
    assertEquals([result.status, result.abandoned], ["timeout", undefined]);
    await delay(1_300);
    assert(!await present(boxOf(sandbox), "late"), "the command was killed");
  }));

Deno.test("an aborted patch stops between files and reports the partial result", () =>
  withSandbox(async ({ sandbox }) => {
    const controller = new AbortController();
    let renames = 0;
    const box = boxOf(sandbox, {
      async renameFile(from, to, options) {
        await sandbox.renameFile(from, to, options);
        if (++renames === 1) controller.abort(new Error("timeout"));
      },
    });
    await seed(box);
    const error = await assertRejects(
      sandboxApplyPatch(box, PATCH, { signal: controller.signal }),
    );
    assert(error instanceof PartialPatchError, String(error));
    assertEquals(renames, 1);
    assertEquals(error.committed, ["src/lib/new.ts"]);
    assertEquals(error.pending, [
      "run.sh",
      "notes/b.txt",
      "notes/a.txt",
      "gone.txt",
    ]);
    // Nothing after the abort: no temporary files, the rest untouched.
    assertEquals(await everything(box), [
      "gone.txt",
      "notes/a.txt",
      "run.sh",
      "src/lib/new.ts",
    ]);
    assertEquals(
      await sandboxFileSystem(box).read("run.sh"),
      "#!/bin/sh\necho old\n",
    );
  }));

Deno.test("an apply_patch timeout is reported once the patch is fenced", () =>
  withSandbox(async ({ sandbox }) => {
    // The tool's timeout fires from inside the first rename, whatever the
    // host's load: the registry's timer is captured from its runtime and
    // fired there, instead of racing a wall-clock budget against planning
    // and staging (which flaked under load).
    const TIMEOUT_MS = 60_000;
    let fireTimeout: (() => void) | null = null;
    const runtime = {
      now: () => Date.now(),
      random: () => Math.random(),
      sleep: (ms: number) => delay(ms),
      setTimer(ms: number, callback: () => void) {
        if (ms === TIMEOUT_MS) {
          fireTimeout = callback;
          return () => {};
        }
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    };
    let renames = 0;
    const box = boxOf(sandbox, {
      async renameFile(from, to, options) {
        // The timeout falls while the first rename is under way.
        if (++renames === 1) {
          assert(fireTimeout !== null, "the tool's timer is armed");
          fireTimeout();
        }
        await sandbox.renameFile(from, to, options);
      },
    });
    await seed(box);
    const [patch] = sandboxCodingTools(box, { shell: false }).filter((tool) =>
      tool.name === "apply_patch"
    );
    const timed = { ...patch, timeoutMs: TIMEOUT_MS } as typeof patch;
    const [result] = await new ToolRegistry([timed]).execute([
      { kind: "custom", callId: "p", name: "apply_patch", input: PATCH },
    ], { runtime });
    assertEquals(renames, 1);
    assertEquals(result.status, "timeout");
    assert(
      result.output.includes("1 of 5 files changed"),
      result.output,
    );
    assertEquals(await everything(box), [
      "gone.txt",
      "notes/a.txt",
      "run.sh",
      "src/lib/new.ts",
    ]);
  }));

Deno.test("the coding tools over a sandbox use the staged apply_patch", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await seed(box);
    const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
    assertEquals(names(sandboxCodingTools(box, { readOnly: true })), [
      "read_file",
      "list_dir",
      "grep_files",
    ]);
    assertEquals(names(sandboxCodingTools(box, { shell: false })), [
      "read_file",
      "list_dir",
      "grep_files",
      "apply_patch",
    ]);
    for (const tool of sandboxCodingTools(box)) {
      assertEquals(
        [tool.name, tool.mutates, tool.workspace === box],
        [tool.name, tool.mutates, tool.mutates],
        "every mutating tool over the sandbox shares its lane",
      );
    }
    const registry = new ToolRegistry(sandboxCodingTools(box));
    const [patched, ran] = await registry.execute([
      { kind: "custom", callId: "p", name: "apply_patch", input: PATCH },
    ]).then(async (first) => [
      ...first,
      ...(await registry.execute([{
        kind: "function",
        callId: "x",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "./run.sh" }),
      }])),
    ]);
    assertEquals(patched.status, "ok");
    assert(patched.output.includes("M run.sh"), patched.output);
    assert(ran.output.includes("Exit code: 0"), ran.output);
    assert(ran.output.endsWith("Output:\nnew\n"), ran.output);
  }));

const OBJDUMP = `#!/bin/sh
# A stand-in objdump: prints two functions, or fails for "bad".
case "$*" in *bad*) echo "not an object file" >&2; exit 1;; esac
echo "0000000000401136 <main>:"
echo "  call 401150 <helper>"
echo "0000000000401150 <helper>:"
echo "  ret"
`;

/** Runs `bin/<tool>` from the workspace in place of the real tool. */
function withFakeTools(
  sandbox: SandboxApi,
  calls: { argv: string[]; options?: ExecOptions }[],
): Box {
  return boxOf(sandbox, {
    exec(argv, options) {
      calls.push({ argv, ...(options === undefined ? {} : { options }) });
      return sandbox.exec(["sh", `bin/${argv[0]}`, ...argv.slice(1)], options);
    },
  });
}

Deno.test("disassemble runs the analyzer with argv, a deadline and a cap", () =>
  withSandbox(async ({ sandbox }) => {
    const calls: { argv: string[]; options?: ExecOptions }[] = [];
    const box = withFakeTools(sandbox, calls);
    await box.writeFile("bin/objdump", OBJDUMP);
    await box.writeFile("bin/strings", "#!/bin/sh\necho evil.example\n");
    await box.writeFile("upload/a.out", "\x7fELF");
    const listing = await disassemble(box, "./upload/a.out");
    assertEquals(listing.argv, [
      "objdump",
      "-d",
      "-C",
      "--no-show-raw-insn",
      "--",
      "upload/a.out",
    ]);
    // Read-only, declared so: the sandbox runs it during another holder's
    // workspace lease.
    assertEquals(calls[0].options, {
      mutates: false,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    assert(listing.text.startsWith("0000000000401136 <main>:\n"), listing.text);
    assertEquals(listing.truncated, false);
    const strings = await disassemble(box, "upload/a.out", {
      tool: "strings",
      timeoutMs: 5_000,
      maxOutputBytes: 4,
    });
    assertEquals(strings.argv, [
      "strings",
      "-a",
      "-n",
      "6",
      "--",
      "upload/a.out",
    ]);
    assertEquals([strings.text, strings.truncated], ["evil", true]);
    const custom = await disassemble(box, "upload/a.out", {
      tool: "strings",
      args: ["-n", "10"],
    });
    assertEquals(custom.argv, ["strings", "-n", "10", "--", "upload/a.out"]);
    const failed = await assertRejects(disassemble(box, "upload/bad"));
    assertEquals(
      failed.message,
      "objdump failed with exit code 1: not an object file",
    );
    const escape = await assertRejects(disassemble(box, "../../etc/passwd"));
    assert(escape.message.includes("leaves the workspace"), escape.message);
    const unknown = await assertRejects(
      // deno-lint-ignore no-explicit-any
      disassemble(box, "upload/a.out", { tool: "gdb" as any }),
    );
    assertEquals(unknown.message, "unknown analyzer: gdb");
    assertEquals(calls.length, 4);
  }));

Deno.test("reverseEngineerFile feeds the disassembly to reverseEngineer", () =>
  withSandbox(async ({ sandbox }) => {
    const box = withFakeTools(sandbox, []);
    await box.writeFile("bin/objdump", OBJDUMP);
    await box.writeFile("upload/a.out", "\x7fELF");
    const fake = new FakeResponses([{
      text: JSON.stringify({
        summary: "main calls helper",
        architecture: "x86-64 SysV",
        functions: [
          { name: "main", purpose: "entry", confidence: 0.9 },
          { name: "helper", purpose: "returns", confidence: 0.7 },
        ],
        capabilities: [],
        indicators: [],
        vulnerabilities: [],
        openQuestions: [],
      }),
    }]);
    const { result, disassembly, chunks } = await reverseEngineerFile(
      client(fake),
      box,
      "upload/a.out",
      { effort: "medium" },
    );
    assertEquals(chunks, 1);
    assertEquals(disassembly.tool, "objdump");
    assertEquals(result.functions.map((f) => f.name), ["main", "helper"]);
    const body = fake.requests[0].body;
    assertEquals([body.text.format.name, body.reasoning.effort], [
      "re_notes",
      "medium",
    ]);
    const input = body.input[0].content[0].text as string;
    assert(
      input.startsWith(
        "Context: objdump output for upload/a.out\n<disassembly>\n0000000000401136 <main>:",
      ),
      input,
    );
  }));

const REVIEW = {
  summary: "Builds SQL from user input.",
  findings: [{
    title: "SQL injection in lookup",
    severity: "high",
    cwe: "CWE-89",
    location: { path: "src/app.py", startLine: 2, endLine: 2, symbol: "find" },
    evidence: "f-string query",
    exploitability: "any caller",
    confidence: 0.9,
    remediation: "parameterise",
  }],
};

Deno.test("reviewCheckout clones, reads the checkout read-only and reviews it", () =>
  withSandbox(async ({ sandbox }) => {
    const clones: { url: string; options?: GitCheckoutOptions }[] = [];
    // The clone holds the workspace lease, and always gets its fence as
    // its signal (DB-REV-OAI-8) and the lease's token as `lease`, which
    // the sandbox checks; the rest of its options are as asked (no
    // `unsafeSymlinks`: links are checked out as plain files).
    const fences: (AbortSignal | undefined)[] = [];
    const leases: (string | undefined)[] = [];
    const box = boxOf(sandbox, {
      async gitCheckout(url, given): Promise<ExecResult> {
        const { signal: fence, lease, ...options } = given ?? {};
        fences.push(fence);
        leases.push(lease);
        clones.push({ url, options });
        const dir = options?.targetDir ?? "api";
        // The clone writes under the lease it was given, as the sandbox's
        // own clone does.
        const write = { lease };
        await sandbox.writeFile(`${dir}/.git/config`, "[core]\n", write);
        await sandbox.writeFile(
          `${dir}/src/app.py`,
          "def find(db, name):\n    return db.execute(f\"... '{name}'\")\n",
          write,
        );
        await sandbox.writeFile(`${dir}/README.md`, "# api\n", write);
        await sandbox.writeFile(`${dir}/big.sql`, "x".repeat(100), write);
        await sandbox.writeFile(
          `${dir}/logo.png`,
          new Uint8Array([0x89, 0xff]),
          write,
        );
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    });
    // One chunk per file; only src/app.py has a finding.
    const answer = (request: RecordedRequest) => ({
      text: JSON.stringify(
        textOf(request).includes("// file: src/app.py")
          ? REVIEW
          : { summary: "docs", findings: [] },
      ),
    });
    const fake = new FakeResponses([answer, answer]);
    const review = await reviewCheckout(
      client(fake),
      box,
      "https://git.example/acme/api.git",
      { branch: "main", maxFileChars: 80, context: "a user service" },
    );
    assertEquals(clones, [{
      url: "https://git.example/acme/api.git",
      options: { branch: "main" },
    }]);
    assert(fences[0] instanceof AbortSignal, "the clone can be stopped");
    assert(typeof leases[0] === "string", "the clone holds the lease");
    assertEquals(review.directory, "api");
    assertEquals(review.files, ["README.md", "src/app.py"]);
    assertEquals(review.skipped, ["big.sql"]);
    assertEquals(review.findings.map((f) => f.cwe), ["CWE-89"]);
    assertEquals(fake.requests.length, 2);
    const text = fake.requests.map(textOf).find((input) =>
      input.includes("src/app.py")
    )!;
    assert(text.startsWith("Context: a user service\n"), text);
    assert(text.includes("// file: src/app.py\n1: def find"), text);
    assert(!text.includes("[core]"), "the .git directory is skipped");
    assertEquals(await review.fs.read("README.md"), "# api\n");
    assertEquals(await review.fs.list("src"), ["src/app.py"]);
    const write = await assertRejects(review.fs.write("README.md", "x"));
    assert(write.message.includes("read-only"), write.message);

    const only = new FakeResponses([{ text: JSON.stringify(REVIEW) }]);
    const filtered = await reviewCheckout(
      client(only),
      box,
      "https://git.example/acme/api",
      { targetDir: "second", include: ["src/**"] },
    );
    assertEquals([filtered.directory, filtered.files], ["second", [
      "src/app.py",
    ]]);
  }));

Deno.test("reviewCheckout reports a failed clone and an empty checkout", () =>
  withSandbox(async ({ sandbox }) => {
    const failing = boxOf(sandbox, {
      gitCheckout: () =>
        Promise.resolve({
          success: false,
          exitCode: 128,
          stdout: "",
          stderr: "fatal: repository not found\n",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        }),
    });
    const fake = new FakeResponses();
    const failed = await assertRejects(
      reviewCheckout(client(fake), failing, "https://git.example/acme/nope"),
    );
    assertEquals(
      failed.message,
      "git clone of https://git.example/acme/nope failed with exit code 128: fatal: repository not found",
    );
    const empty = boxOf(sandbox, {
      async gitCheckout(_url, options) {
        await sandbox.writeFile("empty/.git/HEAD", "ref: main\n", {
          lease: options?.lease,
        });
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    });
    const nothing = await assertRejects(
      reviewCheckout(client(fake), empty, "https://git.example/acme/empty"),
    );
    assertEquals(nothing.message, "nothing to review in empty");
    assertEquals(fake.requests.length, 0);
  }));

// MARK: sweep (WP-14)

const CLONED: ExecResult = {
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 1,
};

// Deno removes `Object.prototype.__proto__`; stock V8 and workerd keep the
// Annex B accessor, where assigning a string to it does nothing. Put back
// for the test, so both engines' behaviour is checked.
async function withProtoAccessor(body: () => Promise<void>): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, value: unknown) {
      if (typeof value === "object" || typeof value === "function") {
        Object.setPrototypeOf(this, value as object | null);
      }
    },
  });
  try {
    const probe: Record<string, unknown> = {};
    probe["__proto__"] = "text";
    assert(!Object.hasOwn(probe, "__proto__"), "the accessor is in place");
    await body();
  } finally {
    if (had === undefined) {
      delete (Object.prototype as { __proto__?: unknown }).__proto__;
    } else {
      Object.defineProperty(Object.prototype, "__proto__", had);
    }
  }
}

// DB-SWP-F12-17 (the WP-09 note): `list` refused any listing the sandbox
// cut, even when its limit was only a page size and a cursor could carry
// on; now it pages up to `maxEntries` and refuses only past that.
Deno.test("list pages through the sandbox's cursor up to maxEntries", () =>
  withSandbox(async ({ sandbox }) => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      await sandbox.writeFile(`dir/${name}.txt`, name);
    }
    const pages: (string | undefined)[] = [];
    const paged = boxOf(sandbox, {
      listFiles: (path, options?: ListFilesOptions) => {
        pages.push(options?.cursor);
        return sandbox.listFiles(path, {
          ...options,
          limit: Math.min(options?.limit ?? 2, 2),
        });
      },
    });
    const fs = sandboxFileSystem(paged, { maxEntries: 100 });
    assertEquals(await fs.list("dir"), [
      "dir/a.txt",
      "dir/b.txt",
      "dir/c.txt",
      "dir/d.txt",
      "dir/e.txt",
    ]);
    assert(pages.length >= 3, `read in ${pages.length} pages`);
    const small = sandboxFileSystem(paged, { maxEntries: 4 });
    await assertRejects(small.list("dir"), TruncatedListingError);
  }));

// DB-SWP-F12-15 (the WP-09 note): mutations were serialized per client
// object and isolate only; two Workers (here: two client objects) on one
// sandbox interleaved their commands. The sandbox's lease now spans them.
Deno.test("mutating tools on two clients of one sandbox never overlap", () =>
  withSandbox(async ({ sandbox }) => {
    const script =
      "mkdir held 2>/dev/null || { echo overlap; exit 7; }; sleep 0.3; rmdir held";
    const run = (box: Box, id: string) =>
      new ToolRegistry(sandboxCodingTools(box)).execute([{
        kind: "function",
        callId: id,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: script }),
      }], { timeoutMs: 20_000 });
    const [first, second] = await Promise.all([
      run(boxOf(sandbox), "one"),
      run(boxOf(sandbox), "two"),
    ]);
    for (const [execution] of [first, second]) {
      assert(!execution.output.includes("overlap"), execution.output);
    }
    assertEquals(await sandbox.acquireLease("workspace") !== null, true);
  }));

// DB-SWP-F9-18: reviewCheckout gathered the checkout's files in a plain
// object keyed by path, so a file named `__proto__` (a name the repository
// under review chooses) hit the prototype setter and escaped the review.
Deno.test("a file named __proto__ is reviewed like any other", () =>
  withSandbox((local) =>
    withProtoAccessor(async () => {
      const { sandbox } = local;
      const box = boxOf(sandbox, {
        async gitCheckout(_url, options) {
          const write = { lease: options?.lease };
          await sandbox.writeFile("repo/__proto__", "eval(input)\n", write);
          await sandbox.writeFile("repo/ok.py", "print(1)\n", write);
          return CLONED;
        },
      });
      const fake = new FakeResponses([
        { text: JSON.stringify({ summary: "one", findings: [] }) },
        { text: JSON.stringify({ summary: "two", findings: [] }) },
      ]);
      const review = await reviewCheckout(
        client(fake),
        box,
        "https://git.example/acme/repo",
      );
      assertEquals(review.files.toSorted(), ["__proto__", "ok.py"]);
      assert(
        fake.requests.map(textOf).some((text) =>
          text.includes("// file: __proto__")
        ),
        "the file reached the review",
      );
    })
  ));

// DB-SWP-F10-14 (the WP-09 note): reviewCheckout could not stop its clone.
Deno.test("reviewCheckout hands the call's signal to the clone", () =>
  withSandbox(async ({ sandbox }) => {
    const seen: (AbortSignal | undefined)[] = [];
    const box = boxOf(sandbox, {
      async gitCheckout(_url, options) {
        seen.push(options?.signal);
        await sandbox.writeFile("repo/a.py", "print(1)\n", {
          lease: options?.lease,
        });
        return CLONED;
      },
    });
    const stop = new AbortController();
    const fake = new FakeResponses([
      { text: JSON.stringify({ summary: "s", findings: [] }) },
    ]);
    await reviewCheckout(client(fake), box, "https://git.example/acme/repo", {
      call: { signal: stop.signal },
    });
    assertEquals(seen, [stop.signal]);
  }));

// DB-SWP-F14-19: grep_files compiled the model's pattern with `new RegExp`
// and ran it in the isolate over workspace files, where a backtracking
// pattern blocks the whole Worker (no deadline can interrupt a running
// regex). Over a sandbox, a regex now runs as `grep -E` in the container
// under the call's deadline.
Deno.test("grep_files runs a regex in the sandbox, not in the isolate", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("src/a.ts", "const x = eval(input);\nsafe();\n");
    await sandbox.writeFile("src/b.md", "evaluation\n");
    await sandbox.writeFile("big.txt", `${"a".repeat(5_000)}!\n`);
    const registry = new ToolRegistry(
      sandboxCodingTools(boxOf(sandbox), { readOnly: true }),
    );
    const grep = (args: Record<string, unknown>) =>
      registry.execute([{
        kind: "function",
        callId: "g",
        name: "grep_files",
        arguments: JSON.stringify({
          path: null,
          include: null,
          limit: null,
          regex: null,
          ...args,
        }),
      }], { timeoutMs: 20_000 });
    const [regex] = await grep({ pattern: "eval\\(", regex: true });
    assertEquals(regex.output, "src/a.ts:1: const x = eval(input);");
    const [literal] = await grep({ pattern: "eval(", regex: null });
    assertEquals(literal.output, "src/a.ts:1: const x = eval(input);");
    const [globbed] = await grep({ pattern: "eval", include: "*.md" });
    assertEquals(globbed.output, "src/b.md:1: evaluation");
    const started = Date.now();
    const [hostile] = await grep({ pattern: "^(a|aa)*$", regex: true });
    assertEquals(hostile.output, "(no matches)");
    assert(Date.now() - started < 10_000, "the pattern ran to completion");
  }));

// MARK: review (WP-16)

const grepCall = (id: string, args: Record<string, unknown>) => ({
  kind: "function" as const,
  callId: id,
  name: "grep_files",
  arguments: JSON.stringify({
    path: null,
    include: null,
    limit: null,
    regex: null,
    ...args,
  }),
});

const readCall = (id: string, path: string) => ({
  kind: "function" as const,
  callId: id,
  name: "read_file",
  arguments: JSON.stringify({ path, offset: null, limit: null }),
});

const listCall = (id: string, path: string | null) => ({
  kind: "function" as const,
  callId: id,
  name: "list_dir",
  arguments: JSON.stringify({ path, depth: null }),
});

// DB-REV-OAI-1: `search` passed `sandbox.exec` unbound, and both
// `SandboxClient.exec` and `SandboxCore.exec` use `this`, so a regex
// grep_files failed on every real sandbox; the tests' `boxOf` binds every
// method and hid it.
Deno.test("regex grep_files works over a SandboxCore and a SandboxClient as they are", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("a.txt", "hello\n");
    const client = new SandboxClient(sandbox as never, "t");
    for (const box of [sandbox, client] as SandboxApi[]) {
      const registry = new ToolRegistry(
        sandboxCodingTools(box, { readOnly: true }),
      );
      const [found] = await registry.execute([
        grepCall("g", { pattern: "hel+o", regex: true }),
      ], { timeoutMs: 20_000 });
      assertEquals([found.status, found.output], ["ok", "a.txt:1: hello"]);
    }
  }));

// DB-REV-OAI-3: the regex search ran `grep -r ... -- DIR` with no guard,
// and grep follows a symbolic link named on its command line (busybox's
// `-r` also reads links to files it meets), so `path: "link"` read files
// outside the workspace that `read_file` refuses.
Deno.test("regex grep_files never follows a symbolic link out of the workspace", () =>
  withSandbox(async ({ sandbox, root, workspace }) => {
    await sandbox.writeFile("a.txt", "hello\n");
    await Deno.mkdir(`${root}/secret`);
    await Deno.writeTextFile(`${root}/secret/key.txt`, "TOPSECRET=hunter2\n");
    await Deno.symlink(`${root}/secret`, `${workspace}/link`);
    await Deno.mkdir(`${workspace}/src`);
    await Deno.symlink(`${root}/secret/key.txt`, `${workspace}/src/key.txt`);
    await Deno.symlink(`${root}/secret`, `${workspace}/src/inner`);
    const registry = new ToolRegistry(
      sandboxCodingTools(sandbox, { readOnly: true }),
    );
    const results = await registry.execute([
      grepCall("1", { pattern: "TOPSECRET", regex: true, path: "link" }),
      grepCall("2", { pattern: "TOPSECRET", regex: true }),
      grepCall("3", { pattern: "TOPSECRET", regex: true, path: "src" }),
      grepCall("4", { pattern: "TOP.ECRET", regex: true, path: "link/." }),
    ], { timeoutMs: 20_000 });
    for (const result of results) {
      assert(!result.output.includes("hunter2"), result.output);
    }
    assertEquals(results[0].status, "error");
    assert(results[0].output.includes("symbolic link"), results[0].output);
    assertEquals(results[1].output, "(no matches)");
    assertEquals(results[2].output, "(no matches)");
    const [ok] = await registry.execute([
      grepCall("5", { pattern: "hel+o", regex: true }),
    ], { timeoutMs: 20_000 });
    assertEquals(ok.output, "a.txt:1: hello");
  }));

// DB-REV-OAI-2: the checkout view only prefixed paths, so a repository's
// own `up -> ..` read (and listed) the rest of the workspace.
Deno.test("a directory view refuses paths through symbolic links", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.writeFile("uploads/customer.env", "API_KEY=sk-live-123\n");
    await sandbox.writeFile("repo/README.md", "hi\n");
    await sandbox.writeFile("repo/src/a.py", "print(1)\n");
    await Deno.symlink("..", `${workspace}/repo/up`);
    await Deno.symlink("../uploads/customer.env", `${workspace}/repo/env`);
    const fs = sandboxDirectoryView(sandbox, "repo");
    const registry = new ToolRegistry(readOnlyTools(fs));
    const results = await registry.execute([
      readCall("1", "up/uploads/customer.env"),
      listCall("2", "up"),
      readCall("3", "env"),
      grepCall("4", { pattern: "API_KEY", regex: true, path: "up" }),
      grepCall("5", { pattern: "API_KEY", path: "up" }),
      grepCall("6", { pattern: "API_KEY", regex: true }),
      grepCall("7", { pattern: "API_KEY" }),
      listCall("8", null),
      readCall("9", "README.md"),
    ], { timeoutMs: 20_000 });
    for (const result of results) {
      assert(!result.output.includes("sk-live"), result.output);
    }
    for (const index of [1, 3, 4, 5, 6, 7]) {
      assert(
        !results[index].output.includes("customer.env"),
        results[index].output,
      );
    }
    for (const index of [0, 1, 2, 3, 4]) {
      assertEquals(results[index].status, "error", results[index].output);
    }
    assertEquals(results[7].output, "README.md\nsrc/a.py");
    assertEquals(results[8].output, "1: hi");
    assertEquals(await fs.list("src"), ["src/a.py"]);
    assertEquals(await fs.kind("up"), null);
    await assertRejects(fs.write("README.md", "x"));
    // The view's own directory is checked too.
    await Deno.symlink("uploads", `${workspace}/alias`);
    const aliased = sandboxDirectoryView(sandbox, "alias");
    await assertRejects(aliased.read("customer.env"));
    await assertRejects(aliased.list(""));
  }));

Deno.test("reviewCheckout reads nothing through the repository's symbolic links", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.writeFile("uploads/customer.env", "API_KEY=sk-live-123\n");
    const box = boxOf(sandbox, {
      async gitCheckout(_url, options) {
        await sandbox.writeFile("repo/app.py", "print(1)\n", {
          lease: options?.lease,
        });
        await Deno.symlink("..", `${workspace}/repo/up`);
        await Deno.symlink(
          "../uploads/customer.env",
          `${workspace}/repo/leak.env`,
        );
        return CLONED;
      },
    });
    const fake = new FakeResponses([
      { text: JSON.stringify({ summary: "s", findings: [] }) },
    ]);
    const review = await reviewCheckout(
      client(fake),
      box,
      "https://git.example/acme/repo",
    );
    assertEquals(review.files, ["app.py"]);
    for (const request of fake.requests) {
      assert(!textOf(request).includes("sk-live"), textOf(request));
    }
    await assertRejects(review.fs.read("up/uploads/customer.env"));
    await assertRejects(review.fs.read("leak.env"));
  }));

// DB-REV-OAI-8: only the staged patch and the shell held the workspace
// lease; `sandboxFileSystem` wrote without it, so `codingTools` over it
// patched a workspace another Worker held.
Deno.test("nothing writes the workspace while another holder has its lease", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await sandbox.writeFile("a.txt", "one\n");
    const held = await sandbox.acquireLease(WORKSPACE_LEASE, {
      ttlMs: 60_000,
    });
    assert(held !== null, "another Worker holds the lease");
    const patch =
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch\n";
    const generic = new ToolRegistry(
      codingTools({
        fs: sandboxFileSystem(box),
        shell: sandboxShellRunner(box),
      }),
    );
    const [result] = await generic.execute([
      { kind: "custom", callId: "p", name: "apply_patch", input: patch },
    ], { timeoutMs: 1_500, cancelGraceMs: 500 });
    assert(result.status !== "ok", result.output);
    assertEquals((await sandbox.readFile("a.txt")).content, "one\n");
    await assertRejects(sandboxFileSystem(box).remove("a.txt"));
    // The leased writer waits for the lease, and gives up with its signal.
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("gave up")), 200);
    const waited = await assertRejects(
      sandboxWriteFile(box, "a.txt", "three\n", { signal: stop.signal }),
    );
    assertEquals(waited.message, "gave up");
    // So does the clone.
    let clones = 0;
    const cloning = boxOf(sandbox, {
      gitCheckout() {
        clones++;
        return Promise.resolve(CLONED);
      },
    });
    const later = new AbortController();
    setTimeout(() => later.abort(new Error("gave up")), 200);
    await assertRejects(
      reviewCheckout(
        client(new FakeResponses()),
        cloning,
        "https://git.example/acme/repo",
        { call: { signal: later.signal } },
      ),
    );
    assertEquals(clones, 0);
    assertEquals((await sandbox.readFile("a.txt")).content, "one\n");
    await sandbox.releaseLease(WORKSPACE_LEASE, held.token);
    await sandboxWriteFile(box, "a.txt", "four\n");
    assertEquals((await sandbox.readFile("a.txt")).content, "four\n");
  }));

// DB-REV-OAI-9: an abort while staging removed the temporary files but
// left the directories staging had created.
Deno.test("a patch stopped while staging leaves no directories behind", () =>
  withSandbox(async ({ sandbox }) => {
    const stop = new AbortController();
    let writes = 0;
    const box = boxOf(sandbox, {
      async writeFile(path, content, options) {
        await sandbox.writeFile(path, content, options);
        if (++writes === 1) stop.abort(new Error("timeout"));
      },
    });
    await sandbox.writeFile("keep.txt", "k");
    await sandbox.writeFile("old/x.txt", "x");
    const patch = [
      "*** Begin Patch",
      "*** Add File: deep/new/dir/a.txt",
      "+hello",
      "*** Add File: old/sub/b.txt",
      "+b",
      "*** End Patch",
      "",
    ].join("\n");
    const error = await assertRejects(
      sandboxApplyPatch(box, patch, { signal: stop.signal }),
    );
    assertEquals(error.message, "timeout");
    const after = await sandbox.listFiles("", {
      recursive: true,
      includeHidden: true,
    });
    assertEquals(after.entries.map((entry) => entry.path).sort(), [
      "keep.txt",
      "old",
      "old/x.txt",
    ]);
  }));

// DB-REV-OAI-12: the literal grep read every file of the listing whatever
// its signal said, so a timed-out search went on reading.
Deno.test("a literal grep stops reading once its call is stopped", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 50; index++) files[`f${index}.txt`] = "x\n";
  const memory = new MemoryFileSystem(files);
  let reads = 0;
  const slow: FileSystem = {
    read: async (path) => {
      reads++;
      await delay(20);
      return await memory.read(path);
    },
    write: (path, content) => memory.write(path, content),
    remove: (path) => memory.remove(path),
    kind: (path) => memory.kind(path),
    list: (dir) => memory.list(dir),
  };
  const [result] = await new ToolRegistry([grepFilesTool(slow)]).execute([
    grepCall("g", { pattern: "needle" }),
  ], { timeoutMs: 100 });
  assertEquals(result.status, "timeout");
  const seen = reads;
  await delay(300);
  assertEquals(reads, seen);
  assert(seen < 50, `read ${seen} files`);
});

// A lease whose renewals the test controls.
function leaseBox(
  sandbox: SandboxApi,
  renew?: SandboxApi["renewLease"],
): Box {
  return boxOf(sandbox, renew === undefined ? {} : { renewLease: renew });
}

// DB-REV-OAI-13: a mutation stuck on a call that never settles renewed the
// lease for as long as it was stuck, fencing every Worker.
Deno.test("a stuck mutation stops holding the lease after its longest hold", () =>
  withSandbox(async ({ sandbox }) => {
    let fence: AbortSignal | null = null;
    let unstick = () => {};
    const stuck = new Promise<void>((resolve) => (unstick = resolve));
    const held = withWorkspaceLease(leaseBox(sandbox), undefined, (signal) => {
      fence = signal;
      return stuck;
    }, { ttlMs: 300, maxHoldMs: 400 });
    await delay(1_200);
    const other = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(other !== null, "another holder gets the lease");
    assert(fence!.aborted, "the work was told to stop");
    unstick();
    await assertRejects(() => held, WorkspaceLeaseError);
  }));

// DB-REV-OAI-14: a lost lease was noticed only when a renewal answered
// null; a renewal that hangs left the holder writing past the expiry.
Deno.test("a lease whose renewals hang is given up before it expires", () =>
  withSandbox(async ({ sandbox }) => {
    const box = leaseBox(sandbox, () => new Promise(() => {}));
    const started = Date.now();
    let stoppedAt = 0;
    const error = await assertRejects(
      () =>
        withWorkspaceLease(
          box,
          undefined,
          (signal) =>
            new Promise((_, reject) =>
              signal.addEventListener("abort", () => {
                stoppedAt = Date.now() - started;
                reject(signal.reason);
              })
            ),
          { ttlMs: 600 },
        ),
    );
    assert(error instanceof WorkspaceLeaseError, String(error));
    assert(stoppedAt > 0 && stoppedAt < 600, `stopped after ${stoppedAt} ms`);
  }));

// DB-REV-OAI-17: pages of a changing walk can repeat entries; a repeat is
// refused rather than answered.
Deno.test("a listing whose pages repeat an entry is refused", () =>
  withSandbox(async ({ sandbox }) => {
    const pages = [
      {
        entries: [
          { path: "a.txt", name: "a.txt", kind: "file" as const },
          { path: "b.txt", name: "b.txt", kind: "file" as const },
        ],
        truncated: true,
        cursor: "c1",
      },
      {
        entries: [
          { path: "b.txt", name: "b.txt", kind: "file" as const },
          { path: "c.txt", name: "c.txt", kind: "file" as const },
        ],
        truncated: false,
      },
    ];
    const box = boxOf(sandbox, {
      listFiles: (_path, options) =>
        Promise.resolve(options?.cursor === undefined ? pages[0] : pages[1]),
    });
    await assertRejects(
      () => sandboxFileSystem(box).list(""),
      ListingChangedError,
    );
  }));

// The clone's signal is the lease's fence: the call's signal and a lost
// lease both stop it.
Deno.test("reviewCheckout stops its clone when the call is cancelled", () =>
  withSandbox(async ({ sandbox }) => {
    const stop = new AbortController();
    let stopped: boolean | undefined;
    const box = boxOf(sandbox, {
      gitCheckout(_url, options) {
        stop.abort(new Error("cancelled"));
        stopped = options?.signal?.aborted;
        return Promise.reject(options?.signal?.reason);
      },
    });
    const error = await assertRejects(
      reviewCheckout(client(new FakeResponses()), box, "https://g.example/r", {
        call: { signal: stop.signal },
      }),
    );
    assertEquals([stopped, error.message], [true, "cancelled"]);
    assert(
      await sandbox.acquireLease(WORKSPACE_LEASE) !== null,
      "the lease was given back",
    );
  }));

// MARK: adoption (WP-16 final)

// The sandbox now checks the workspace lease on every mutation. The bridge
// held the lease but sent no token from `sandboxWriteFile`, the clone of
// `reviewCheckout` or the discard of a stopped patch, so the sandbox
// refused its own writes (`lease_held`) or, in the discard, left the
// directories behind.
Deno.test("every mutation the bridge makes carries the lease it holds", () =>
  withSandbox(async ({ sandbox }) => {
    const tokens: string[] = [];
    const sent: { call: string; lease: string | undefined }[] = [];
    const box = boxOf(sandbox, {
      async acquireLease(name, options) {
        const lease = await sandbox.acquireLease(name, options);
        if (lease !== null) tokens.push(lease.token);
        return lease;
      },
      writeFile(path, content, options) {
        sent.push({ call: "writeFile", lease: options?.lease });
        return sandbox.writeFile(path, content, options);
      },
      renameFile(from, to, options) {
        sent.push({ call: "renameFile", lease: options?.lease });
        return sandbox.renameFile(from, to, options);
      },
      deleteFile(path, options) {
        sent.push({ call: "deleteFile", lease: options?.lease });
        return sandbox.deleteFile(path, options);
      },
      remove(path, options) {
        sent.push({ call: "remove", lease: options?.lease });
        return sandbox.remove(path, options);
      },
      exec(argv, options) {
        sent.push({ call: "exec", lease: options?.lease });
        return sandbox.exec(argv, options);
      },
      execShell(command, options) {
        sent.push({ call: "execShell", lease: options?.lease });
        return sandbox.execShell(command, options);
      },
      async gitCheckout(_url, options) {
        sent.push({ call: "gitCheckout", lease: options?.lease });
        await sandbox.writeFile("repo/a.py", "print(1)\n", {
          lease: options?.lease,
        });
        return CLONED;
      },
    });
    await sandboxWriteFile(box, "gone.txt", "bye\n");
    await sandboxWriteFile(box, "notes/a.txt", "keep\ndrop\n");
    await sandboxApplyPatch(
      box,
      "*** Begin Patch\n*** Update File: notes/a.txt\n@@\n keep\n-drop\n+kept\n*** Delete File: gone.txt\n*** End Patch\n",
    );
    await sandboxShellRunner(box).run({
      command: "true",
      workdir: null,
      timeoutMs: 5_000,
      signal,
    });
    await reviewCheckout(
      client(
        new FakeResponses([
          { text: JSON.stringify({ summary: "s", findings: [] }) },
        ]),
      ),
      box,
      "https://git.example/acme/repo",
    );
    // A patch stopped while staging discards what it staged, leased too.
    const stop = new AbortController();
    const stopping = boxOf(box as SandboxApi, {
      async writeFile(path, content, options) {
        await box.writeFile(path, content, options);
        stop.abort(new Error("stop"));
      },
    });
    await assertRejects(sandboxApplyPatch(
      stopping,
      "*** Begin Patch\n*** Add File: deep/x.txt\n+x\n*** Add File: deep/y.txt\n+y\n*** End Patch\n",
      { signal: stop.signal },
    ));
    assertEquals(
      new Set(sent.map((entry) => entry.call)),
      new Set([
        "writeFile",
        "renameFile",
        "deleteFile",
        "remove",
        "exec",
        "execShell",
        "gitCheckout",
      ]),
    );
    for (const entry of sent) {
      assert(
        entry.lease !== undefined && tokens.includes(entry.lease),
        `${entry.call} carries the held lease`,
      );
    }
    assertEquals(await sandbox.exists("deep"), { exists: false, kind: null });
    // And the sandbox refuses a mutation without it while the lease is held.
    const held = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(held !== null, "the lease was given back");
    const refused = await assertRejects(sandbox.writeFile("x.txt", "x"));
    assert(refused.message.includes("lease_held"), refused.message);
  }));

// A sandbox refusal of the lease (it was lost to another holder between
// the grant and the call) is a WorkspaceLeaseError, and the call is not
// tried again.
Deno.test("a lease the sandbox says is lost is a clear error, never retried", () =>
  withSandbox(async ({ sandbox }) => {
    let calls = 0;
    let other: string | null = null;
    const box = boxOf(sandbox, {
      async execShell(command, options) {
        calls++;
        // Another Worker takes the lease after this one's grant ran out.
        await sandbox.releaseLease(WORKSPACE_LEASE, options!.lease!);
        other = (await sandbox.acquireLease(WORKSPACE_LEASE))?.token ?? null;
        assert(other !== null, "another holder has the lease");
        return await sandbox.execShell(command, options);
      },
    });
    const registry = new ToolRegistry(sandboxCodingTools(box));
    const [result] = await registry.execute([{
      kind: "function",
      callId: "x",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "echo changed > out.txt" }),
    }], { timeoutMs: 20_000 });
    assertEquals(calls, 1);
    assertEquals(result.status, "error", result.output);
    assert(result.output.includes("lease"), result.output);
    assertEquals(await sandbox.exists("out.txt"), {
      exists: false,
      kind: null,
    });
    await sandbox.releaseLease(WORKSPACE_LEASE, other!);
    const direct = await assertRejects(
      sandboxShellRunner(box).run({
        command: "true",
        workdir: null,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      }),
    );
    assert(direct instanceof WorkspaceLeaseError, String(direct));
  }));

// `disassemble` only reads; it declares so (`mutates: false`), and runs
// while another Worker holds the workspace lease.
Deno.test("disassemble runs while another holder has the lease", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("sample", "hello strings world\n");
    const held = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(held !== null, "another Worker holds the lease");
    const seen: (boolean | undefined)[] = [];
    const box = boxOf(sandbox, {
      exec(argv, options) {
        seen.push(options?.mutates);
        return sandbox.exec(["cat", ...argv.slice(-1)], options);
      },
    });
    const out = await disassemble(box, "sample", { tool: "strings" });
    assertEquals(out.text, "hello strings world\n");
    assertEquals(seen, [false]);
  }));

// DB-REV-OAI-3 on the sandbox's side: a regex is `searchFiles`, which
// walks regular files inside the checked directory, rather than a script
// of the bridge's own run through `exec`.
Deno.test("regex grep_files is the sandbox's searchFiles", () =>
  withSandbox(async ({ sandbox, root, workspace }) => {
    await sandbox.writeFile("src/a.ts", "const x = eval(input);\n");
    await Deno.mkdir(`${root}/secret`);
    await Deno.writeTextFile(`${root}/secret/key.txt`, "eval(TOPSECRET)\n");
    await Deno.symlink(`${root}/secret/key.txt`, `${workspace}/src/key.ts`);
    const asked: { pattern: string; path?: string; regex?: boolean }[] = [];
    const execs: { argv: string; mutates?: boolean }[] = [];
    const box = boxOf(sandbox, {
      searchFiles(pattern, options) {
        asked.push({ pattern, path: options?.path, regex: options?.regex });
        return sandbox.searchFiles(pattern, options);
      },
      exec(argv, options) {
        execs.push({ argv: argv.join(" "), mutates: options?.mutates });
        return sandbox.exec(argv, options);
      },
    });
    const registry = new ToolRegistry(
      sandboxCodingTools(box, { readOnly: true }),
    );
    const [found, bad] = await registry.execute([
      grepCall("1", { pattern: "eval\\(", regex: true, path: "src" }),
      grepCall("2", { pattern: "[", regex: true }),
    ], { timeoutMs: 20_000 });
    assertEquals(found.output, "src/a.ts:1: const x = eval(input);");
    assertEquals(bad.status, "error");
    assert(bad.output.includes("bad pattern"), bad.output);
    // A pattern grep refuses never reaches the search.
    assertEquals(asked, [{ pattern: "eval\\(", path: "src", regex: true }]);
    // What still runs through exec is the read-only pattern check (one
    // line, no file), never a walk of the workspace.
    for (const exec of execs) {
      assertEquals(exec.mutates, false);
      assert(!exec.argv.includes("find"), exec.argv);
    }
  }));

// The sandbox's own pattern check runs grep over an empty file, which
// busybox's grep answers without compiling the pattern: a bad pattern then
// failed per file and came back as "no matches". The bridge checks it on
// one line first.
Deno.test("a bad regex is refused even where the sandbox's search would pass it", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("a.txt", "x\n");
    let searched = 0;
    const box = boxOf(sandbox, {
      // As busybox answers: every file failed, nothing matched.
      searchFiles() {
        searched++;
        return Promise.resolve({ matches: [], truncated: false });
      },
    });
    const registry = new ToolRegistry(
      sandboxCodingTools(box, { readOnly: true }),
    );
    const [bad] = await registry.execute([
      grepCall("1", { pattern: "a[", regex: true }),
    ], { timeoutMs: 20_000 });
    assertEquals(bad.status, "error");
    assert(bad.output.includes("bad pattern"), bad.output);
    assertEquals(searched, 0);
  }));

// DB-REV-OAI-2: the view checked a path with `stat`, component by
// component, and then read it: a directory swapped for a link between the
// two was followed. The read itself now refuses links (`noFollow`).
Deno.test("a directory view refuses a link swapped in before its read", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.writeFile("uploads/customer.env", "API_KEY=sk-live-123\n");
    await sandbox.writeFile("repo/src/customer.env", "fine\n");
    const box = boxOf(sandbox, {
      async readFile(path, options) {
        // A writer swaps the checked directory for a link just now.
        await Deno.remove(`${workspace}/repo/src`, { recursive: true });
        await Deno.symlink("../uploads", `${workspace}/repo/src`);
        return await sandbox.readFile(path, options);
      },
    });
    const view = sandboxDirectoryView(box, "repo");
    const error = await assertRejects(view.read("src/customer.env"));
    assert(!error.message.includes("sk-live"), error.message);
    assert(error.message.includes("symbolic link"), error.message);
  }));

// OAI-17 on the sandbox's side: the listing cursor names its page's last
// entry, and the sandbox refuses a page after the directory changed
// (`listing_changed`); `list` answers that as a ListingChangedError.
Deno.test("a listing that changed between pages is a ListingChangedError", () =>
  withSandbox(async ({ sandbox }) => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      await sandbox.writeFile(`dir/${name}.txt`, name);
    }
    let pages = 0;
    const box = boxOf(sandbox, {
      async listFiles(path, options?: ListFilesOptions) {
        if (pages++ === 1) {
          // Between the first and second page an entry goes.
          const { cursor: _cursor, ...fresh } = options ?? {};
          const first = await sandbox.listFiles(path, { ...fresh, limit: 2 });
          await sandbox.deleteFile(first.entries[0].path);
        }
        return await sandbox.listFiles(path, {
          ...options,
          limit: Math.min(options?.limit ?? 2, 2),
        });
      },
    });
    const error = await assertRejects(sandboxFileSystem(box).list("dir"));
    assert(error instanceof ListingChangedError, String(error));
    assertEquals(error.directory, "dir");
  }));
