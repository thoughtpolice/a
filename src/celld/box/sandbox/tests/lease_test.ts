// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the openai bridge needs from the sandbox (DB-REV-OAI-2, -3, -8,
// -13, -14): a workspace lease the sandbox enforces, a search that never
// follows a link out of the workspace, and clones without symbolic links.
// Also the review findings whose fix changed an interface
// (DB-REV-SBX-9, DB-REV-SBX-11).

import { assert, assertEquals } from "@celld/core/assert";
import { ContainerController } from "@celld/box/container";
import {
  type ExecCall,
  FakeContainer,
  FakeState,
  type ScriptedExec,
} from "@celld/box/container/testing";
import {
  parseSSEStream,
  resolveSettings,
  SandboxCore,
  SandboxError,
  type SandboxEvent,
  type SandboxSettings,
  WORKSPACE_LEASE,
} from "@celld/box/sandbox";
import { eventually, rejectsWith, withSandbox } from "./fixture.ts";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

// The pid a command wrote to `file` in the workspace, once it exists.
async function pidIn(workspace: string, file: string): Promise<number> {
  let text = "";
  await eventually(async () => {
    text = (await Deno.readTextFile(`${workspace}/${file}`).catch(() => ""))
      .trim();
    return text !== "";
  });
  return Number(text);
}

function scripted(
  answer: (
    call: ExecCall,
  ) => ScriptedExec | null | Promise<ScriptedExec | null>,
  settings: Partial<SandboxSettings> = {},
) {
  const container = new FakeContainer({
    exec: async (call) => (await answer(call)) ?? {},
  });
  const state = new FakeState(container);
  const controller = new ContainerController(state);
  let n = 0;
  const sandbox = new SandboxCore(
    controller,
    state.kv,
    { tier: "trusted", ...settings },
    () => `01J00000000000000000000${String(n++).padStart(3, "0")}`,
  );
  return { container, state, controller, sandbox };
}

// MARK: The workspace lease (DB-REV-OAI-8, -13, -14)

Deno.test("while another caller holds the workspace lease, every mutation needs its token", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.writeFile("a.txt", "a");
    await sandbox.mkdir("d");
    const lease = (await sandbox.acquireLease(WORKSPACE_LEASE))!;
    assert(lease !== null, "taken");
    const refused: [string, Promise<unknown>][] = [
      ["writeFile", sandbox.writeFile("b.txt", "b")],
      ["mkdir", sandbox.mkdir("e")],
      ["deleteFile", sandbox.deleteFile("a.txt")],
      ["remove", sandbox.remove("d")],
      ["renameFile", sandbox.renameFile("a.txt", "c.txt")],
      ["moveFile", sandbox.moveFile("a.txt", "c.txt")],
      ["exec", sandbox.exec(["touch", "x"])],
      ["execShell", sandbox.execShell("touch x")],
      [
        "gitCheckout",
        sandbox.gitCheckout("https://example.invalid/org/repo.git"),
      ],
      ["startProcess", sandbox.startProcess(["touch", "x"])],
      [
        "openStream exec",
        sandbox.openStream({ kind: "exec", argv: ["touch", "x"] }),
      ],
      [
        "openStream write",
        sandbox.openStream({ kind: "write", path: "x" }),
      ],
    ];
    for (const [what, call] of refused) {
      const error = await rejectsWith(call, "lease_held").catch((e) => {
        throw new Error(`${what}: ${e}`);
      });
      assert(error.detail.includes("workspace"), error.detail);
    }
    assertEquals(await exists(`${workspace}/x`), false);
    assertEquals(await exists(`${workspace}/b.txt`), false);
    assertEquals(await exists(`${workspace}/a.txt`), true);
    // Reads, and a command declared read-only, go ahead.
    assertEquals((await sandbox.readFile("a.txt")).content, "a");
    assertEquals((await sandbox.listFiles("")).entries.length, 2);
    assertEquals(
      (await sandbox.exec(["cat", "a.txt"], { mutates: false })).stdout,
      "a",
    );
    // The holder's token lets each of them through.
    const held = { lease: lease.token };
    await sandbox.writeFile("b.txt", "b", held);
    await sandbox.mkdir("e", { recursive: true, ...held });
    await sandbox.renameFile("b.txt", "c.txt", held);
    await sandbox.moveFile("c.txt", "e/c.txt", held);
    await sandbox.deleteFile("e/c.txt", held);
    await sandbox.remove("e", held);
    assertEquals((await sandbox.exec(["touch", "x"], held)).exitCode, 0);
    const started = await sandbox.startProcess(["true"], held);
    await sandbox.waitForExit(started.id);
    const ticket = await sandbox.openStream({
      kind: "write",
      path: "streamed.txt",
      options: held,
    });
    await (await sandbox.stream(ticket, new Blob(["s"]).stream())).json();
    assertEquals(await Deno.readTextFile(`${workspace}/streamed.txt`), "s");
    // A token that no longer holds the lease is lost, not ignored.
    assertEquals(
      await sandbox.releaseLease(WORKSPACE_LEASE, lease.token),
      true,
    );
    await rejectsWith(sandbox.writeFile("y", "y", held), "lease_lost");
    await rejectsWith(sandbox.exec(["touch", "y"], held), "lease_lost");
    assertEquals(await exists(`${workspace}/y`), false);
    // With the lease free, a call without one goes ahead.
    await sandbox.writeFile("y", "y");
    await rejectsWith(
      sandbox.writeFile("z", "z", { lease: "nope" }),
      "invalid",
    );
  }));

