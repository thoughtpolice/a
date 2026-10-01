// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact, parseArtifactHTML, type ArtifactState } from "../skills/project-artifact/scripts/render.ts";
import projectArtifact from "../tools/project-artifact.ts";
import type { SchemaBuilder, ToolAPI } from "../lib/tool.ts";
import { deepStrictEqual } from "node:assert";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function fails(action: () => unknown): void {
  try { action(); } catch (error) { assert(error instanceof Error, "Failure must be an Error"); return; }
  throw new Error("Expected failure");
}
async function rejects(action: () => Promise<unknown>): Promise<void> {
  try { await action(); } catch (error) { assert(error instanceof Error, "Failure must be an Error"); return; }
  throw new Error("Expected failure");
}
function fixture(): ArtifactState {
  return {
    version: 1, project_id: "release", as_of: "2026-10-01T12:00:00Z", title: "Release readiness",
    summary: "Validation complete; rollout pending.", phase: "Rollout decision", goal: "Ship with recovery intact.",
    criteria: [{ id: "restore", statement: "Recovery works", check: "Observe prior version restored", status: "done" }],
    out_of_scope: [], next_steps: [{ who: "Owner", action: "Choose window", unblocks: "Rollout" }], no_action_reason: "",
    evidence: [{ id: "check", label: "Recovery smoke", detail: "Prior version restored", freshness: "live", observed_at: "2026-10-01T11:55:00Z" }],
    workstreams: [{ id: "pr-7", title: "Validation", owner: "Team", status: "in progress", freshness: "live", observed_at: "2026-10-01T11:55:00Z", evidence: ["check"], repo: "org/repo", number: 7, workstream: "1.0", draft: false, ci: "passed", unresolved: 2, state: "OPEN", verification: "Observed recovery restored previous version" }],
    sections: [{ id: "risk", title: "Risks", paragraphs: ["Window decision delays rollout"], evidence: ["check"], freshness: "live" }],
    customizations: { title: "Team release", tab_labels: { work: "Sequence" }, tab_order: ["work", "over"], notes: { over: "Keep recovery visible" }, accent: "#24627c" },
  };
}

Deno.test("render round-trips complete facts and PR state; timestamps alone are not deltas", () => {
  const original = buildArtifact(fixture());
  const recovered = parseArtifactHTML(original.html);
  deepStrictEqual(recovered, original.state);
  const next = fixture(); next.as_of = "2026-10-01T13:00:00Z";
  next.workstreams[0].observed_at = next.evidence[0].observed_at = "2026-10-01T12:55:00Z";
  const refresh = buildArtifact(next, recovered);
  assert(refresh.delta.length === 0, "Fresh observations alone must not manufacture substantive changes");
  next.workstreams[0].ci = "failed"; next.workstreams[0].unresolved = 3; next.workstreams[0].state = "MERGED";
  const change = buildArtifact(next, recovered).delta.find((d) => d.entity === "workstreams/pr-7");
  assert(change?.kind === "changed" && JSON.stringify(change.fields.sort()) === JSON.stringify(["ci", "state", "unresolved"]), "CI, merge state and unresolved threads must have field-specific deltas");
});

Deno.test("refresh preserves absent facts as stale, local customization and explicit stale failures", () => {
  const previous = buildArtifact(fixture()).state;
  const next = { ...fixture(), as_of: "2026-10-01T13:00:00Z", workstreams: [], evidence: [], sections: [], customizations: { notes: { work: "Coordinate rollout" } } };
  const refreshed = buildArtifact(next, previous);
  assert(refreshed.state.workstreams[0].ci === "passed" && refreshed.state.workstreams[0].freshness === "stale", "Omitted row retains prior facts and becomes stale");
  assert(refreshed.state.evidence[0].detail === previous.evidence[0].detail && refreshed.state.evidence[0].freshness === "stale", "Omitted source must not be fabricated or deleted");
  assert(refreshed.state.sections[0].freshness === "stale", "Absent sections must disclose stale content");
  assert(refreshed.state.customizations.title === "Team release" && refreshed.state.customizations.notes?.over === "Keep recovery visible" && refreshed.state.customizations.notes?.work === "Coordinate rollout", "New notes merge without erasing prior customization");
  const failed = fixture(); failed.as_of = next.as_of; failed.workstreams[0].freshness = "stale"; failed.workstreams[0].reason = "API denied"; failed.workstreams[0].ci = "invented new result";
  const retained = buildArtifact(failed, previous).state.workstreams[0];
  assert(retained.ci === "passed" && retained.reason === "API denied", "Failed refresh must not replace known facts with newly claimed values");
  deepStrictEqual(parseArtifactHTML(refreshed.html), refreshed.state);
});

