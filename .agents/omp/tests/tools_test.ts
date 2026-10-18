// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import targets, { createTargetsFile } from "../tools/buck2-targets.ts";
import project from "../tools/buck2-new-project.ts";
import query from "../tools/buck2-query.ts";
import doctor from "../tools/buck2-build-doctor.ts";
import type { ExecResult, SchemaBuilder, ToolAPI } from "../lib/tool.ts";

// Factories use the host's schema builder; these tests exercise execute behavior.
const typebox: SchemaBuilder = {
  Object: (properties, options) => ({ type: "object", properties, ...options }),
  String: (options) => ({ type: "string", ...options }),
  Integer: (options) => ({ type: "integer", ...options }),
  Boolean: (options) => ({ type: "boolean", ...options }),
  Array: (items, options) => ({ type: "array", items, ...options }),
  Union: (anyOf) => ({ anyOf }),
  Literal: (value) => ({ const: value }),
  Optional: (schema) => schema,
};
const hostSchema = { Type: typebox };
const success: ExecResult = { code: 0, stdout: "", stderr: "", killed: false };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error, "Expected Error result");
    return error;
  }
  throw new Error("Expected operation to fail");
}

Deno.test("target files are unique private regular files", async () => {
  const first = await createTargetsFile();
  const second = await createTargetsFile();
  try {
    assert(
      first.path !== second.path,
      "Concurrent target selections must not share a path",
    );
    for (const temporary of [first, second]) {
      const file = await lstat(temporary.path);
      assert(
        file.isFile() && !file.isSymbolicLink(),
        "Target at-file must be a regular file",
      );
      if (Deno.build.os !== "windows") {
        assert((file.mode & 0o777) === 0o600, "Target file must be owner-only");
        assert(
          ((await stat(temporary.directory)).mode & 0o777) === 0o700,
          "Target directory must be owner-only",
        );
      }
    }
  } finally {
    await rm(first.directory, { recursive: true, force: true });
    await rm(second.directory, { recursive: true, force: true });
  }
});

Deno.test("empty target selection removes its file even when actions were requested", async () => {
  let path = "";
  const api: ToolAPI = {
    cwd: Deno.cwd(),
    typebox: hostSchema,
    exec: (_command, args) => {
      const index = args.indexOf("--output");
      if (index < 0) throw new Error("Empty selection must not build or test");
      path = args[index + 1];
      return Promise.resolve(success);
    },
  };
  const output = await targets(api).execute("empty", {
    build: true,
    test: true,
  });
  const details = output.details as {
    count: number;
    retained: boolean;
    targetsFile: string | null;
  };
  assert(
    details.count === 0 && !details.retained && details.targetsFile === null,
    "Empty selection is not reusable",
  );
  await rejects(() => stat(path));
  await rejects(() => stat(dirname(path)));
});

Deno.test("failed determination removes partial target output", async () => {
  let path = "";
  const api: ToolAPI = {
    cwd: Deno.cwd(),
    typebox: hostSchema,
    exec: async (_command, args) => {
      path = args[args.indexOf("--output") + 1];
      await writeFile(path, "depot//partial:target\n");
      return { ...success, code: 13, stderr: "graph collection failed" };
    },
  };
  await rejects(() => targets(api).execute("partial", {}));
  await rejects(() => stat(path));
  await rejects(() => stat(dirname(path)));
});

Deno.test("completed selection survives build failure with exact target contents", async () => {
  let path = "";
  const selected = "depot//one:test\ndepot//two:test\n";
  const api: ToolAPI = {
    cwd: Deno.cwd(),
    typebox: hostSchema,
    exec: async (_command, args) => {
      if (args[0] === "run") {
        path = args[args.indexOf("--output") + 1];
        await writeFile(path, selected);
        return success;
      }
      return { ...success, code: 7, stderr: "consumer compilation failed" };
    },
  };
  try {
    await rejects(() => targets(api).execute("build", { build: true }));
    assert(
      await readFile(path, "utf8") === selected,
      "Recovery must retain the complete selection",
    );
  } finally {
    if (path) await rm(dirname(path), { recursive: true, force: true });
  }
});