Deno.test("taking the workspace lease stops a mutating command that runs without it", () =>
  withSandbox(async ({ sandbox, workspace, controller }) => {
    const running = sandbox.execShell("echo $$ > pid; exec sleep 30", {
      timeoutMs: 60_000,
    });
    running.catch(() => {});
    const pid = await pidIn(workspace, "pid");
    const lease = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(lease !== null, "taken");
    await rejectsWith(running, "lease_held");
    await eventually(async () => !(await alive(pid)), 3_000);
    await eventually(() => Promise.resolve(!controller.isBusy), 3_000);
    // A read-only command is not stopped.
    const reader = sandbox.execShell("echo $$ > rpid; sleep 0.5; echo done", {
      mutates: false,
    });
    await pidIn(workspace, "rpid");
    await sandbox.releaseLease(WORKSPACE_LEASE, lease.token);
    assert(await sandbox.acquireLease(WORKSPACE_LEASE) !== null, "again");
    assertEquals((await reader).stdout, "done\n");
  }));

Deno.test("a command whose lease expired is stopped when another caller takes it", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const first = (await sandbox.acquireLease(WORKSPACE_LEASE, {
      ttlMs: 200,
    }))!;
    const running = sandbox.execShell("echo $$ > pid; exec sleep 30", {
      timeoutMs: 60_000,
      lease: first.token,
    });
    running.catch(() => {});
    const pid = await pidIn(workspace, "pid");
    await sleep(300);
    // Expired but not taken: the command goes on (nobody else mutates).
    assert(await alive(pid), "still running");
    const second = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(second !== null, "the next caller takes it");
    await rejectsWith(running, "lease_lost");
    await eventually(async () => !(await alive(pid)), 3_000);
  }));

// Filed by the openai adoption fixer: a token that no longer held the
// lease came back `lease_held` when another caller held it by then, and
// `lease_lost` only when nobody did. The call names a lease it lost
// either way.
Deno.test("a stale token is lease_lost whether or not another caller holds it now", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const first = (await sandbox.acquireLease(WORKSPACE_LEASE))!;
    assert(first !== null, "taken");
    const stale = { lease: first.token };
    const ticket = await sandbox.openStream({
      kind: "write",
      path: "t.txt",
      options: stale,
    });
    assert(await sandbox.releaseLease(WORKSPACE_LEASE, first.token), "given");
    const second = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(second !== null, "the next caller takes it");
    await rejectsWith(sandbox.writeFile("x", "x", stale), "lease_lost");
    await rejectsWith(sandbox.exec(["touch", "x"], stale), "lease_lost");
    await rejectsWith(sandbox.mkdir("d", stale), "lease_lost");
    await rejectsWith(sandbox.startProcess(["true"], stale), "lease_lost");
    await rejectsWith(
      sandbox.stream(ticket, new Blob(["x"]).stream()),
      "lease_lost",
    );
    assertEquals(await exists(`${workspace}/x`), false);
    assertEquals(await exists(`${workspace}/d`), false);
    assertEquals(await exists(`${workspace}/t.txt`), false);
    // Without a token it is still `lease_held`.
    await rejectsWith(sandbox.writeFile("x", "x"), "lease_held");
  }));

