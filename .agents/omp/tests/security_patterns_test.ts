// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Tests the modified Apache-2.0 Anthropic security-guidance catalog at ab024cdc.

import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { deepStrictEqual, ok } from "node:assert";
import toolFactory, {
  type SecurityPatternReport,
} from "../tools/security-patterns.ts";
import {
  MAX_CONTENT_BYTES,
  MAX_FILES,
  normalizeScanPath,
  scanSecurityPatterns,
} from "../skills/security-review/scripts/patterns.ts";
import type { SchemaBuilder, ToolAPI } from "../lib/tool.ts";

const types: SchemaBuilder = {
  Object: (properties, options) => ({ properties, ...options }),
  String: (options) => ({ type: "string", ...options }),
  Integer: (options) => ({ type: "integer", ...options }),
  Boolean: (options) => ({ type: "boolean", ...options }),
  Array: (items, options) => ({ type: "array", items, ...options }),
  Union: (anyOf) => ({ anyOf }),
  Literal: (value) => ({ const: value }),
  Optional: (schema) => schema,
};
function api(cwd: string): ToolAPI {
  return {
    cwd,
    typebox: { Type: types },
    exec: () => {
      throw new Error("Scanning must not execute a command");
    },
  };
}
async function mustReject(
  action: () => unknown | Promise<unknown>,
  message?: RegExp,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    ok(error instanceof Error);
    if (message) ok(message.test(error.message), error.message);
    return;
  }
  throw new Error("Expected rejection");
}
function ids(path: string, content: string): number[] {
  return scanSecurityPatterns(path, content).map((candidate) =>
    candidate.ruleId
  );
}

Deno.test("catalog recognizes all distinct dangerous sink families with frozen IDs", () => {
  const cases: [number, string, string][] = [
    [1, ".github/workflows/ci.yml", "name: ci"],
    [2, "run.ts", "exec(command)"],
    [3, "run.js", "new Function(input)"],
    [4, "run.py", "eval(input)"],
    [5, "view.tsx", "dangerouslySetInnerHTML={{__html: input}}"],
    [6, "view.js", "document.write(input)"],
    [7, "view.ts", "element.innerHTML = input"],
    [8, "load.py", "pickle.loads(data)"],
    [9, "run.py", "os.system (input)"],
    [10, "run.py", "subprocess.check_output(command, shell=True)"],
    [11, "run.go", 'exec.Command("/bin/bash", "-c", input)'],
    [12, "load.py", "yaml.load(data)"],
    [13, "crypto.ts", "crypto.createCipher('aes192', password)"],
    [14, "crypto.py", "AES.MODE_ECB"],
    [15, "client.ts", "rejectUnauthorized: false"],
    [16, "load.py", "marshal.loads(data)"],
    [17, "load.py", "shelve.open(path)"],
    [18, "load.py", "ET.fromstring(data)"],
    [19, "load.py", "dill.load(stream)"],
    [20, "view.js", "element.outerHTML=input"],
    [21, "view.js", "element.insertAdjacentHTML('beforeend', input)"],
    [22, "view.html", '<script src="https://cdn.example/script.js"></script>'],
    [23, "load.py", "torch.load(path, weights_only=False)"],
    [24, "load.py", "yaml.unsafe_load(data)"],
    [25, "load.py", "numpy.load(path, allow_pickle=True)"],
  ];
  for (const [id, path, content] of cases) {
    deepStrictEqual(ids(path, content), [id], `Sink family ${id}`);
  }
});

Deno.test("language gates and identifier guards suppress plausible non-sinks", () => {
  const cases: [string, string][] = [
    [
      "readme.md",
      "eval(input); exec(input); new Function(input); document.write(input); x.innerHTML=input; x.outerHTML=input; x.insertAdjacentHTML(input); dangerouslySetInnerHTML",
    ],
    [
      "code.py",
      "exec(input); new Function; document.write(input); x.innerHTML=input; dangerouslySetInnerHTML",
    ],
    ["code.ts", "pickle.load(data); os.system(command); from os import system"],
    [
      "code.py",
      "model.eval(); redis.eval(script); spec.eval(); my_eval(data); literal_eval(data)",
    ],
    [
      "code.ts",
      "obj.exec(input); regex.exec(input); execFile(command, args); spawn(command, args)",
    ],
    [
      "code.py",
      "pickle.dump(data); pickle.dumps(data); my_pkl_load(data); unpickle.load(data); marshal.dump(data)",
    ],
    [
      "view.ts",
      "element.textContent=input; element.insertAdjacentText('beforeend', input)",
    ],
  ];
  for (const [path, content] of cases) {
    deepStrictEqual(ids(path, content), [], path);
  }
});

