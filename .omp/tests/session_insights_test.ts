// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import insights, {
  analyzeJournals,
  completedFileActivity,
  csvCell,
  type Journal,
  mineReceipts,
  parseHistory,
  parseJournal,
  type Receipt,
  renderReport,
  reportCsv,
  scriptJson,
  type Selection,
} from "../tools/session-insights.ts";
import type { ExecResult, SchemaBuilder, ToolAPI } from "../lib/tool.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
async function rejects(action: () => unknown): Promise<void> {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  assert(failed, "Expected failure");
}
const selection: Selection = {
  inputRoot: "/selected",
  files: ["a.jsonl"],
  since: "2026-09-01T00:00:00Z",
  until: "2026-09-03T00:00:00Z",
};
const usage = {
  input: 10,
  output: 5,
  cacheRead: 20,
  cacheWrite: 2,
  totalTokens: 37,
  cost: { total: 0.01 },
};
function journal(
  id: string,
  entries: Record<string, unknown>[],
  header: Record<string, unknown> = {},
): Journal {
  return {
    source: `/selected/${id}.jsonl`,
    header: { type: "session", id, cwd: "/project", ...header },
    entries,
  };
}
function message(
  id: string,
  role: string,
  data: Record<string, unknown> = {},
  timestamp = "2026-09-01T12:00:00Z",
  parentId: string | null = null,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, ...data },
  };
}
const schemas: SchemaBuilder = {
  Object: (fields, opts) => ({ type: "object", fields, ...opts }),
  String: (opts) => ({ type: "string", ...opts }),
  Integer: (opts) => ({ type: "integer", ...opts }),
  Boolean: (opts) => ({ type: "boolean", ...opts }),
  Array: (items, opts) => ({ type: "array", items, ...opts }),
  Union: (items) => ({ anyOf: items }),
  Literal: (value) => ({ const: value }),
  Optional: (schema) => schema,
};
const ok: ExecResult = { code: 0, stdout: "", stderr: "", killed: false };

Deno.test("linked forks and resumed files deduplicate without collapsing unrelated local entry IDs", () => {
  const prompt = message("same", "user", { content: "secret" });
  const assistant = message(
    "answer",
    "assistant",
    { usage },
    "2026-09-01T12:00:01Z",
    "same",
  );
  const parent = journal("parent", [prompt, assistant]);
  const resumed = { ...parent, source: "/selected/resumed.jsonl" };
  const fork = journal(
    "fork",
    [
      prompt,
      {
        ...assistant,
        message: { role: "assistant", usage: { ...usage, cost: { total: 0 } } },
      },
      message("new", "assistant", { usage }, "2026-09-01T12:00:02Z", "answer"),
    ],
    { parentSession: "parent" },
  );
  const unrelated = journal("unrelated", [prompt, assistant]);
  const report = analyzeJournals([fork, unrelated, resumed, parent], selection);
  equal(report.totals.assistantMessages, 3);
  equal(report.totals.prompts, 2);
  equal(report.totals.usage.totalTokens.value, 111);
  equal(report.totals.usage.recordedCost.value, 0.03);
  equal(report.provenance.deduplicatedEntries, 4);
  equal(report.totals.sessions, 3);
});

Deno.test("all real branches count but request context follows ancestry, not the latest prompt", () => {
  const j = journal("branches", [
    message("first", "user", { content: "first task" }),
    message(
      "second",
      "user",
      { content: "second task" },
      "2026-09-01T12:00:01Z",
      "first",
    ),
    message("branch", "assistant", { usage }, "2026-09-01T12:00:02Z", "first"),
  ]);
  const report = analyzeJournals([j], { ...selection, includePrompts: true });
  equal(report.totals.prompts, 2);
  equal(report.topPrompts?.map((p) => p.text), ["first task"]);
  equal(report.requests[0].prompt, report.topPrompts?.[0].id);
  const hidden = JSON.stringify(analyzeJournals([j], selection));
  assert(
    !hidden.includes("first task") && !hidden.includes("second task") &&
      !hidden.includes("/project"),
    "Default output leaked prompts or cwd",
  );
});