Deno.test("a stream ticket redeemed after another caller took the lease is refused", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const exec = await sandbox.openStream({
      kind: "shell",
      script: "touch late",
    });
    const write = await sandbox.openStream({ kind: "write", path: "late2" });
    const lease = await sandbox.acquireLease(WORKSPACE_LEASE);
    assert(lease !== null, "taken");
    await rejectsWith(sandbox.stream(exec, null), "lease_held");
    await rejectsWith(
      sandbox.stream(write, new Blob(["x"]).stream()),
      "lease_held",
    );
    assertEquals(await exists(`${workspace}/late`), false);
    assertEquals(await exists(`${workspace}/late2`), false);
    // A read-only streamed command runs.
    const read = await sandbox.openStream({
      kind: "exec",
      argv: ["echo", "hi"],
      options: { mutates: false },
    });
    const events: SandboxEvent[] = [];
    for await (
      const event of parseSSEStream<SandboxEvent>(
        (await sandbox.stream(read, null)).body!,
      )
    ) {
      events.push(event);
    }
    assert(
      events.some((event) => event.type === "stdout" && event.data === "hi\n"),
      JSON.stringify(events),
    );
  }));

Deno.test("a gitCheckout during another caller's lease never touches the workspace", async () => {
  const { sandbox, container } = scripted(() => null);
  const lease = (await sandbox.acquireLease(WORKSPACE_LEASE))!;
  const before = container.execs.length;
  await rejectsWith(
    sandbox.gitCheckout("https://example.com/org/repo.git"),
    "lease_held",
  );
  assertEquals(container.execs.length, before);
  await sandbox.gitCheckout("https://example.com/org/repo.git", {
    lease: lease.token,
  });
  assert(container.execs.length > before, "the leased clone ran");
});

// MARK: searchFiles (DB-REV-OAI-3)

Deno.test("searchFiles never follows a link out of the workspace", () =>
  withSandbox(async ({ sandbox, workspace, root }) => {
    await Deno.mkdir(`${root}/secret`);
    await Deno.writeTextFile(`${root}/secret/key.txt`, "TOPSECRET=hunter2\n");
    await sandbox.writeFile("src/a.txt", "one TOPSECRET here\ntwo\n");
    await sandbox.writeFile(".hidden/b.txt", "TOPSECRET hidden\n");
    await Deno.symlink(`${root}/secret`, `${workspace}/link`);
    await Deno.symlink(`${root}/secret/key.txt`, `${workspace}/src/key.txt`);
    for (const regex of [false, true]) {
      const found = await sandbox.searchFiles("TOPSECRET", { regex });
      assertEquals(
        found.matches.map((match) => `${match.path}:${match.line}`).sort(),
        [".hidden/b.txt:1", "src/a.txt:1"],
      );
    }
    await rejectsWith(
      sandbox.searchFiles("TOPSECRET", { path: "link" }),
      "outside_workspace",
    );
    await rejectsWith(
      sandbox.searchFiles("TOPSECRET", { path: "src/key.txt" }),
      "outside_workspace",
    );
    const inSrc = await sandbox.searchFiles("top.*here", {
      path: "src",
      regex: true,
      ignoreCase: true,
    });
    assertEquals(inSrc.matches, [
      { path: "src/a.txt", line: 1, text: "one TOPSECRET here" },
    ]);
    const visible = await sandbox.searchFiles("TOPSECRET", {
      includeHidden: false,
    });
    assertEquals(visible.matches.map((match) => match.path), ["src/a.txt"]);
    // A literal pattern is literal.
    assertEquals((await sandbox.searchFiles("T.PSECRET")).matches, []);
    await rejectsWith(
      sandbox.searchFiles("a(", { regex: true }),
      "invalid",
    );
    const capped = await sandbox.searchFiles("o", { maxMatches: 1 });
    assertEquals([capped.matches.length, capped.truncated], [1, true]);
  }));

Deno.test("searchFiles only reads, so it runs while another caller holds the lease", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("a.txt", "needle\n");
    assert(await sandbox.acquireLease(WORKSPACE_LEASE) !== null, "taken");
    assertEquals((await sandbox.searchFiles("needle")).matches.length, 1);
  }));

// MARK: gitCheckout without symbolic links (DB-REV-OAI-2)

// A git that clones a local repository for the test's URL (and nothing
// else), so the clone script's own options are what is tested.
async function localGit(repository: string) {
  const bin = await Deno.realPath(await Deno.makeTempDir());
  const real = new TextDecoder().decode(
    (await new Deno.Command("sh", { args: ["-c", "command -v git"] })
      .output()).stdout,
  ).trim();
  await Deno.writeTextFile(
    `${bin}/git`,
    `#!/bin/sh
for a do
  shift
  case "$a" in https://example.invalid/linked) a="file://${repository}";; esac
  set -- "$@" "$a"
done
GIT_ALLOW_PROTOCOL=https:file exec "${real}" -c protocol.file.allow=always "$@"
`,
  );
  await Deno.chmod(`${bin}/git`, 0o755);
  return bin;
}

