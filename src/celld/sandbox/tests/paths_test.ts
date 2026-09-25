// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import { checkDirectory, workspaceEntry, workspacePath } from "@celld/sandbox";
import { rejectsWith } from "./fixture.ts";

const W = "/workspace";

Deno.test("relative and absolute paths normalise into the workspace", () => {
  for (
    const [path, relative] of [
      ["", ""],
      [".", ""],
      ["a/b.txt", "a/b.txt"],
      ["./a//b/../c", "a/c"],
      ["/workspace", ""],
      ["/workspace/src/x.ts", "src/x.ts"],
      ["/workspace/a/../b", "b"],
      ["a/..", ""],
    ]
  ) {
    const resolved = workspacePath(W, path);
    assertEquals(resolved.relative, relative, path);
    assertEquals(
      resolved.absolute,
      relative === "" ? W : `${W}/${relative}`,
      path,
    );
  }
});

Deno.test("paths that leave the workspace are refused", async () => {
  for (
    const [path, code] of [
      ["..", "outside_workspace"],
      ["a/../../etc", "outside_workspace"],
      ["/etc/passwd", "outside_workspace"],
      ["/workspace2/x", "outside_workspace"],
      ["/", "outside_workspace"],
      ["~", "invalid_path"],
      ["~/x", "invalid_path"],
      ["a\0b", "invalid_path"],
      ["a\nb", "invalid_path"],
      ["x".repeat(5000), "invalid_path"],
    ] as const
  ) {
    await rejectsWith(
      Promise.resolve().then(() => workspacePath(W, path)),
      code,
    );
  }
});

Deno.test("an entry cannot be the root", async () => {
  assertEquals(workspaceEntry(W, "a").absolute, "/workspace/a");
  await rejectsWith(
    Promise.resolve().then(() => workspaceEntry(W, "a/..")),
    "invalid_path",
  );
});

Deno.test("directory settings are absolute and not the root", async () => {
  assertEquals(checkDirectory("/a//b/./", "x"), "/a/b");
  for (const bad of ["relative", "/", "/a/../b", "/a\0"]) {
    await rejectsWith(
      Promise.resolve().then(() => checkDirectory(bad, "x")),
      "invalid",
    );
  }
});
