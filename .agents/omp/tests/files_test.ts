// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkspaceFile,
  workspacePath,
  writeWorkspaceFile,
} from "../lib/files.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error, "Expected a filesystem boundary error");
    return;
  }
  throw new Error("Expected artifact operation to fail");
}

Deno.test("artifact publication is private and never clobbers without explicit overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-artifacts-"));
  try {
    const path = await writeWorkspaceFile(
      root,
      "results/report.json",
      '{"status":"original"}',
    );
    assert(
      ((await stat(path)).mode & 0o777) === 0o600,
      "Artifact permissions expose private evidence",
    );
    await rejects(() =>
      writeWorkspaceFile(root, "results/report.json", '{"status":"unexpected"}')
    );
    assert(
      await readFile(path, "utf8") === '{"status":"original"}',
      "Refused publication changed existing evidence",
    );
    await writeWorkspaceFile(
      root,
      "results/report.json",
      '{"status":"updated"}',
      true,
    );
    assert(
      (await readWorkspaceFile(root, "results/report.json")).bytes.toString(
        "utf8",
      ) === '{"status":"updated"}',
      "Explicit refresh did not publish new evidence",
    );
    assert(
      JSON.stringify(await readdir(join(root, "results"))) ===
        '["report.json"]',
      "Private staging artifacts leaked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("artifact boundaries reject traversal, symlinks, non-files and oversized input", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "omp-artifact-boundary-"));
  const root = join(fixture, "workspace");
  const outside = join(fixture, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "unchanged");
    await symlink(outside, join(root, "linked"), "dir");
    await rejects(() => workspacePath(root, "../outside/sentinel"));
    await rejects(() => readWorkspaceFile(root, "linked/sentinel"));
    await rejects(() =>
      writeWorkspaceFile(root, "linked/new", "must not escape")
    );
    await rejects(() => readWorkspaceFile(root, "."));
    await writeFile(join(root, "large"), "abcd");
    await rejects(() => readWorkspaceFile(root, "large", 3));
    assert(
      await readFile(join(outside, "sentinel"), "utf8") === "unchanged",
      "Outside input modified",
    );
    assert(
      JSON.stringify(await readdir(outside)) === '["sentinel"]',
      "Output escaped the workspace",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