Deno.test("explicit safe API forms and same-line loader guards are ignored", () => {
  const cases: [string, string][] = [
    [
      "load.py",
      "yaml.safe_load(data); yaml.load(data, Loader=yaml.SafeLoader)",
    ],
    [
      "load.py",
      "torch.load(path, weights_only=True); wrapper.torch_load(path, weights_only = True)",
    ],
    ["load.py", "np.load(path); numpy.load(path, allow_pickle=False)"],
    ["run.py", "subprocess.run(['ls', path], shell=False)"],
    ["run.go", 'exec.Command("ping", host)'],
    [
      "crypto.ts",
      "crypto.createCipheriv(algorithm, key, iv); crypto.createDecipheriv(algorithm, key, iv)",
    ],
    [
      "client.ts",
      "rejectUnauthorized: true; verify=True; InsecureSkipVerify: false",
    ],
    [
      "view.html",
      '<script integrity="sha384-example" src="https://cdn.example/script.js"></script><script src="//cdn.example/x.js" integrity="sha384-example"></script><script src="/local.js"></script>',
    ],
  ];
  for (const [path, content] of cases) {
    deepStrictEqual(ids(path, content), [], content);
  }
});

Deno.test("known multiline heuristics remain explicit rather than silently pretending to parse", () => {
  deepStrictEqual(ids("load.py", "yaml.load(data,\n Loader=yaml.SafeLoader)"), [
    12,
  ]);
  deepStrictEqual(ids("load.py", "torch.load(path,\n weights_only=True)"), [
    23,
  ]);
  deepStrictEqual(ids("load.py", "numpy.load(path,\n allow_pickle=True)"), []);
  deepStrictEqual(ids("run.py", "subprocess.run(command,\n shell=True)"), []);
  deepStrictEqual(
    ids("readme.md", "marshal.load(data)"),
    [16],
    "Ungated upstream rules remain ungated",
  );
});

Deno.test("subprocess matching preserves first same-line location without repeated-prefix backtracking", () => {
  const prefix = "subprocess.run(command); ".repeat(8000);
  deepStrictEqual(ids("run.py", prefix), []);
  const result = scanSecurityPatterns(
    "run.py",
    `shell=True\n${prefix}shell=True`,
  );
  deepStrictEqual(
    result.map(({ ruleId, line, column }) => ({ ruleId, line, column })),
    [
      { ruleId: 10, line: 2, column: 1 },
    ],
  );
  deepStrictEqual(ids("run.py", "subprocess.run(command, shell =\n True)"), [
    10,
  ], "Upstream whitespace after shell can span lines");
  deepStrictEqual(
    ids(
      "run.py",
      "subprocess.run(command)\nsubprocess.call(command, shell=True)",
    ),
    [10],
  );
});

Deno.test("reports first locations and independent overlapping rules without exposing source values", async () => {
  const content =
    "// private credential: SECRET_SENTINEL_123\nexec(input)\nexecSync(input)\neval(input)\n";
  const output = await toolFactory(api(Deno.cwd())).execute("content", {
    path: "src/run.ts",
    content,
  });
  const report = output.details as SecurityPatternReport;
  deepStrictEqual(
    report.candidates.map(({ ruleId, line, column }) => ({
      ruleId,
      line,
      column,
    })),
    [
      { ruleId: 2, line: 2, column: 1 },
      { ruleId: 4, line: 4, column: 1 },
    ],
  );
  deepStrictEqual(report.files, [{
    path: "src/run.ts",
    bytes: Buffer.byteLength(content),
  }]);
  ok(!JSON.stringify(output).includes("SECRET_SENTINEL_123"));
  const reminder =
    scanSecurityPatterns(".github/workflows/ci.yaml", "run: echo safe")[0];
  deepStrictEqual({
    kind: reminder.kind,
    line: reminder.line,
    column: reminder.column,
  }, { kind: "path-reminder", line: null, column: null });
  deepStrictEqual(ids("src/view.ts", "element.innerHTML=eval(input)"), [4, 7]);
});

