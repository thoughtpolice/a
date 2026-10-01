// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified OMP adaptation of Anthropic session-report / receipts workflows,
// claude-plugins-official ab024cdc, Apache-2.0. No upstream executable is run.

import { execFile } from "node:child_process";
import { decodeUtf8, readWorkspaceFile } from "../../../lib/files.ts";
import { runSessionAnalysis, runWorkReceipts, type ReceiptSelection, type Selection } from "../../../tools/session-insights.ts";
import type { ExecResult, ToolAPI } from "../../../lib/tool.ts";

function selectionFrom(value: unknown): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON selection object");
  const row = value as Record<string, unknown>;
  for (const key of ["inputRoot", "since", "until"]) if (typeof row[key] !== "string" || !row[key]) throw new Error(`${key} must be a nonempty string`);
  if (!Array.isArray(row.files) || row.files.some(file => typeof file !== "string")) throw new Error("files must be an explicit string array");
  for (const key of ["includePaths", "includePrompts", "includeCacheBreaks", "overwrite"]) if (row[key] !== undefined && typeof row[key] !== "boolean") throw new Error(`${key} must be boolean`);
  for (const key of ["html", "csv"]) if (row[key] !== undefined && typeof row[key] !== "string") throw new Error(`${key} must be a string`);
  if (row.cacheBreakThreshold !== undefined && (typeof row.cacheBreakThreshold !== "number" || !Number.isSafeInteger(row.cacheBreakThreshold) || row.cacheBreakThreshold < 1)) throw new Error("cacheBreakThreshold must be a positive integer");
  return row as unknown as Selection;
}
function receiptFrom(value: unknown): ReceiptSelection {
  const base = selectionFrom(value), row = value as Record<string, unknown>;
  if (!Array.isArray(row.history)) throw new Error("history must explicitly select jj roots and revsets");
  for (const item of row.history) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid history scope");
    const scope = item as Record<string, unknown>;
    for (const key of ["root", "revisions"]) if (typeof scope[key] !== "string" || !scope[key]) throw new Error(`${key} must be a nonempty string`);
    for (const key of ["label", "authorEmail"]) if (scope[key] !== undefined && typeof scope[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (row.maxCommits !== undefined && typeof row.maxCommits !== "number") throw new Error("maxCommits must be numeric");
  return { ...base, history: row.history as ReceiptSelection["history"], ...(row.maxCommits === undefined ? {} : { maxCommits: row.maxCommits as number }) };
}

const execute: ToolAPI["exec"] = (command, args, options) => new Promise<ExecResult>((resolve, reject) => {
  execFile(command, args, { cwd: options?.cwd, signal: options?.signal, timeout: options?.timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") { reject(error); return; }
    resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr, killed: error?.killed ?? false });
  });
});

async function main(): Promise<void> {
  const [mode, input, ...extra] = process.argv.slice(2);
  if (!["analyze", "receipts"].includes(mode) || !input || extra.length) throw new Error("Usage: bun session-insights.ts analyze|receipts <selection.json under cwd>");
  const cwd = process.cwd();
  const selected = await readWorkspaceFile(cwd, input, 1024 * 1024);
  const params: unknown = JSON.parse(decodeUtf8(selected.bytes));
  const output = mode === "analyze" ? await runSessionAnalysis({ cwd }, selectionFrom(params)) : await runWorkReceipts({ cwd, exec: execute }, receiptFrom(params));
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (import.meta.main) main().catch((error: unknown) => {
  process.stderr.write(`session-insights: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
