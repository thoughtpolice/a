// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  applyChunks,
  applyPatch,
  ApplyPatchError,
  MemoryFileSystem,
  parsePatch,
  seekSequence,
} from "@celld/api/openai/coding";
import { SCENARIOS } from "./apply_patch_scenarios.ts";

/**
 * Codex applies hunks one at a time and leaves earlier ones in place when a
 * later one fails; this library applies a patch all or nothing, so the one
 * scenario that pins the partial behaviour expects the untouched input.
 */
const ATOMIC_OVERRIDES: Record<string, Record<string, string>> = {
  "015_failure_after_partial_success_leaves_changes": {},
};

for (const scenario of SCENARIOS) {
  Deno.test(`codex scenario ${scenario.name}`, async () => {
    const fs = new MemoryFileSystem({ ...scenario.input });
    try {
      await applyPatch(fs, scenario.patch);
    } catch (error) {
      // Scenarios are specified by the final tree; failures are expected.
      assert(error instanceof ApplyPatchError, `unexpected ${error}`);
    }
    assertEquals(
      fs.snapshot(),
      ATOMIC_OVERRIDES[scenario.name] ?? scenario.expected,
    );
  });
}

async function failure(promise: Promise<unknown>): Promise<ApplyPatchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApplyPatchError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

function parseError(patch: string): string {
  try {
    parsePatch(patch);
  } catch (error) {
    return (error as Error).message;
  }
  return "parsed";
}

Deno.test("parse errors carry Codex's messages and line numbers", () => {
  assertEquals(
    parseError("bad"),
    "invalid patch: The first line of the patch must be '*** Begin Patch'",
  );
  assertEquals(
    parseError("*** Begin Patch\nbad"),
    "invalid patch: The last line of the patch must be '*** End Patch'",
  );
  assertEquals(
    parseError("*** Begin Patch\n*** Update File: test.py\n*** End Patch"),
    "invalid hunk at line 2, Update file hunk for path 'test.py' is empty",
  );
  assertEquals(
    parseError("*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"),
    "invalid hunk at line 2, '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
  );
  assertEquals(
    parseError("*** Begin Patch\n*** Update File: a\n@@\n*** End Patch"),
    "invalid hunk at line 4, Update hunk does not contain any lines",
  );
  assertEquals(
    parseError(
      "*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\nnot a diff line\n*** End Patch",
    ),
    "invalid hunk at line 6, Expected update hunk to start with a @@ context marker, got: 'not a diff line'",
  );
});

Deno.test("the parser builds hunks the way Codex does", () => {
  const { hunks } = parsePatch([
    "*** Begin Patch",
    "*** Add File: path/add.py",
    "+abc",
    "+def",
    "*** Delete File: path/delete.py",
    "*** Update File: path/update.py",
    "*** Move to: path/update2.py",
    "@@ def f():",
    "-    pass",
    "+    return 123",
    "*** End Patch",
  ].join("\n"));
  assertEquals(hunks, [
    { type: "add", path: "path/add.py", contents: "abc\ndef\n" },
    { type: "delete", path: "path/delete.py" },
    {
      type: "update",
      path: "path/update.py",
      movePath: "path/update2.py",
      chunks: [{
        changeContext: "def f():",
        oldLines: ["    pass"],
        newLines: ["    return 123"],
        contextLineIndices: [],
        isEndOfFile: false,
      }],
    },
  ]);
});

Deno.test("a first chunk needs no @@, and context lines are recorded", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f\n import foo\n+bar\n*** End Patch",
  );
  assertEquals(hunks[0], {
    type: "update",
    path: "f",
    movePath: null,
    chunks: [{
      changeContext: null,
      oldLines: ["import foo"],
      newLines: ["import foo", "bar"],
      contextLineIndices: [[0, 0]],
      isEndOfFile: false,
    }],
  });
});

Deno.test("a heredoc-wrapped patch is unwrapped", () => {
  const { hunks } = parsePatch(
    "<<'EOF'\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\nEOF\n",
  );
  assertEquals(hunks, [{ type: "add", path: "a", contents: "x\n" }]);
  assertEquals(
    parseError("<<'EOF'\n*** Begin Patch\n*** End Patch\nEOF"),
    "parsed",
  );
});

Deno.test("an environment id is read and must be unique", () => {
  assertEquals(
    parsePatch(
      "*** Begin Patch\n*** Environment ID: box-1\n*** Add File: a\n+x\n*** End Patch",
    ).environmentId,
    "box-1",
  );
  assertEquals(
    parseError(
      "*** Begin Patch\n*** Environment ID: a\n*** Environment ID: b\n*** End Patch",
    ),
    "invalid patch: apply_patch environment_id cannot be specified more than once",
  );
});

