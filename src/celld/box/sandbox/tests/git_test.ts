// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-SBX-008: gitCheckout with the host's git (the fake runs host
// processes). Nothing here reaches the network: the URLs are under
// `example.invalid`, so every clone that honours only its own settings
// fails, and the tests look at what a planted configuration would have
// done instead.

import { assert, assertEquals } from "@celld/core/assert";
import { rejectsWith, withSandbox } from "./fixture.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("a destination that is a symbolic link is refused, not followed", () =>
  withSandbox(async ({ sandbox, workspace, root }) => {
    await Deno.mkdir(`${root}/elsewhere`);
    await sandbox.ready();
    await Deno.symlink(`${root}/elsewhere`, `${workspace}/repo`);
    await rejectsWith(
      sandbox.gitCheckout("https://example.invalid/org/repo.git"),
      "exists",
    );
    assertEquals([...Deno.readDirSync(`${root}/elsewhere`)], []);
    await Deno.mkdir(`${workspace}/taken`);
    await rejectsWith(
      sandbox.gitCheckout("https://example.invalid/org/repo.git", {
        targetDir: "taken",
      }),
      "exists",
    );
  }));

Deno.test("configuration planted in the workspace or the environment is ignored", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const rewrite = (marker: string) =>
      `[url "ext::sh -c touch% ${workspace}/${marker};:% "]\n` +
      "\tinsteadOf = https://example.invalid/\n" +
      '[protocol "ext"]\n\tallow = always\n';
    // Where HOME used to be, and a file the environment points git at.
    await sandbox.writeFile(".gitconfig", rewrite("pwned-home"));
    await sandbox.writeFile("evil.gitconfig", rewrite("pwned-env"));
    const home = await sandbox.gitCheckout("https://example.invalid/org/a.git");
    assertEquals(home.success, false);
    await sandbox.setEnvVars({
      GIT_CONFIG_GLOBAL: `${workspace}/evil.gitconfig`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.ext.allow",
      GIT_CONFIG_VALUE_0: "always",
    });
    const env = await sandbox.gitCheckout("https://example.invalid/org/b.git");
    assertEquals(env.success, false);
    assertEquals(await exists(`${workspace}/pwned-home`), false);
    assertEquals(await exists(`${workspace}/pwned-env`), false);
  }));

Deno.test("a planted hooks path never runs", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    // A real repository to clone, reachable only through a planted rewrite.
    const made = await sandbox.execShell(
      [
        "git init -q --bare -b main src.git",
        "git init -q -b main w",
        "cd w",
        "git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m x",
        "git push -q ../src.git main",
      ].join(" && "),
    );
    assertEquals(made.exitCode, 0, made.stderr);
    await sandbox.writeFile(
      "hooks/post-checkout",
      `#!/bin/sh\ntouch ${workspace}/pwned-hook\n`,
      { mode: "755" },
    );
    await sandbox.writeFile(
      ".gitconfig",
      `[core]\n\thooksPath = ${workspace}/hooks\n` +
        `[url "${workspace}/src.git"]\n\tinsteadOf = https://example.invalid/src\n`,
    );
    const result = await sandbox.gitCheckout("https://example.invalid/src", {
      targetDir: "clone",
    });
    assertEquals(result.success, false);
    assertEquals(await exists(`${workspace}/pwned-hook`), false);
  }));

Deno.test("only https URLs of public hosts are cloned", () =>
  withSandbox(async ({ sandbox }) => {
    for (
      const url of [
        "https://127.0.0.1/org/repo.git",
        "https://localhost/org/repo.git",
        "https://app.localhost/org/repo.git",
        "https://10.1.2.3/org/repo.git",
        "https://169.254.169.254/latest/meta-data",
        "https://192.168.0.1:8443/org/repo",
        "https://100.64.0.1/org/repo",
      ]
    ) {
      await rejectsWith(sandbox.gitCheckout(url), "invalid");
    }
    const failed = await sandbox.gitCheckout(
      "https://example.invalid/org/repo.git",
    );
    assert(!failed.success, "example.invalid does not resolve");
  }));