async function repositoryWithLink(root: string): Promise<string> {
  const repository = `${root}/upstream`;
  await Deno.mkdir(repository);
  await Deno.writeTextFile(`${repository}/README`, "hello\n");
  await Deno.symlink("..", `${repository}/up`);
  const run = (args: string[]) =>
    new Deno.Command("git", {
      args,
      cwd: repository,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).output();
  for (
    const args of [
      ["init", "-q", "-b", "main"],
      ["add", "README", "up"],
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "-m",
        "x",
      ],
    ]
  ) {
    const done = await run(args);
    assert(done.success, new TextDecoder().decode(done.stderr));
  }
  return repository;
}

Deno.test("a clone checks symbolic links out as plain files", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const bin = await localGit(await repositoryWithLink(root));
    await withSandbox(async ({ sandbox, workspace }) => {
      const clone = await sandbox.gitCheckout(
        "https://example.invalid/linked",
        { targetDir: "safe" },
      );
      assertEquals(clone.exitCode, 0, clone.stderr);
      const up = await Deno.lstat(`${workspace}/safe/up`);
      assertEquals([up.isSymlink, up.isFile], [false, true]);
      assertEquals(await Deno.readTextFile(`${workspace}/safe/up`), "..");
      // So a view scoped to the checkout cannot reach the rest.
      await rejectsWith(sandbox.readFile("safe/up/README"), "not_found");
      // The repository keeps the setting for later checkouts.
      const config = await sandbox.exec(
        ["git", "config", "--get", "core.symlinks"],
        { cwd: "safe", mutates: false },
      );
      assertEquals(config.stdout.trim(), "false");
      // The old behaviour is there, named for what it is.
      const linked = await sandbox.gitCheckout(
        "https://example.invalid/linked",
        { targetDir: "linked", unsafeSymlinks: true },
      );
      assertEquals(linked.exitCode, 0, linked.stderr);
      assert((await Deno.lstat(`${workspace}/linked/up`)).isSymlink, "a link");
    }, {
      settings: {
        baseEnv: {
          PATH: `${bin}:${"/usr/local/bin:/usr/bin:/bin"}`,
          HOME: `${bin}/home`,
          LANG: "C.UTF-8",
        },
      },
    });
    await Deno.remove(bin, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// MARK: DB-REV-SBX-9

// DB-REV-SBX-9: the escape sweep allowed the sessions of every running
// record by number. A background process that had ended unnoticed left its
// pid in the allow list, and a process that got that pid again could call
// setsid and pass as the record's session. Records now carry the start
// times of their pids, and SWEEP allows a recorded session only while its
// pid is gone or still the process that was recorded.
Deno.test("DB-REV-SBX-9: the sweep allows a recorded session only for the recorded process", async () => {
  let sweep = null as string[] | null;
  const { sandbox } = scripted((call) => {
    if (call.argv.some((arg) => arg.includes('mkfifo "$d/o"'))) {
      return { stdout: "4900010 700 4900011 800\n" };
    }
    if (call.argv.some((arg) => arg.includes("listed()"))) {
      sweep = [...call.argv];
    }
    return null;
  }, { sweepEscapes: true });
  await sandbox.startProcess(["server"]);
  await sandbox.exec(["true"]);
  assert(sweep !== null, "the sweep ran");
  const argv = sweep;
  const at = argv.indexOf("celld-sandbox");
  const script = argv[at - 1];
  assertEquals(argv.slice(at + 1), ["/proc", "4900010:700", "4900011:800"]);

  // The script itself, over a made-up /proc whose pids are above any
  // kernel's pid_max, so its kills reach nothing on this host.
  const proc = await Deno.realPath(await Deno.makeTempDir());
  const stat = (
    pid: number,
    ppid: number,
    sid: number,
    start: number,
    state = "S",
  ) =>
    Deno.mkdir(`${proc}/${pid}`).then(() =>
      Deno.writeTextFile(
        `${proc}/${pid}/stat`,
        `${pid} (sh) ${state} ${ppid} ${sid} ${sid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`,
      )
    );
  try {
    // The recorded leader, alive, and its child.
    await stat(4900010, 4900090, 4900010, 700);
    await stat(4900020, 4900010, 4900010, 710);
    // The recorded supervisor's session: its leader is gone, a member stays.
    await stat(4900021, 4900090, 4900011, 810);
    // A process that took over a recorded pid (other start time) and made
    // itself a session with it, and a member of that session.
    await stat(4900012, 4900090, 4900012, 999);
    await stat(4900022, 4900012, 4900012, 1000);
    const out = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        script,
        "celld-sandbox",
        proc,
        "4900010:700",
        "4900011:800",
        "4900012:500",
      ],
    }).output();
    const killed = new TextDecoder().decode(out.stdout).trim().split("\n");
    assertEquals(killed, ["4900012", "4900022"]);
    assertEquals(out.code, 1, "nothing was killed, so they are still there");
  } finally {
    await Deno.remove(proc, { recursive: true });
  }
});