Deno.test("successful actions retain nonempty selection for reuse", async () => {
  let path = "";
  const selected = "depot//one:test\n";
  const api: ToolAPI = {
    cwd: Deno.cwd(),
    typebox: hostSchema,
    exec: async (_command, args) => {
      if (args[0] === "run") {
        path = args[args.indexOf("--output") + 1];
        await writeFile(path, selected);
      }
      return success;
    },
  };
  try {
    const output = await targets(api).execute("test", { test: true });
    const details = output.details as {
      targetsFile: string;
      retained: boolean;
      count: number;
    };
    assert(
      details.retained && details.count === 1,
      "Completed target selection must remain reusable",
    );
    assert(
      await readFile(details.targetsFile, "utf8") === selected,
      "Retained selection changed",
    );
  } finally {
    if (path) await rm(dirname(path), { recursive: true, force: true });
  }
});

Deno.test("project creation refuses existing files and symlink ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-project-test-"));
  const outside = await mkdtemp(join(tmpdir(), "omp-project-outside-"));
  const api: ToolAPI = {
    cwd: root,
    typebox: hostSchema,
    exec: () => Promise.reject(new Error("Generator must not launch commands")),
  };
  try {
    await writeFile(join(root, "occupied"), "existing user data");
    await rejects(() =>
      project(api).execute("exists", {
        type: "rust_binary",
        name: "app",
        path: "occupied",
      })
    );
    assert(
      await readFile(join(root, "occupied"), "utf8") === "existing user data",
      "Existing input overwritten",
    );
    await writeFile(join(outside, "sentinel"), "outside user data");
    await symlink(outside, join(root, "linked"), "dir");
    await rejects(() =>
      project(api).execute("escape", {
        type: "deno_binary",
        name: "app",
        path: "linked/generated",
      })
    );
    await rejects(() => stat(join(outside, "generated")));
    assert(
      await readFile(join(outside, "sentinel"), "utf8") === "outside user data",
      "Outside file modified",
    );
    await rejects(() =>
      project(api).execute("absolute", {
        type: "rust_library",
        name: "app",
        path: join(outside, "generated"),
      })
    );
    await rejects(() => stat(join(outside, "generated")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

Deno.test("cycle query never reports success when graph loading fails", async () => {
  const api: ToolAPI = {
    cwd: Deno.cwd(),
    typebox: hostSchema,
    exec: () =>
      Promise.resolve({
        ...success,
        code: 9,
        stderr: "dependency cycle in graph",
      }),
  };
  await rejects(() =>
    query(api).execute("cycle", {
      operation: "cycles",
      scope: "depot//cycle:node",
    })
  );
});

Deno.test("diagnostics distinguish private metadata from visibility failures and inconclusive graphs", async () => {
  const api: ToolAPI = {
    cwd: Deno.cwd(),
    typebox: hostSchema,
    exec: (_command, args) => {
      if (args[0] === "targets") {
        return Promise.resolve({ ...success, stdout: "depot//private:node\n" });
      }
      if (args.includes("--output-attribute")) {
        return Promise.resolve({
          ...success,
          stdout: '{"depot//private:node":{"visibility":[]}}',
        });
      }
      if (args[0] === "uquery") {
        return Promise.resolve({
          ...success,
          code: 8,
          stderr: "unknown cell alias",
        });
      }
      return Promise.resolve(success);
    },
  };
  const output = await doctor(api).execute("diagnose", {
    targets: ["depot//private:node"],
    checkVisibility: true,
    checkCycles: true,
  });
  const details = output.details as {
    issues: { kind: string }[];
    evidence: { check: string; status: string }[];
  };
  assert(
    !details.issues.some((issue) => issue.kind === "visibility"),
    "Intentional private visibility is not a consumer error",
  );
  assert(
    details.issues.some((issue) => issue.kind === "diagnostic_command_failed"),
    "Failed graph loading must be recorded",
  );
  assert(
    details.evidence.some((item) =>
      item.check === "cycles" && item.status === "inconclusive"
    ),
    "Unknown cells do not prove a cycle",
  );
});
