// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic uplift_checks.py, Apache-2.0, ab024cdc.
import { basename, extname, resolve } from "node:path";
import { readWorkspaceFile } from "../../../lib/files.ts";
import { kind, list, object, selectedRoot, sha, text, walk } from "./common.ts";
export function lineDiff(
  a: string[],
  b: string[],
): { added: number; removed: number; exact: boolean } {
  if (a.length * b.length <= 1_000_000) {
    const row = new Uint32Array(b.length + 1);
    for (const old of a) {
      let previous = 0;
      for (let j = 1; j <= b.length; j++) {
        const saved = row[j];
        row[j] = old === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
        previous = saved;
      }
    }
    return {
      added: b.length - row[b.length],
      removed: a.length - row[b.length],
      exact: true,
    };
  }
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const n = counts.get(line) ?? 0;
    if (n) counts.set(line, n - 1);
    else added++;
  }
  return {
    added,
    removed: [...counts.values()].reduce((sum, n) => sum + n, 0),
    exact: false,
  };
}
export async function upliftChecks(root: string, value: unknown) {
  const spec = object(value),
    legacy = await selectedRoot(resolve(root, text(spec.legacyRoot))),
    candidate = await selectedRoot(resolve(root, text(spec.candidateRoot)));
  const oldFiles = (await walk(legacy)).filter((f) => kind(f) === "test"),
    newFiles = (await walk(candidate)).filter((f) => kind(f) === "test");
  const removed = oldFiles.filter((f) => !newFiles.includes(f)),
    added = newFiles.filter((f) => !oldFiles.includes(f)),
    changed: {
      path: string;
      added: number;
      removed: number;
      exact: boolean;
      binary: boolean;
    }[] = [];
  const bodies = new Map<string, string>(), hashes = new Map<string, string>();
  let totalBytes = 0;
  for (const path of newFiles) {
    const bytes =
      (await readWorkspaceFile(candidate, path, 2 * 1024 * 1024)).bytes;
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error("Test inventory exceeds 64 MiB");
    }
    bodies.set(path, bytes.toString("utf8"));
    hashes.set(path, sha(bytes));
  }
  for (const path of oldFiles) {
    if (!bodies.has(path)) continue;
    const old = (await readWorkspaceFile(legacy, path, 2 * 1024 * 1024)).bytes;
    totalBytes += old.length;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error("Test inventory exceeds 64 MiB");
    }
    const a = old.toString("utf8").replace(/\r\n?/g, "\n"),
      b = bodies.get(path)!.replace(/\r\n?/g, "\n");
    const binary = old.includes(0) || b.includes("\0") ||
      a.includes("\uFFFD") || b.includes("\uFFFD");
    if (binary ? sha(old) === hashes.get(path) : a === b) continue;
    changed.push({
      path,
      ...(binary
        ? { added: 0, removed: 0, exact: false }
        : lineDiff(a.split("\n"), b.split("\n"))),
      binary,
    });
  }
  const words = new Set<string>();
  for (const body of bodies.values()) {
    if (!body.includes("\0") && !body.includes("\uFFFD")) {
      for (const match of body.matchAll(/[A-Za-z_$][\w$]*(?:-[\w$]+)*/g)) {
        words.add(match[0]);
      }
    }
  }
  const covered: string[] = [],
    uncovered: { id: string; missing: string[] }[] = [],
    config: string[] = [],
    other: string[] = [];
  const catalog = list(spec.deltas ?? [], 2000), ids = new Set<string>();
  for (const value of catalog) {
    const d = object(value),
      id = text(d.id, 100),
      category = text(d.category, 100);
    if (ids.has(id)) throw new Error("Duplicate delta id");
    ids.add(id);
    if (
      !/behaviou?ral[\s_-]*silent|silent[\s_-]*behaviou?ral/i.test(category)
    ) {
      other.push(id);
      continue;
    }
    const sites = list(d.sites, 100).map((v) => text(v)),
      code = sites.filter((s) =>
        !/\.(xml|ya?ml|json|properties|gradle|toml|ini|cfg)(?::\d+)?$/i.test(s)
      );
    if (sites.length && !code.length) {
      config.push(id);
      continue;
    }
    const missing = code.map((s) => basename(s.replace(/:\d+(?:-\d+)?$/, "")))
      .map((s) => s.slice(0, -extname(s).length)).filter((stem) =>
        !words.has(stem)
      );
    if (!code.length) missing.push("No code site cited");
    if (missing.length) uncovered.push({ id, missing });
    else covered.push(id);
  }
  const testsKept = {
    ok: oldFiles.length > 0 && removed.length === 0 &&
      changed.length <= oldFiles.length * 0.25,
    legacyTests: oldFiles.length,
    candidateTests: newFiles.length,
    removed,
    added,
    changed,
    share: oldFiles.length ? changed.length / oldFiles.length : null,
  };
  // Configuration-only silent deltas are unresolved evidence, not silently passed.
  const deltas = {
    ok: catalog.length > 0 && !uncovered.length && !config.length,
    covered,
    uncovered,
    config,
    other,
    parsed: catalog.length,
    evidence:
      "Test names mention sites; this does not establish behavioral coverage",
  };
  return { ok: testsKept.ok && deltas.ok, testsKept, deltas };
}