// MARK: DB-REV-SBX-11

// DB-REV-SBX-11: baseEnv was checked only against the schema (256 values
// of 120 KiB), and the RUN wrapper repeated all of it on top of the
// merged environment, so permitted settings could pass ARG_MAX.
Deno.test("DB-REV-SBX-11: baseEnv is held to maxEnvBytes and sent once", async () => {
  const big: Record<string, string> = { PATH: "/usr/bin:/bin" };
  for (let i = 0; i < 8; i++) big[`V${i}`] = "x".repeat(115 * 1024);
  try {
    resolveSettings({ tier: "trusted", baseEnv: big, maxEnvBytes: 768 * 1024 });
    throw new Error("a 920 KiB baseEnv was accepted");
  } catch (error) {
    assertEquals(SandboxError.from(error)?.code, "invalid");
  }
  const { sandbox, container } = scripted(() => null);
  await sandbox.exec(["true"]);
  const run = container.execs.find((call) =>
    call.argv.some((arg) => arg.includes("exec 3<&0"))
  )!;
  const shell = run.argv.indexOf("/bin/sh");
  assertEquals(run.argv.slice(0, shell), [
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ]);
  const inner = run.argv.slice(shell);
  for (
    const variable of [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/tmp/.celld-sandbox/home",
      "LANG=C.UTF-8",
    ]
  ) {
    assertEquals(inner.filter((arg) => arg === variable).length, 1, variable);
  }
});

// MARK: Filed by the openai fixer

// DB-REV-OAI-2 residual (filed): a view of part of the workspace checked a
// path with `stat` and then read it, so a directory swapped for a link in
// between slipped one read through, and a committed link led out of the
// view. `noFollow` makes the check and the read one step.
Deno.test("noFollow refuses a symbolic link at the path or on its way", () =>
  withSandbox(async ({ sandbox, workspace, root }) => {
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(`${root}/outside/secret`, "no\n");
    await sandbox.writeFile("other.txt", "workspace data\n");
    await sandbox.writeFile("repo/README", "hello\n");
    await sandbox.writeFile("repo/sub/deep.txt", "deep\n");
    await Deno.symlink("..", `${workspace}/repo/up`);
    await Deno.symlink("README", `${workspace}/repo/lnk`);
    await Deno.symlink("sub", `${workspace}/repo/alias`);
    const strict = { noFollow: true };
    // Links inside the workspace are followed without it.
    assertEquals(
      (await sandbox.readFile("repo/up/other.txt")).content,
      "workspace data\n",
    );
    for (
      const path of [
        "repo/up/other.txt",
        "repo/lnk",
        "repo/alias/deep.txt",
      ]
    ) {
      await rejectsWith(sandbox.readFile(path, strict), "is_symlink");
    }
    assertEquals(
      (await sandbox.readFile("repo/sub/deep.txt", strict)).content,
      "deep\n",
    );
    assertEquals(
      (await sandbox.readFile("repo/README", { ...strict, encoding: "bytes" }))
        .size,
      6,
    );
    await rejectsWith(sandbox.readFile("repo/missing", strict), "not_found");
    await rejectsWith(sandbox.readFile("repo/sub", strict), "is_directory");
    await rejectsWith(sandbox.stat("repo/up", strict), "is_symlink");
    await rejectsWith(sandbox.stat("repo/up/repo", strict), "is_symlink");
    assertEquals((await sandbox.stat("repo", strict)).kind, "dir");
    assertEquals((await sandbox.stat("", strict)).kind, "dir");
    assertEquals((await sandbox.stat("repo/README", strict)).size, 6);
    await rejectsWith(sandbox.exists("repo/lnk", strict), "is_symlink");
    assertEquals(
      await sandbox.exists("repo/nothing", strict),
      { exists: false, kind: null },
    );
    await rejectsWith(sandbox.listFiles("repo/up", strict), "is_symlink");
    await rejectsWith(sandbox.listFiles("repo/alias", strict), "is_symlink");
    const listing = await sandbox.listFiles("repo", {
      ...strict,
      recursive: true,
    });
    assertEquals(
      listing.entries.map((entry) => `${entry.path} ${entry.kind}`),
      [
        "repo/README file",
        "repo/alias symlink",
        "repo/lnk symlink",
        "repo/sub dir",
        "repo/sub/deep.txt file",
        "repo/up symlink",
      ],
    );
    // A link out of the workspace is still outside_workspace without it.
    await Deno.symlink(`${root}/outside`, `${workspace}/out`);
    await rejectsWith(sandbox.readFile("out/secret"), "outside_workspace");
    await rejectsWith(sandbox.readFile("out/secret", strict), "is_symlink");
  }));