Deno.test("explicit removals and additions differ from omission and retain safe references", () => {
  const prior = buildArtifact(fixture()).state;
  const next = fixture(); next.as_of = "2026-10-01T13:00:00Z"; next.sections = [];
  next.workstreams = [{ ...next.workstreams[0], id: "pr-8", number: 8, workstream: "2.0", status: "next" }];
  const refreshed = buildArtifact({ ...next, remove: { workstreams: ["pr-7"], sections: ["risk"] } }, prior);
  assert(refreshed.state.workstreams[0].id === "pr-8" && refreshed.state.workstreams.length === 1, "Verified removal must remove, not retain stale");
  assert(refreshed.delta.some((d) => d.kind === "removed" && d.entity === "workstreams/pr-7") && refreshed.delta.some((d) => d.kind === "added" && d.entity === "workstreams/pr-8"), "Added and removed identities need separate deltas");
  fails(() => buildArtifact({ ...fixture(), remove: { workstreams: ["pr-7"] } }, prior));
  fails(() => buildArtifact({ ...next, remove: { evidence: ["check"] } }, prior));
  next.workstreams[0].depends_on = ["pr-8"];
  fails(() => buildArtifact(next));
});

Deno.test("hostile source data is inert text and cannot terminate the machine-readable state", () => {
  const input = fixture(), hostile = '</script><img src=x onerror="globalThis.compromised=true">&\u2028';
  input.title = hostile; input.summary = hostile; input.workstreams[0].title = hostile;
  input.evidence[0].detail = hostile; input.customizations = { title: hostile, notes: { over: hostile } };
  const rendered = buildArtifact(input);
  assert(!rendered.html.includes('<img src=x') && !rendered.html.includes(hostile), "Untrusted text must never become HTML or close the JSON script");
  const recovered = parseArtifactHTML(rendered.html);
  assert(recovered.title === hostile && recovered.customizations.notes?.over === hostile && recovered.evidence[0].detail === hostile, "Escaping must preserve the original evidence exactly");
  for (const url of ["javascript:alert(1)", "data:text/html,x", "https://user:secret@example.com/x"]) {
    input.evidence[0].url = url; fails(() => buildArtifact(input));
  }
  delete input.evidence[0].url;
  input.customizations.accent = '#ffffff;}</style><script>alert(1)</script>';
  fails(() => buildArtifact(input));
});

Deno.test("invalid facts, time, state and oversized output fail rather than ship a skeleton", () => {
  const valid = fixture();
  for (const patch of [
    { criteria: [] }, { workstreams: [] }, { evidence: [] }, { next_steps: [], no_action_reason: "" },
    { as_of: "2026-02-30T12:00:00Z" }, { as_of: "2026-10-01T10:00:00Z" },
    { evidence: [...valid.evidence, ...valid.evidence] },
    { sections: [{ ...valid.sections[0], id: "artifact-state" }] },
  ]) fails(() => buildArtifact({ ...valid, ...patch }));
  const wrong = fixture(); wrong.project_id = "another"; fails(() => buildArtifact(wrong, valid));
  const backwards = fixture(); backwards.as_of = "2026-09-30T12:00:00Z"; fails(() => buildArtifact(backwards, valid));
  const unknownReference = fixture(); unknownReference.workstreams[0].evidence = ["missing"]; fails(() => buildArtifact(unknownReference));
  const nonLive = fixture(); nonLive.evidence[0].freshness = "stale"; nonLive.evidence[0].reason = "Source unavailable"; fails(() => buildArtifact(nonLive));
  fails(() => parseArtifactHTML("<html>No prior state</html>"));
  const html = buildArtifact(valid).html; fails(() => parseArtifactHTML(html + html));
  const oversized = fixture(); oversized.title = "x".repeat(8 * 1024 * 1024); fails(() => buildArtifact(oversized));
  const amplified = fixture(); amplified.evidence = Array.from({ length: 20 }, (_, i) => ({ ...valid.evidence[0], id: i === 0 ? "check" : `e${i}`, detail: "&".repeat(90000) }));
  fails(() => buildArtifact(amplified));
});