Deno.test("explicit selections never recursively scan neighbors and reject unsafe file inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-security-"));
  const outside = await mkdtemp(join(tmpdir(), "omp-security-outside-"));
  try {
    await writeFile(join(root, "safe.ts"), "element.textContent=input");
    await writeFile(join(root, "unselected.ts"), "eval(input)");
    await writeFile(join(outside, "secret.ts"), "eval(secret)");
    await symlink(join(outside, "secret.ts"), join(root, "link.ts"));
    await symlink(outside, join(root, "linked-directory"));
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "binary.ts"), new Uint8Array([0xff, 0x00]));
    await writeFile(join(root, "nul.ts"), "eval(input)\0");
    const tool = toolFactory(api(root));
    const report = (await tool.execute("selected", { paths: ["safe.ts"] }))
      .details as SecurityPatternReport;
    deepStrictEqual(report.candidates, []);
    deepStrictEqual(report.files, [{ path: "safe.ts", bytes: 25 }]);
    await writeFile(join(root, "bom.ts"), "\uFEFFeval(input)");
    const bom = (await tool.execute("bom", { paths: ["bom.ts"] }))
      .details as SecurityPatternReport;
    deepStrictEqual(
      bom.candidates.map(({ ruleId, line, column }) => ({
        ruleId,
        line,
        column,
      })),
      [
        { ruleId: 4, line: 1, column: 2 },
      ],
    );
    for (
      const path of [
        "../secret.ts",
        "/etc/passwd",
        "link.ts",
        "linked-directory/secret.ts",
        "directory",
        "binary.ts",
        "nul.ts",
        "missing.ts",
      ]
    ) {
      await mustReject(() => tool.execute("unsafe", { paths: [path] }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

Deno.test("malformed modes, path labels, duplicates and byte limits fail closed", async () => {
  const tool = toolFactory(api(Deno.cwd()));
  for (
    const path of [
      "",
      ".",
      "..",
      "../x.ts",
      "a/../x.ts",
      "/x.ts",
      "C:\\x.ts",
      "a\0.ts",
      "a\nb.ts",
      "a//x.ts",
    ]
  ) {
    await mustReject(() => normalizeScanPath(path));
    await mustReject(() =>
      tool.execute("invalid-label", { path, content: "eval(input)" })
    );
  }
  deepStrictEqual(normalizeScanPath("./src\\view.ts"), "src/view.ts");
  await mustReject(() => tool.execute("none", {}));
  await mustReject(() => tool.execute("label", { path: "x.ts" }));
  await mustReject(() => tool.execute("no-label", { content: "" }));
  await mustReject(() =>
    tool.execute("both", { paths: ["x.ts"], path: "x.ts", content: "" })
  );
  await mustReject(() => tool.execute("empty", { paths: [] }));
  await mustReject(
    () => tool.execute("duplicates", { paths: ["src/x.ts", "./src/x.ts"] }),
    /Duplicate/,
  );
  await mustReject(() =>
    tool.execute("many", {
      paths: Array.from({ length: MAX_FILES + 1 }, (_, i) => `${i}.ts`),
    })
  );
  await mustReject(
    () =>
      tool.execute("large", {
        path: "x.ts",
        content: "é".repeat(MAX_CONTENT_BYTES / 2 + 1),
      }),
    /UTF-8 bytes/,
  );
  deepStrictEqual(ids("x.ts", " ".repeat(MAX_CONTENT_BYTES)), []);
  const controller = new AbortController();
  controller.abort();
  await mustReject(() =>
    tool.execute(
      "cancelled",
      { path: "x.ts", content: "eval(input)" },
      undefined,
      undefined,
      controller.signal,
    )
  );
});

Deno.test("file and aggregate byte limits reject before returning a partial report", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-security-limits-"));
  try {
    const tool = toolFactory(api(root));
    await writeFile(
      join(root, "oversized.ts"),
      " ".repeat(MAX_CONTENT_BYTES + 1),
    );
    await mustReject(
      () => tool.execute("oversized", { paths: ["oversized.ts"] }),
      /exceeds/,
    );
    const paths = Array.from({ length: 9 }, (_, i) => `${i}.ts`);
    for (const path of paths) {
      await writeFile(join(root, path), " ".repeat(MAX_CONTENT_BYTES));
    }
    await mustReject(() => tool.execute("aggregate", { paths }), /in total/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test({
  name: "selected FIFO inputs reject promptly without waiting for a writer",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await mkdtemp(join(tmpdir(), "omp-security-fifo-"));
    const fifo = join(root, "input.ts");
    let timer: NodeJS.Timeout | undefined;
    try {
      const created = await new Deno.Command("mkfifo", {
        args: [fifo],
        stdout: "null",
        stderr: "piped",
      }).output();
      ok(
        created.success,
        `mkfifo failed: ${new TextDecoder().decode(created.stderr)}`,
      );
      const pending = toolFactory(api(root)).execute("fifo", {
        paths: ["input.ts"],
      }).then(
        () => ({ rejected: false, error: undefined }),
        (error: unknown) => ({ rejected: true, error }),
      );
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      });
      const outcome = await Promise.race([pending, deadline]);
      if (outcome === null) {
        // A failing-before blocking reader must be released before fixture cleanup.
        // RDWR/nonblocking opens a FIFO without waiting for another endpoint.
        const writer = await open(
          fifo,
          constants.O_RDWR | constants.O_NONBLOCK,
        );
        try {
          clearTimeout(timer);
          const cleanupDeadline = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 2000);
          });
          ok(
            await Promise.race([pending, cleanupDeadline]) !== null,
            "FIFO reader did not settle after writer unblock",
          );
        } finally {
          await writer.close();
        }
        throw new Error(
          "FIFO input waited for a writer instead of rejecting promptly",
        );
      }
      ok(outcome.rejected, "FIFO input must not be accepted as a source file");
      ok(
        outcome.error instanceof Error &&
          /regular file/.test(outcome.error.message),
        "FIFO must reject as non-regular input",
      );
    } finally {
      clearTimeout(timer);
      await rm(root, { recursive: true, force: true });
    }
  },
});
