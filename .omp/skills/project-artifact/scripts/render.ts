// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Adapted from Anthropic claude-plugins-official project-artifact (Apache-2.0),
// revision ab024cdc: SKILL.md, swe.md, template.html. Modified: local typed renderer,
// evidence validation, refresh reconciliation, accessible offline UI; no publishing.

export type Freshness = "live" | "stale" | "unknown";
export interface Evidence {
  id: string; label: string; detail: string; freshness: Freshness;
  observed_at?: string; url?: string; reason?: string;
}
export interface Workstream {
  id: string; title: string; owner: string; status: string; evidence: string[];
  freshness: Freshness; observed_at?: string; reason?: string;
  depends_on?: string[]; detail?: string; verification?: string;
  repo?: string; number?: number; workstream?: string; draft?: boolean;
  ci?: string; unresolved?: number; state?: string;
}
export interface Criterion { id: string; statement: string; check: string; status: string; group?: string }
export interface Section { id: string; title: string; paragraphs: string[]; evidence: string[]; freshness: Freshness; reason?: string }
export interface Customizations {
  title?: string; accent?: string; tab_labels?: Record<string, string>;
  tab_order?: string[]; notes?: Record<string, string>;
}
export interface ArtifactState {
  version: 1; project_id: string; as_of: string; title: string; summary: string;
  phase: string; goal: string; criteria: Criterion[]; out_of_scope: string[];
  next_steps: { who: string; action: string; unblocks: string }[];
  no_action_reason: string; workstreams: Workstream[]; evidence: Evidence[];
  sections: Section[]; customizations: Customizations;
}
export interface Delta { kind: "added" | "removed" | "changed"; entity: string; fields: string[] }
const MAX_BYTES = 8 * 1024 * 1024;
const reserved: Record<string, true> = { over: true, work: true, evidence: true, "artifact-state": true };
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) throw new Error(`${label} must be nonempty text (at most 100000 characters)`);
  return value;
}
function id(value: unknown, label: string): string {
  const s = text(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(s)) throw new Error(`${label} must be a stable alphanumeric ID (up to 80 characters)`);
  return s;
}
function list<T>(value: unknown, label: string, parse: (v: unknown, label: string) => T): T[] {
  if (!Array.isArray(value) || value.length > 2000) throw new Error(`${label} must be an array of at most 2000 items`);
  return value.map((v, i) => parse(v, `${label}[${i}]`));
}
function unique<T extends { id: string }>(items: T[], label: string): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Duplicate ${label} ID`);
  return items;
}
function timestamp(value: unknown, label: string): string {
  const s = text(value, label);
  const milliseconds = Date.parse(s);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== s.slice(0, 19)) throw new Error(`${label} must be an ISO UTC timestamp`);
  return s;
}
function fresh(r: Record<string, unknown>, label: string): Freshness {
  if (r.freshness !== "live" && r.freshness !== "stale" && r.freshness !== "unknown") throw new Error(`${label}.freshness must be live, stale, or unknown`);
  if (r.freshness === "live") timestamp(r.observed_at, `${label}.observed_at`);
  if (r.freshness !== "live") text(r.reason, `${label}.reason`);
  return r.freshness;
}
function optionalText(r: Record<string, unknown>, keys: string[], label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) if (r[key] !== undefined) result[key] = text(r[key], `${label}.${key}`);
  return result;
}
function parseEvidence(value: unknown, label: string): Evidence {
  const r = record(value, label);
  const item: Evidence = { id: id(r.id, label), label: text(r.label, label), detail: text(r.detail, label), freshness: fresh(r, label), ...optionalText(r, ["observed_at", "url", "reason"], label) };
  if (item.observed_at) timestamp(item.observed_at, label);
  if (item.url && !/^https?:\/\//i.test(item.url)) throw new Error(`${label}.url must be http(s)`);
  if (item.url) { const url = new URL(item.url); if (url.username || url.password) throw new Error("Evidence URLs cannot contain credentials"); }
  return item;
}
function parseWork(value: unknown, label: string): Workstream {
  const r = record(value, label);
  const item: Workstream = { id: id(r.id, label), title: text(r.title, label), owner: text(r.owner, label), status: text(r.status, label), evidence: list(r.evidence, label, id), freshness: fresh(r, label), ...optionalText(r, ["observed_at", "reason", "detail", "verification", "repo", "workstream", "ci", "state"], label) };
  if (item.observed_at) timestamp(item.observed_at, label);
  if (r.depends_on !== undefined) item.depends_on = list(r.depends_on, label, id);
  for (const key of ["number", "unresolved"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] < (key === "number" ? 1 : 0)) throw new Error(`${label}.${key} must be a nonnegative integer (PR numbers start at 1)`);
      item[key] = r[key];
    }
  }
  if (r.draft !== undefined) { if (typeof r.draft !== "boolean") throw new Error(`${label}.draft must be boolean`); item.draft = r.draft; }
  if (item.number !== undefined && [item.repo, item.workstream, item.ci, item.state, item.draft, item.unresolved].some((v) => v === undefined)) throw new Error("PR rows require repo, number, workstream, draft, ci, unresolved, state");
  return item;
}
function parseSection(value: unknown, label: string): Section {
  const r = record(value, label), sectionId = id(r.id, label);
  if (Object.hasOwn(reserved, sectionId) || /^(tab-|heading-|e-)/.test(sectionId)) throw new Error(`Reserved section ID: ${sectionId}`);
  const freshness = r.freshness;
  if (freshness !== "live" && freshness !== "stale" && freshness !== "unknown") throw new Error(`${label}.freshness must be live, stale, or unknown`);
  const paragraphs = list(r.paragraphs, label, text);
  if (!paragraphs.length) throw new Error("Empty tabs are not artifacts");
  if (freshness !== "live") text(r.reason, label);
  return { id: sectionId, title: text(r.title, label), paragraphs, evidence: list(r.evidence, label, id), freshness, ...optionalText(r, ["reason"], label) };
}
function stringMap(value: unknown, label: string): Record<string, string> {
  const map = record(value, label), result: Record<string, string> = Object.create(null);
  for (const [key, v] of Object.entries(map)) result[id(key, label)] = text(v, label);
  return result;
}
function custom(value: unknown): Customizations {
  if (value === undefined) return {};
  const r = record(value, "customizations"), c: Customizations = {};
  if (r.title !== undefined) c.title = text(r.title, "customizations.title");
  if (r.accent !== undefined) { const accent = text(r.accent, "accent"); if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error("Accent must be a six-digit hex color"); c.accent = accent; }
  if (r.tab_labels !== undefined) c.tab_labels = stringMap(r.tab_labels, "tab_labels");
  if (r.notes !== undefined) c.notes = stringMap(r.notes, "notes");
  if (r.tab_order !== undefined) c.tab_order = list(r.tab_order, "tab_order", id);
  return c;
}
function reconcile<T extends { id: string; freshness: Freshness; reason?: string }>(current: T[], previous: T[], removed: Set<string>): T[] {
  const old = new Map(previous.map((item) => [item.id, item]));
  const result = current.map((item) => {
    if (removed.has(item.id)) throw new Error(`Cannot both supply and remove ${item.id}`);
    const prior = old.get(item.id); old.delete(item.id);
    return item.freshness === "stale" && prior ? { ...prior, freshness: item.freshness, reason: item.reason } : item;
  });
  for (const item of old.values()) if (!removed.has(item.id)) result.push({ ...item, freshness: "stale", reason: "Not supplied in this refresh; retained from previous render" });
  if (result.length > 2000) throw new Error("Reconciled collection exceeds 2000 items; explicitly remove obsolete records");
  return result;
}
export function buildArtifact(input: unknown, previous?: ArtifactState): { html: string; state: ArtifactState; delta: Delta[] } {
  const raw = JSON.stringify(input);
  if (!raw || new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("Specification exceeds 8 MiB");
  const r = record(input, "spec"), projectId = id(r.project_id, "project_id"), asOf = timestamp(r.as_of, "as_of");
  if (previous && previous.project_id !== projectId) throw new Error("Refresh project_id differs from previous artifact");
  if (previous && Date.parse(asOf) < Date.parse(previous.as_of)) throw new Error("Refresh as_of precedes previous render");
  const removal = record(r.remove ?? {}, "remove");
  const removed = (key: string) => new Set(list(removal[key] ?? [], `remove.${key}`, id));
  const state: ArtifactState = {
    version: 1, project_id: projectId, as_of: asOf,
    title: text(r.title, "title"), summary: text(r.summary, "summary"), phase: text(r.phase, "phase"), goal: text(r.goal, "goal"),
    criteria: unique(list(r.criteria, "criteria", (v, label) => { const c = record(v, label); return { id: id(c.id, label), statement: text(c.statement, label), check: text(c.check, label), status: text(c.status, label), ...optionalText(c, ["group"], label) }; }), "criterion"),
    out_of_scope: list(r.out_of_scope ?? [], "out_of_scope", text),
    next_steps: list(r.next_steps, "next_steps", (v, label) => { const s = record(v, label); return { who: text(s.who, label), action: text(s.action, label), unblocks: text(s.unblocks, label) }; }),
    no_action_reason: r.no_action_reason === "" ? "" : text(r.no_action_reason, "no_action_reason", true),
    workstreams: reconcile(unique(list(r.workstreams, "workstreams", parseWork), "workstream"), previous?.workstreams ?? [], removed("workstreams")),
    evidence: reconcile(unique(list(r.evidence, "evidence", parseEvidence), "evidence"), previous?.evidence ?? [], removed("evidence")),
    sections: reconcile(unique(list(r.sections ?? [], "sections", parseSection), "section"), previous?.sections ?? [], removed("sections")),
    customizations: { ...previous?.customizations, ...custom(r.customizations) },
  };
  const updates = custom(r.customizations);
  for (const key of ["tab_labels", "notes"] as const) if (updates[key]) state.customizations[key] = Object.assign(Object.create(null), previous?.customizations[key], updates[key]);
  if (!state.criteria.length || !state.workstreams.length || !state.evidence.length) throw new Error("Artifacts require real criteria, workstreams, and evidence");
  if (!state.next_steps.length && !state.no_action_reason) throw new Error("Empty next_steps requires no_action_reason");
  const evidenceIds = new Map(state.evidence.map((e) => [e.id, e]));
  const workIds = new Set(state.workstreams.map((w) => w.id));
  for (const item of [...state.workstreams, ...state.sections]) {
    if (item.freshness === "live" && !item.evidence.length) throw new Error(`Live item ${item.id} needs evidence`);
    for (const reference of item.evidence) {
      const evidence = evidenceIds.get(reference);
      if (!evidence) throw new Error(`Unknown evidence ${reference} in ${item.id}`);
      if (item.freshness === "live" && evidence.freshness !== "live") throw new Error(`Live item ${item.id} references non-live evidence ${reference}`);
    }
  }
  for (const w of state.workstreams) for (const dependency of w.depends_on ?? []) if (!workIds.has(dependency) || dependency === w.id) throw new Error(`Invalid dependency ${dependency} in ${w.id}`);
  for (const item of [...state.workstreams, ...state.evidence]) if (item.observed_at && Date.parse(item.observed_at) > Date.parse(asOf)) throw new Error(`Observation for ${item.id} is newer than as_of`);
  const delta: Delta[] = [];
  if (previous) {
    for (const key of ["workstreams", "evidence", "sections", "criteria"] as const) {
      const old = new Map(previous[key].map((v) => [v.id, v]));
      for (const item of state[key]) {
        const prior = old.get(item.id); old.delete(item.id);
        if (!prior) delta.push({ kind: "added", entity: `${key}/${item.id}`, fields: [] });
        else {
          const a = record(prior, "previous"), b = record(item, "current");
          const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((field) => field !== "observed_at" && JSON.stringify(a[field]) !== JSON.stringify(b[field]));
          if (fields.length) delta.push({ kind: "changed", entity: `${key}/${item.id}`, fields });
        }
      }
      for (const item of old.values()) delta.push({ kind: "removed", entity: `${key}/${item.id}`, fields: [] });
    }
    const fields = ["title", "summary", "phase", "goal", "out_of_scope", "next_steps", "no_action_reason", "customizations"].filter((key) => JSON.stringify(record(previous, "previous")[key]) !== JSON.stringify(record(state, "state")[key]));
    if (fields.length) delta.push({ kind: "changed", entity: "project", fields });
  }
  const html = renderArtifact(state);
  if (new TextEncoder().encode(html).length > MAX_BYTES) throw new Error("Rendered artifact exceeds 8 MiB");
  return { html, state, delta };
}
export function parseArtifactHTML(html: string): ArtifactState {
  if (new TextEncoder().encode(html).length > MAX_BYTES) throw new Error("Previous artifact exceeds 8 MiB");
  const matches = [...html.matchAll(/<script type="application\/json" id="artifact-state">([\s\S]*?)<\/script>/g)];
  if (matches.length !== 1) throw new Error("Expected exactly one artifact-state block");
  const value: unknown = JSON.parse(matches[0][1]);
  const r = record(value, "artifact-state");
  if (r.version !== 1) throw new Error("Unsupported artifact-state version");
  return buildArtifact(value).state;
}
function escape(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c)); }
function json(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function pill(status: string): string { const tone = /^(done|merged|passed)$/i.test(status) ? "done" : /blocked|fail/i.test(status) ? "blocked" : "neutral"; return `<span class="pill ${tone}">${escape(status)}</span>`; }
function freshness(item: { freshness: Freshness; observed_at?: string; reason?: string }): string { return `<span class="fresh ${item.freshness}">${escape(item.freshness)}${item.observed_at ? ` · ${escape(item.observed_at)}` : ""}</span>${item.reason ? `<p class="meta">${escape(item.reason)}</p>` : ""}`; }
function refs(ids: string[]): string { return ids.map((id) => `<a href="#e-${escape(id)}" data-evidence="${escape(id)}">${escape(id)}</a>`).join(", "); }
function table(headers: string[], rows: string[][]): string { return `<div class="table-scroll" tabindex="0"><table><thead><tr>${headers.map((h) => `<th scope="col">${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; }
export function renderArtifact(state: ArtifactState): string {
  const c = state.customizations;
  const groups = [...new Set(state.criteria.map((s) => s.group ?? "Success criteria"))];
  const overview = `<p class="callout">${escape(state.goal)}</p>${groups.map((group) => `<h3>${escape(group)}</h3>${table(["Criterion", "Check", "Status"], state.criteria.filter((s) => (s.group ?? "Success criteria") === group).map((s) => [escape(s.statement), escape(s.check), pill(s.status)]))}`).join("")}${state.out_of_scope.length ? `<h3>Out of scope</h3><ul>${state.out_of_scope.map((s) => `<li>${escape(s)}</li>`).join("")}</ul>` : ""}`;
  const work = table(["ID / workstream", "Owner / dependencies", "Status / freshness", "Evidence"], state.workstreams.map((w) => [`<strong>${escape(w.id)}</strong><br>${escape(w.title)}`, `${escape(w.owner)}${w.depends_on?.length ? `<br>After ${w.depends_on.map(escape).join(", ")}` : ""}`, `${pill(w.status)}<br>${freshness(w)}`, refs(w.evidence)])) + state.workstreams.map((w) => `<article><h3>${escape(w.id)} — ${escape(w.title)}</h3>${w.detail ? `<p>${escape(w.detail)}</p>` : ""}${w.verification ? `<h4>Verification</h4><p>${escape(w.verification)}</p>` : ""}${w.number ? `<p>PR ${escape(w.repo ?? "")} #${w.number} · Stage ${escape(w.workstream ?? "")} · ${w.draft ? "Draft" : "Ready for review"} · CI: ${escape(w.ci ?? "")} · Unresolved threads: ${w.unresolved} · ${escape(w.state ?? "")}</p>` : ""}</article>`).join("");
  const evidence = state.evidence.map((e) => `<article id="e-${escape(e.id)}"><h3>${escape(e.label)}</h3>${freshness(e)}<p>${escape(e.detail)}</p>${e.url ? `<a href="${escape(e.url)}" rel="noreferrer noopener">Open source: ${escape(e.id)}</a>` : `<p class="meta">Source ID: ${escape(e.id)} (local evidence)</p>`}</article>`).join("");
  const tabs = [{ id: "over", title: "Overview", content: overview }, { id: "work", title: "Workstreams", content: work }, ...state.sections.map((s) => ({ id: s.id, title: s.title, content: `${freshness(s)}${s.paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}<p>Evidence: ${refs(s.evidence)}</p>` })), { id: "evidence", title: "Evidence", content: evidence }];
  const order = c.tab_order ?? [];
  const rank = new Map(tabs.map((tab, index) => [tab.id, order.includes(tab.id) ? order.indexOf(tab.id) : order.length + index]));
  tabs.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const title = c.title ?? state.title;
  return `<!doctype html>
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp; SPDX-License-Identifier: Apache-2.0
Adapted from Anthropic project-artifact ab024cdc; modified for local evidence-driven refresh. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>
:root{color-scheme:light dark;--bg:#fafbfc;--fg:#182632;--surface:#edf2f5;--line:#b6c4ce;--accent:${c.accent ?? "#24627c"};--muted:#445764}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}main,header,.top{max-width:1100px;margin:auto;padding:1rem 1.5rem}header{padding-top:2.5rem}h1{font-size:clamp(1.7rem,4vw,2.6rem);line-height:1.15}h2,h3,h4{line-height:1.35}a{color:var(--accent)}button{font:inherit;color:inherit;cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.meta{color:var(--muted);font-size:.9rem}.banner,.next,.callout{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);padding:1rem;margin:1rem 0}.banner strong{display:block}.next summary{cursor:pointer;font-weight:600}.tabs{display:flex;flex-wrap:wrap;gap:.35rem;border-bottom:1px solid var(--line);padding-bottom:.5rem}.tabs button{border:1px solid var(--line);background:var(--bg);padding:.6rem .8rem;border-radius:4px}.tabs button[aria-selected=true]{background:var(--fg);color:var(--bg)}.table-scroll{max-width:100%;overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:560px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:.7rem}th{background:var(--surface)}.pill,.fresh{display:inline-block;border:1px solid currentColor;border-radius:4px;padding:.05rem .45rem;font-size:.86rem}.done{color:#145c36;background:#e6f5ec}.blocked,.stale{color:#8c3219;background:#fff1e9}.unknown{color:#594512;background:#fff8d9}.neutral,.live{color:var(--fg);background:var(--surface)}article{padding:1rem 0;border-bottom:1px solid var(--line)}.note{border-left:3px solid var(--accent);padding-left:1rem;white-space:pre-wrap}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:root{--bg:#14232e;--fg:#e5edf3;--surface:#203743;--line:#587380;--accent:${c.accent ?? "#94cee5"};--muted:#bdcbd3}.done{color:#b1edc5;background:#183828}.blocked,.stale{color:#ffc4ae;background:#442d24}.unknown{color:#f8dc8d;background:#3e351c}}@media(max-width:520px){main,header,.top{padding:1rem}table{min-width:480px}.tabs button{flex-grow:1}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><header><p class="meta">Local project status · ${escape(state.project_id)}</p><h1>${escape(title)}</h1><p>${escape(state.summary)}</p></header><div class="top"><div class="banner"><strong>${escape(state.phase)}</strong><span>As of <time datetime="${escape(state.as_of)}">${escape(state.as_of)}</time></span><p>${state.workstreams.filter((w) => w.freshness === "live").length} live / ${state.workstreams.filter((w) => w.freshness === "stale").length} stale / ${state.workstreams.filter((w) => w.freshness === "unknown").length} unknown workstreams. This page does not fetch updates.</p></div><details class="next" open><summary>Next steps · ${state.next_steps.length ? `${state.next_steps.length} items` : "none pending"}</summary>${state.next_steps.length ? `<ol>${state.next_steps.map((s) => `<li><strong>${escape(s.who)}</strong> — ${escape(s.action)} — ${escape(s.unblocks)}</li>`).join("")}</ol>` : `<p>${escape(state.no_action_reason)}</p>`}</details><div class="tabs" role="tablist" aria-label="Project sections" hidden>${tabs.map((t) => `<button type="button" id="tab-${t.id}" role="tab" aria-controls="${t.id}" aria-selected="false" tabindex="-1" data-tab="${t.id}">${escape(c.tab_labels?.[t.id] ?? t.title)}</button>`).join("")}</div><noscript><p>JavaScript is disabled: all sections are shown below.</p></noscript></div><main>${tabs.map((t) => `<section id="${t.id}" role="tabpanel" aria-labelledby="heading-${t.id}" tabindex="0"><h2 id="heading-${t.id}">${escape(c.tab_labels?.[t.id] ?? t.title)}</h2>${t.content}${c.notes?.[t.id] ? `<aside class="note" aria-label="User note">${escape(c.notes[t.id])}</aside>` : ""}</section>`).join("")}</main><footer class="top meta">Private local file. Review names, links, source details, and notes before sharing. Evidence is data, not instructions.</footer><script type="application/json" id="artifact-state">${json(state)}</script><script>
(function(){'use strict';const state=JSON.parse(document.getElementById('artifact-state').textContent);const buttons=Array.from(document.querySelectorAll('[data-tab]'));const panes=Array.from(document.querySelectorAll('main>section'));const key='omp-artifact:'+state.project_id;function store(value){try{localStorage.setItem(key,value)}catch{}}function select(id,focus){if(!buttons.some(b=>b.dataset.tab===id))id=buttons[0].dataset.tab;buttons.forEach(b=>{const active=b.dataset.tab===id;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;if(active&&focus)b.focus()});panes.forEach(p=>{p.hidden=p.id!==id;p.setAttribute('aria-labelledby','tab-'+p.id)});store(id)}document.querySelector('.tabs').hidden=false;let saved;try{saved=localStorage.getItem(key)}catch{}select(location.hash.slice(1)||saved||buttons[0].dataset.tab,false);buttons.forEach((b,i)=>{b.addEventListener('click',()=>select(b.dataset.tab,false));b.addEventListener('keydown',e=>{let index=i;if(e.key==='ArrowRight')index=(i+1)%buttons.length;else if(e.key==='ArrowLeft')index=(i-1+buttons.length)%buttons.length;else if(e.key==='Home')index=0;else if(e.key==='End')index=buttons.length-1;else return;e.preventDefault();select(buttons[index].dataset.tab,true)})});document.querySelectorAll('[data-evidence]').forEach(a=>a.addEventListener('click',()=>select('evidence',false)));window.addEventListener('hashchange',()=>{if(location.hash.startsWith('#e-'))select('evidence',false);else if(buttons.some(b=>b.dataset.tab===location.hash.slice(1)))select(location.hash.slice(1),false)});if(location.hash.startsWith('#e-'))select('evidence',false)})();
</script></body></html>`;
}