const schema: SchemaBuilder = {
  Object: (properties, options) => ({ type: "object", properties, ...options }), String: (options) => ({ type: "string", ...options }),
  Integer: (options) => ({ type: "integer", ...options }), Boolean: (options) => ({ type: "boolean", ...options }),
  Array: (items, options) => ({ type: "array", items, ...options }), Union: (anyOf) => ({ anyOf }), Literal: (value) => ({ const: value }), Optional: (value) => value,
};
Deno.test("native artifact files are private, refresh requires overwrite and rejects escaping/symlink paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-project-artifact-"));
  const outside = await mkdtemp(join(tmpdir(), "omp-project-outside-"));
  try {
    const api: ToolAPI = { cwd: root, typebox: { Type: schema }, exec: () => { throw new Error("Artifact rendering cannot execute a command"); } };
    const tool = projectArtifact(api);
    await writeFile(join(root, "spec.json"), JSON.stringify(fixture()));
    await tool.execute("create", { mode: "create", spec_file: "spec.json", output: "status.html" });
    const original = await readFile(join(root, "status.html"), "utf8"), info = await lstat(join(root, "status.html"));
    assert(info.isFile() && (Deno.build.os === "windows" || (info.mode & 0o777) === 0o600), "Dashboard must be a private regular file");
    await rejects(() => tool.execute("again", { mode: "create", spec_file: "spec.json", output: "status.html" }));
    const fresh = fixture(); fresh.as_of = "2026-10-01T13:00:00Z"; fresh.workstreams[0].status = "done";
    await writeFile(join(root, "spec.json"), JSON.stringify(fresh));
    await rejects(() => tool.execute("refresh-denied", { mode: "refresh", spec_file: "spec.json", output: "status.html" }));
    assert(await readFile(join(root, "status.html"), "utf8") === original, "Denied refresh must leave previous HTML intact");
    await tool.execute("refresh", { mode: "refresh", spec_file: "spec.json", output: "status.html", overwrite: true });
    assert(parseArtifactHTML(await readFile(join(root, "status.html"), "utf8")).workstreams[0].status === "done", "Authorized refresh must publish current status");
    await rejects(() => tool.execute("escape", { mode: "create", spec_file: "spec.json", output: join(outside, "leak.html") }));
    await symlink(outside, join(root, "linked"));
    await rejects(() => tool.execute("symlink", { mode: "create", spec_file: "spec.json", output: "linked/leak.html" }));
    await rejects(() => tool.execute("clobber-spec", { mode: "create", spec_file: "spec.json", output: "spec.json", overwrite: true }));
    await writeFile(join(root, "corrupt.html"), "not an artifact");
    await rejects(() => tool.execute("corrupt", { mode: "refresh", spec_file: "spec.json", previous: "corrupt.html", output: "status.html", overwrite: true }));
    assert(parseArtifactHTML(await readFile(join(root, "status.html"), "utf8")).workstreams[0].status === "done", "Invalid prior state must not replace the current dashboard");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

Deno.test("refresh collection limits include retained stale records and allow explicit removal", () => {
  const initial = fixture();
  initial.evidence.push(...Array.from({ length: 1999 }, (_, i) => ({ id: `old-${i}`, label: "Prior evidence", detail: "Fixture only", freshness: "unknown" as const, reason: "Not observed" })));
  const previous = buildArtifact(initial).state;
  const next = { ...fixture(), workstreams: [], sections: [], evidence: [{ id: "new", label: "New evidence", detail: "Fixture only", freshness: "unknown", reason: "Not observed" }] };
  fails(() => buildArtifact(next, previous));
  const refreshed = buildArtifact({ ...next, remove: { evidence: ["old-1998"] } }, previous);
  const restored = parseArtifactHTML(refreshed.html);
  assert(restored.evidence.length === 2000 && restored.evidence.some((e) => e.id === "new") && !restored.evidence.some((e) => e.id === "old-1998"), "A bounded successful refresh remains readable and preserves precisely the nonremoved evidence");
});