Deno.test("missing usage and token buckets stay unknown while supplemental usage is counted once", () => {
  const j = journal("gaps", [
    message("known", "assistant", {
      usage: {
        ...usage,
        totalTokens: undefined,
        orchestration: { input: 3, output: 4, cacheRead: 5 },
      },
    }),
    message("missing", "assistant"),
    {
      type: "model_usage",
      id: "extra",
      timestamp: "2026-09-01T13:00:00Z",
      purpose: "compaction",
      usage: { ...usage, input: "10", totalTokens: undefined },
    },
    message("task", "toolResult", {
      toolName: "task",
      isError: false,
      details: {
        usage,
        results: [{
          id: "child",
          durationMs: 100,
          agent: "scout",
          task: "private task",
        }],
      },
    }),
  ]);
  const report = analyzeJournals([j], selection);
  equal(report.totals.usage.records, 3);
  equal(report.totals.supplementalUsageRecords, 1);
  equal(report.totals.usage.totalTokens.value, null);
  equal(report.totals.usage.totalTokens.observedSum, 49);
  equal(report.totals.usage.totalTokens.missingRecords, 2);
  equal(report.totals.usage.input.observedSum, 10);
  equal(report.tasks[0].durationMs, 100);
  assert(!("task" in report.tasks[0]), "Task text leaked by default");
});

Deno.test("time windows are half-open, UTC days split measured runtime and overlapping intervals do not sum", () => {
  const start = Date.parse("2026-09-01T23:59:50Z"),
    end = Date.parse("2026-09-02T00:00:10Z");
  const j = journal("days", [
    message("before", "user", {}, "2026-08-31T23:59:59Z"),
    message("p", "user", {}, selection.since),
    message(
      "a",
      "assistant",
      { usage, timestamp: start, completedAt: end },
      "2026-09-02T00:00:10Z",
    ),
    message("b", "assistant", {
      usage,
      timestamp: start + 5000,
      duration: 10000,
    }, "2026-09-02T00:00:11Z"),
    message("after", "user", {}, selection.until),
  ]);
  const report = analyzeJournals([j], selection);
  equal(report.totals.prompts, 1);
  equal(report.totals.activeDays, 2);
  equal(report.totals.activeMs, 20000);
  equal(report.totals.timedIntervals, 2);
  equal(report.days.map((d) => d.activeMs), [10000, 10000]);
  equal(report.days.map((d) => d.usage.records), [0, 2]);
  equal(report.window.calendarDays, 2);
});

Deno.test("runtime overlaps select runtime-only sessions without importing outside event facts", () => {
  const window = { ...selection, until: "2026-09-02T00:00:00Z" };
  const entries = [
    {
      type: "session_init",
      id: "init",
      timestamp: "2026-08-31T23:00:00Z",
      agent: "private-agent",
    },
    message(
      "prompt",
      "user",
      { content: "outside prompt" },
      "2026-08-31T23:59:40Z",
    ),
    message("end", "assistant", {
      usage,
      timestamp: "2026-09-01T23:59:50Z",
      completedAt: "2026-09-02T00:00:10Z",
    }, "2026-09-02T00:00:10Z"),
    {
      type: "model_usage",
      id: "start",
      timestamp: "2026-08-31T23:59:50Z",
      completedAt: "2026-09-01T00:00:10Z",
      usage,
      model: "outside-model",
    },
    {
      type: "custom",
      id: "metadata",
      timestamp: selection.since,
      customType: "other",
    },
  ];
  const j = journal("runtime-only", entries);
  equal(
    analyzeJournals([journal("end-only", [entries[2]])], window).totals
      .activeMs,
    10000,
  );
  const report = analyzeJournals([j, {
    ...j,
    source: "/selected/resumed.jsonl",
  }], window);
  equal(report.totals.activeMs, 20000);
  equal(report.totals.timedIntervals, 2);
  equal(report.totals.sessions, 1);
  equal(report.totals.activeDays, 1);
  equal(report.totals.prompts, 0);
  equal(report.totals.assistantMessages, 0);
  equal(report.totals.supplementalUsageRecords, 0);
  equal(report.totals.usage.records, 0);
  equal(report.totals.timingGaps, 0);
  equal(report.models, []);
  equal(report.requests, []);
  equal(
    report.sessions.map(
      (s) => [
        Date.parse(s.first),
        Date.parse(s.last),
        s.wallMs,
        s.activeMs,
        s.agent,
      ],
    ),
    [[
      Date.parse(selection.since),
      Date.parse(window.until),
      86400000,
      20000,
      null,
    ]],
  );
  equal(
    report.days.map(
      (d) => [d.date, d.sessions, d.prompts, d.usage.records, d.activeMs],
    ),
    [["2026-09-01", 1, 0, 0, 20000]],
  );
});