// Filed by the openai adoption fixer: `searchFiles` followed a link on
// the way to its directory, so a bridge had to `stat` it with `noFollow`
// first, and a directory swapped for a link in between was searched.
// `noFollow` makes the check and the walk one exec.
Deno.test("searchFiles with noFollow refuses a link on the way to its directory", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.writeFile("repo/sub/deep.txt", "needle\n");
    await sandbox.writeFile("elsewhere/other.txt", "needle elsewhere\n");
    await Deno.symlink("..", `${workspace}/repo/up`);
    const strict = { noFollow: true };
    assertEquals(
      (await sandbox.searchFiles("needle", { ...strict, path: "repo/sub" }))
        .matches,
      [{ path: "repo/sub/deep.txt", line: 1, text: "needle" }],
    );
    assertEquals(
      (await sandbox.searchFiles("needle", { ...strict, path: "" })).matches
        .length,
      2,
    );
    // The directory is swapped for a link to another one in the workspace.
    await Deno.rename(`${workspace}/repo/sub`, `${workspace}/repo/moved`);
    await Deno.symlink("../elsewhere", `${workspace}/repo/sub`);
    await rejectsWith(
      sandbox.searchFiles("needle", { ...strict, path: "repo/sub" }),
      "is_symlink",
    );
    await rejectsWith(
      sandbox.searchFiles("needle", {
        ...strict,
        path: "repo/up/repo/moved",
        regex: true,
      }),
      "is_symlink",
    );
    await rejectsWith(
      sandbox.searchFiles("needle", { ...strict, path: "repo/nothing" }),
      "not_found",
    );
    await rejectsWith(
      sandbox.searchFiles("needle", { ...strict, path: "repo/moved/deep.txt" }),
      "not_directory",
    );
    // Without it, the link inside the workspace is followed as before.
    assertEquals(
      (await sandbox.searchFiles("needle", { path: "repo/sub" })).matches,
      [{ path: "repo/sub/other.txt", line: 1, text: "needle elsewhere" }],
    );
  }));

// DB-REV-OAI-17 (filed): a listing cursor was a line offset into the walk,
// so a directory that changed between pages made the next page skip or
// repeat entries without a word. The cursor now names the page's last
// entry, and a page that no longer follows it is `listing_changed`.
Deno.test("a listing page after the directory changed is refused, never skewed", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    for (let i = 0; i < 12; i++) {
      await sandbox.writeFile(`d/f${String(i).padStart(2, "0")}`, "x");
    }
    const first = await sandbox.listFiles("d", { limit: 4, sort: false });
    assertEquals([first.entries.length, first.truncated], [4, true]);
    // Unchanged, the pages cover every entry once.
    const seen = first.entries.map((entry) => entry.path);
    let cursor = first.cursor;
    while (cursor !== undefined) {
      const page = await sandbox.listFiles("d", {
        limit: 4,
        sort: false,
        cursor,
      });
      seen.push(...page.entries.map((entry) => entry.path));
      cursor = page.cursor;
    }
    assertEquals(seen.length, 12);
    assertEquals(new Set(seen).size, 12);
    // An entry of the first page goes: the next page would skip one.
    await Deno.remove(`${workspace}/${first.entries[0].path}`);
    await rejectsWith(
      sandbox.listFiles("d", { limit: 4, sort: false, cursor: first.cursor }),
      "listing_changed",
    );
    await rejectsWith(
      sandbox.listFiles("d", { limit: 4, cursor: "4.bm90IGEgY3Vyc29y" }),
      "invalid",
    );
  }));