Deno.test("CRLF patches parse like LF ones", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\r\n*** Add File: a\r\n+x\r\n*** End Patch\r\n",
  );
  assertEquals(hunks, [{ type: "add", path: "a", contents: "x\n" }]);
});

Deno.test("seekSequence falls back through whitespace and punctuation", () => {
  const lines = ["def f():", "    return “hi”  ", "x = 1 — 2"];
  assertEquals(seekSequence(lines, ["def f():"], 0, false), 0);
  assertEquals(seekSequence(lines, ["    return “hi”"], 0, false), 1);
  assertEquals(seekSequence(lines, ['return "hi"'], 0, false), 1);
  assertEquals(seekSequence(lines, ["x = 1 - 2"], 0, false), 2);
  assertEquals(seekSequence(lines, ["nope"], 0, false), null);
  assertEquals(seekSequence(lines, [], 2, false), 2);
  assertEquals(seekSequence(["a"], ["a", "b"], 0, false), null);
});

Deno.test("end-of-file chunks match at the end first", () => {
  assertEquals(seekSequence(["x", "y", "x"], ["x"], 0, true), 2);
  assertEquals(seekSequence(["x", "y", "x"], ["x"], 0, false), 0);
});

Deno.test("@@ context anchors the change after the named line", () => {
  const before = "def a():\n    return 1\ndef b():\n    return 1\n";
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: m.py\n@@ def b():\n-    return 1\n+    return 2\n*** End Patch",
  );
  const chunks = hunks[0].type === "update" ? hunks[0].chunks : [];
  assertEquals(
    applyChunks(before, "m.py", chunks),
    "def a():\n    return 1\ndef b():\n    return 2\n",
  );
});

Deno.test("missing context and missing lines fail with Codex's messages", async () => {
  const fs = new MemoryFileSystem({ "a.txt": "one\ntwo\n" });
  const context = await failure(
    applyPatch(
      fs,
      "*** Begin Patch\n*** Update File: a.txt\n@@ class Nope\n-one\n+1\n*** End Patch",
    ),
  );
  assertEquals([context.kind, context.message], [
    "apply",
    "Failed to find context 'class Nope' in a.txt",
  ]);
  const lines = await failure(
    applyPatch(
      fs,
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-three\n+3\n*** End Patch",
    ),
  );
  assertEquals(lines.message, "Failed to find expected lines in a.txt:\nthree");
  assertEquals(fs.snapshot(), { "a.txt": "one\ntwo\n" });
});

Deno.test("a trailing empty context line may be dropped to match", () => {
  const out = applyChunks("a\nb\n", "f", [{
    changeContext: null,
    oldLines: ["b", ""],
    newLines: ["B", ""],
    contextLineIndices: [],
    isEndOfFile: false,
  }]);
  assertEquals(out, "a\nB\n");
});

Deno.test("a successful patch reports Codex's summary", async () => {
  const fs = new MemoryFileSystem({ "old.txt": "x\n", "gone.txt": "bye\n" });
  const result = await applyPatch(
    fs,
    [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "*** Update File: old.txt",
      "*** Move to: moved.txt",
      "@@",
      "-x",
      "+y",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ].join("\n"),
  );
  assertEquals(
    result.summary,
    "Success. Updated the following files:\nA new.txt\nM moved.txt\nD gone.txt\n",
  );
  assertEquals(fs.snapshot(), { "moved.txt": "y\n", "new.txt": "hello\n" });
});

Deno.test("later hunks see earlier ones in the same patch", async () => {
  const fs = new MemoryFileSystem();
  await applyPatch(
    fs,
    "*** Begin Patch\n*** Add File: a\n+one\n*** Update File: a\n@@\n-one\n+two\n*** End Patch",
  );
  assertEquals(fs.snapshot(), { a: "two\n" });
});

Deno.test("paths may not leave the workspace", async () => {
  const fs = new MemoryFileSystem();
  const absolute = await failure(
    applyPatch(
      fs,
      "*** Begin Patch\n*** Add File: /etc/passwd\n+x\n*** End Patch",
    ),
  );
  assertEquals(absolute.message, "absolute paths are not allowed: /etc/passwd");
  const escape = await failure(
    applyPatch(
      fs,
      "*** Begin Patch\n*** Add File: a/../../x\n+x\n*** End Patch",
    ),
  );
  assertEquals(escape.message, "the path leaves the workspace: a/../../x");
  assertEquals(fs.snapshot(), {});
});

Deno.test("adding over a directory fails", async () => {
  const fs = new MemoryFileSystem({ "dir/f": "x" });
  const error = await failure(
    applyPatch(fs, "*** Begin Patch\n*** Add File: dir\n+x\n*** End Patch"),
  );
  assertEquals(error.message, "Failed to write file dir: it is a directory");
});