Deno.test("tool completion outside the window contributes clipped runtime but no result outcomes", () => {
  const j = journal("tool-runtime", [
    {
      type: "custom",
      id: "start",
      customType: "tool_execution_start",
      timestamp: "2026-08-31T23:59:50Z",
      data: { toolCallId: "call", startedAt: "2026-08-31T23:59:50Z" },
    },
    message("result", "toolResult", {
      toolCallId: "call",
      toolName: "task",
      isError: false,
      timestamp: "2026-09-02T00:00:10Z",
      details: { results: [{ id: "child", agent: "scout" }] },
    }, "2026-09-02T00:00:10Z"),
  ]);
  const report = analyzeJournals([j], {
    ...selection,
    until: "2026-09-02T00:00:00Z",
  });
  equal(report.totals.activeMs, 86400000);
  equal(report.totals.timedIntervals, 1);
  equal(report.sessions[0].wallMs, 86400000);
  equal(report.days[0].sessions, 1);
  equal(report.tools, []);
  equal(report.tasks, []);
  equal(report.totals.timingGaps, 0);
});

Deno.test("nonoverlapping runtime and touching boundaries do not create phantom zero activity", () => {
  const window = { ...selection, until: "2026-09-02T00:00:00Z" };
  const outside = journal("outside", [
    message("before", "assistant", {
      timestamp: "2026-08-31T23:59:50Z",
      completedAt: selection.since,
    }, "2026-08-31T23:59:59Z"),
    message("after", "assistant", {
      timestamp: window.until,
      completedAt: "2026-09-02T00:00:10Z",
    }, window.until),
    { type: "custom", id: "metadata", timestamp: selection.since },
  ]);
  const empty = analyzeJournals([outside], window);
  equal([
    empty.totals.activeMs,
    empty.totals.wallMs,
    empty.totals.sessions,
    empty.totals.activeDays,
    empty.totals.timedIntervals,
  ], [null, null, 0, 0, 0]);
  const selected = journal("selected", [
    message("event", "assistant", {
      timestamp: "2026-08-31T23:59:50Z",
      completedAt: selection.since,
    }),
  ]);
  const report = analyzeJournals([outside, selected], window);
  equal(report.totals.activeMs, null);
  equal(report.sessions[0].activeMs, null);
  equal(report.days[0].activeMs, null);
  equal(report.totals.timingGaps, 0);
});

Deno.test("window validation rejects invalid dates, missing zones and reversed ranges", async () => {
  for (
    const since of [
      "nope",
      "2026-09-01",
      "2026-02-30T00:00:00Z",
      "2026-09-03T00:00:00Z",
    ]
  ) await rejects(() => analyzeJournals([], { ...selection, since }));
});

Deno.test("file receipts require successful native results and resolved paths, not attempts or previews", () => {
  const j = journal("activity", [
    message("calls", "assistant", {
      content: [{
        type: "toolCall",
        id: "failed",
        name: "write",
        arguments: { path: "failed", content: "no" },
      }, {
        type: "toolCall",
        id: "pending",
        name: "write",
        arguments: { path: "pending", content: "no" },
      }, {
        type: "toolCall",
        id: "written",
        name: "write",
        arguments: { path: "wrong", content: "a\nb" },
      }],
    }),
    message("failure", "toolResult", {
      toolCallId: "failed",
      toolName: "write",
      isError: true,
      details: { resolvedPath: "/project/failed" },
    }),
    message("unknown", "toolResult", {
      toolName: "write",
      details: { resolvedPath: "/project/unknown" },
    }),
    message("written", "toolResult", {
      toolCallId: "written",
      toolName: "write",
      isError: false,
      details: { resolvedPath: "/other/actual" },
    }),
    message("read", "toolResult", {
      toolName: "read",
      isError: false,
      details: {
        meta: { source: { type: "path", value: "/project/source.ts" } },
      },
    }),
    message("directory", "toolResult", {
      toolName: "read",
      isError: false,
      details: { isDirectory: true, resolvedPath: "/project" },
    }),
    message("edit", "toolResult", {
      toolName: "edit",
      isError: false,
      details: {
        perFileResults: [{ path: "a.ts", diff: "--- a\n+++ b\n-old\n+new" }, {
          path: "new.ts",
          sourcePath: "old.ts",
        }],
      },
    }),
    message("preview", "toolResult", {
      toolName: "ast_edit",
      isError: false,
      details: {
        applied: false,
        fileReplacements: [{ path: "preview.ts", count: 3 }],
      },
    }),
    message("applied", "toolResult", {
      toolName: "ast_edit",
      isError: false,
      details: {
        applied: true,
        fileReplacements: [{ path: "applied.ts", count: 3 }],
      },
    }),
    message("shell", "toolResult", {
      toolName: "bash",
      isError: false,
      content: "wrote file; gh pr create",
    }),
  ]);
  const mined = completedFileActivity([j], selection);
  equal(mined.activity.map((a) => a.path), [
    "/other/actual",
    "/project/source.ts",
    "/project/a.ts",
    "/project/new.ts",
    "/project/old.ts",
    "/project/applied.ts",
  ]);
  equal(mined.activity.map((a) => a.linesChanged), [
    2,
    null,
    2,
    null,
    null,
    null,
  ]);
  equal(mined.unknownResults, 1);
  equal(mined.unattributedResults, 2);
  const report = analyzeJournals([j], selection),
    writes = report.tools.find((t) => t.name === "write")!;
  equal([writes.attempted, writes.succeeded, writes.failed, writes.unknown], [
    3,
    1,
    1,
    1,
  ]);
});

Deno.test("successful skill reads and requested cache evidence are observable without Claude ratios", () => {
  const j = journal("skills", [
    message("call", "assistant", {
      usage: { ...usage, input: 120000 },
      content: [{
        type: "toolCall",
        id: "s",
        name: "read",
        arguments: { path: "skill://session-insights/SKILL.md" },
      }],
    }),
    message("result", "toolResult", {
      toolCallId: "s",
      toolName: "read",
      isError: false,
    }),
  ]);
  equal(analyzeJournals([j], selection).skills, [{
    name: "session-insights",
    successfulReads: 1,
  }]);
  assert(
    !("cacheBreakEvidence" in analyzeJournals([j], selection)),
    "Cache evidence was not requested",
  );
  const evidence =
    analyzeJournals([j], { ...selection, includeCacheBreaks: true })
      .cacheBreakEvidence![0];
  equal(evidence.uncachedInput, 120002);
  equal(evidence.precedingUncachedInput, null);
  equal(evidence.modelChanged, null);
});

Deno.test("journal parser discloses crash tails but fails on interior corruption and missing identities", async () => {
  const input = JSON.stringify({ type: "session", id: "real" }) + "\n" +
    JSON.stringify(message("p", "user"));
  equal(parseJournal("input.jsonl", input + '\n{"type":').malformedLines, 1);
  await rejects(() =>
    parseJournal(
      "input.jsonl",
      input + '\n{"type":\n' + JSON.stringify(message("later", "assistant")),
    )
  );
  await rejects(() =>
    parseJournal("input.jsonl", JSON.stringify(message("p", "user")))
  );
  const report = analyzeJournals([
    journal("identity", [{
      type: "message",
      message: { role: "assistant", usage },
    }]),
  ], selection);
  equal(report.provenance.undatedEntries, 1);
  equal(report.provenance.identityGaps, 1);
  equal(report.totals.usage.records, 0);
});

Deno.test("inherited relative results are never rebased onto a fork's different workspace", () => {
  const j = journal("moved-fork", [
    message("relative", "toolResult", {
      toolName: "edit",
      isError: false,
      details: { path: "src/original.ts", diff: "-old\n+new" },
    }),
    message("absolute", "toolResult", {
      toolName: "write",
      isError: false,
      details: { resolvedPath: "/original/src/actual.ts" },
    }),
    message("new", "toolResult", {
      toolName: "edit",
      isError: false,
      details: { path: "src/new.ts", diff: "-old\n+new" },
    }, "2026-09-02T12:00:00Z"),
  ], {
    cwd: "/different",
    parentSession: "unselected-parent",
    timestamp: "2026-09-02T00:00:00Z",
  });
  const mined = completedFileActivity([j], selection);
  equal(mined.activity.map((a) => a.path), [
    "/original/src/actual.ts",
    "/different/src/new.ts",
  ]);
  equal(mined.unattributedResults, 1);
});

Deno.test("history intersections respect paths, authors, ordering and unavailable versus zero", async () => {
  // Resolve macOS's /var -> /private/var symlink so journal paths match.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omp-receipt-history-")),
  );
  try {
    const editTime = "2026-09-01T12:00:00Z";
    const j = journal("receipt", [
      message("edit", "toolResult", {
        toolName: "edit",
        isError: false,
        details: { path: "work.ts", diff: "-old\n+new" },
      }, editTime),
    ], { cwd: root });
    const records = [
      {
        commit: "a".repeat(40),
        author: "dev@example.test",
        time: "2026-09-01T13:00:00Z",
        paths: ["work.ts"],
      },
      {
        commit: "b".repeat(40),
        author: "other@example.test",
        time: "2026-09-01T14:00:00Z",
        paths: ["work.ts"],
      },
      {
        commit: "c".repeat(40),
        author: "dev@example.test",
        time: "2026-09-01T11:00:00Z",
        paths: ["work.ts"],
      },
      {
        commit: "d".repeat(40),
        author: "dev@example.test",
        time: "2026-09-01T15:00:00Z",
        paths: ["not-work.ts"],
      },
      {
        commit: "e".repeat(40),
        author: "dev@example.test",
        time: selection.until,
        paths: ["work.ts"],
      },
    ];
    let unavailable = false;
    const api: ToolAPI = {
      cwd: root,
      typebox: { Type: schemas },
      exec: (_command, args) =>
        Promise.resolve(
          unavailable ? { ...ok, code: 1 } : {
            ...ok,
            stdout: args.includes("root")
              ? root + "\n"
              : records.map((r) => JSON.stringify(r)).join("\n"),
          },
        ),
    };
    const params = {
      ...selection,
      history: [{ root, revisions: "all()", authorEmail: "dev@example.test" }],
    };
    const report = await mineReceipts(api, [j], params);
    equal(report.totals.commitsIntersectingChangedFiles, 1);
    equal(report.projects[0].commitActiveDayOverlap, 1);
    equal(report.projects[0].filesChanged, 1);
    assert(
      !JSON.stringify(report).includes(root),
      "Default receipt leaked root",
    );
    equal(
      (await mineReceipts(api, [j], {
        ...params,
        history: [{ ...params.history[0], authorEmail: "absent@example.test" }],
      })).totals.commitsIntersectingChangedFiles,
      0,
    );
    equal(
      (await mineReceipts(api, [j], { ...params, maxCommits: 1 })).totals
        .commitsIntersectingChangedFiles,
      null,
    );
    unavailable = true;
    const failed = await mineReceipts(api, [j], params);
    equal(failed.totals.commitsIntersectingChangedFiles, null);
    equal(failed.projects[0].historyStatus, "unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("hostile export labels cannot escape HTML scripts or trigger CSV formulas", () => {
  const report: Receipt = {
    kind: "work-receipts",
    window: analyzeJournals([], selection).window,
    provenance: {
      files: 0,
      entries: 0,
      deduplicatedEntries: 0,
      undatedEntries: 0,
      identityGaps: 0,
      malformedLines: 0,
    },
    totals: {
      sessions: 1,
      activeDays: 1,
      filesRead: 1,
      filesChanged: 1,
      completedOperations: 1,
      unknownResults: 0,
      unattributedResults: 0,
      outsideHistoryScope: 0,
      commitsIntersectingChangedFiles: null,
      observedMatchingCommits: 0,
    },
    projects: [{
      label: '=HYPERLINK("</script><img src=x onerror=alert(1)>")',
      sessions: 1,
      activeDays: 1,
      filesRead: 1,
      filesChanged: 1,
      completedOperations: 1,
      knownLinesTouched: 0,
      operationsWithUnknownLines: 1,
      historyStatus: "unavailable",
      commitsIntersectingChangedFiles: null,
      observedMatchingCommits: 0,
      commitActiveDayOverlap: null,
    }],
    usage: analyzeJournals([], selection).totals.usage,
    caveats: ["<img src=x onerror=alert(2)>"],
  };
  const html = renderReport(report);
  assert(
    !html.includes("<img src=x"),
    "Export emitted executable hostile HTML",
  );
  assert(
    html.includes("&lt;img") && html.includes("\\u003c/script"),
    "HTML and script contexts require distinct escaping",
  );
  const embedded = html.match(
    /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/,
  )!;
  equal(JSON.parse(embedded[1]).projects[0].label, report.projects[0].label);
  assert(
    reportCsv(report).includes("\"'=HYPERLINK("),
    "Formula was not neutralized",
  );
  for (
    const input of [
      "=1+1",
      "  @SUM(1)",
      "\t+1",
      "-1",
      "\r=1",
      "\u0085=1",
      "\u009f @SUM(1)",
    ]
  ) {
    assert(
      csvCell(input).startsWith("\"'"),
      "Dangerous spreadsheet prefix remained active",
    );
  }
  equal(JSON.parse(scriptJson("\u2028</script>&")), "\u2028</script>&");
});

Deno.test("history parser rejects unsafe path attribution instead of inventing repository membership", async () => {
  const row = {
    commit: "a".repeat(40),
    author: "dev",
    time: selection.since,
    paths: ["src/real.ts"],
  };
  equal(parseHistory(JSON.stringify(row))[0].paths, ["src/real.ts"]);
  for (const paths of [["../escape"], ["/absolute"], ["a\0b"], [12]]) {
    await rejects(() => parseHistory(JSON.stringify({ ...row, paths })));
  }
});

Deno.test("native tools read compressed explicit inputs, refuse escapes and publish private non-overwriting exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-insights-")),
    outside = await mkdtemp(join(tmpdir(), "omp-insights-outside-"));
  try {
    const input = [
      JSON.stringify({ type: "session", id: "real", cwd: root }),
      JSON.stringify(message("assistant", "assistant", { usage })),
    ].join("\n");
    await writeFile(join(root, "input.jsonl.gz"), gzipSync(input));
    await writeFile(join(outside, "secret.jsonl"), input);
    await symlink(outside, join(root, "linked"), "dir");
    const api: ToolAPI = {
      cwd: root,
      typebox: { Type: schemas },
      exec: () =>
        Promise.reject(new Error("Session analytics must not launch commands")),
    };
    const tool = insights(api)[0],
      params = {
        ...selection,
        inputRoot: root,
        files: ["input.jsonl.gz"],
        html: "report.html",
        csv: "report.csv",
      };
    const output = await tool.execute("real", params);
    const details = output.details as {
      report: { totals: { assistantMessages: number } };
    };
    equal(details.report.totals.assistantMessages, 1);
    assert(
      (await readFile(join(root, "report.html"), "utf8")).includes(
        "OMP session insights",
      ),
      "HTML artifact missing",
    );
    const original = await readFile(join(root, "report.html"), "utf8");
    await rejects(() => tool.execute("occupied", params));
    equal(await readFile(join(root, "report.html"), "utf8"), original);
    await rejects(() =>
      tool.execute("input escape", {
        ...params,
        files: [join(outside, "secret.jsonl")],
        html: undefined,
        csv: undefined,
      })
    );
    await rejects(() =>
      tool.execute("input symlink", {
        ...params,
        files: ["linked/secret.jsonl"],
        html: undefined,
        csv: undefined,
      })
    );
    await rejects(() =>
      tool.execute("output escape", {
        ...params,
        html: join(outside, "export.html"),
        csv: undefined,
      })
    );
    await rejects(() =>
      tool.execute("same output", { ...params, html: "same", csv: "same" })
    );
    await tool.execute("explicit overwrite", { ...params, overwrite: true });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
