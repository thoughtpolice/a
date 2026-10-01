// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic build_report.py, Apache-2.0, ab024cdc.
import { decodeUtf8, readWorkspaceFile } from "../../../lib/files.ts";
import { html, json, list, md, object, text } from "./common.ts";
import { proofPack } from "./proof_pack.ts";
import { parseRules } from "./trace_rules.ts";
export function topologyFacts(value: unknown) {
  const spec = object(value), nodes: { id: string; name: string; kind: string; file: string; loc: number; language: string }[] = [], ids = new Set<string>();
  function visit(value: unknown, depth: number): void {
    if (depth > 40 || nodes.length >= 20000) throw new Error("Topology exceeds bounds");
    const n = object(value), id = text(n.id, 300); if (ids.has(id)) throw new Error("Duplicate topology id"); ids.add(id);
    nodes.push({ id, name: text(n.name, 300), kind: text(n.kind, 30), file: n.file === undefined ? "" : text(n.file), loc: typeof n.loc === "number" && Number.isSafeInteger(n.loc) && n.loc >= 0 ? n.loc : 0, language: n.language === undefined ? "" : text(n.language, 100) });
    for (const child of list(n.children ?? [], 20000)) visit(child, depth + 1);
  }
  visit(spec.root, 0);
  const edges = list(spec.edges ?? [], 50000).map(v => { const e = object(v), source = text(e.source), target = text(e.target); if (!ids.has(source) || !ids.has(target)) throw new Error("Dangling topology edge"); return { source, target, kind: text(e.kind, 30) }; });
  const entryPoints = list(spec.entryPoints ?? [], 20000).map(v => text(v)), deadEnds = list(spec.deadEnds ?? [], 20000).map(v => text(v));
  if (entryPoints.concat(deadEnds).some(id => !ids.has(id))) throw new Error("Unknown topology entry/dead-end id");
  const flows = list(spec.flows ?? [], 100).map(v => {
    const f = object(v); return { name: text(f.name), persona: text(f.persona), description: text(f.description), steps: list(f.steps, 100).map(v => { const s = object(v), nodes = list(s.nodes, 100).map(v => text(v)); if (nodes.some(id => !ids.has(id))) throw new Error("Unknown flow node"); return { label: text(s.label), nodes }; }) };
  });
  const modules = nodes.filter(n => n.kind === "module");
  return { modules: modules.length, loc: modules.reduce((sum, n) => sum + n.loc, 0), languages: [...new Set(modules.map(n => n.language).filter(Boolean))].sort(), nodes, edges, entryPoints, deadEnds, observations: list(spec.observations ?? [], 100).map(v => text(v)), flows };
}
export async function buildReport(root: string, value: unknown) {
  const spec = object(value), title = text(spec.system, 200), sections: { title: string; body: string }[] = [], warnings: string[] = [], stages = new Set<string>(); let size = 0;
  const facts: Record<string, unknown> = {};
  for (const value of list(spec.artifacts ?? [], 100)) {
    const artifact = object(value), path = text(artifact.path), name = text(artifact.title, 300);
    if (path.split("/").some(p => /\.local\.|^secrets/i.test(p))) { warnings.push(`Private artifact excluded: ${path}`); continue; }
    try {
      const bytes = (await readWorkspaceFile(root, path, 3 * 1024 * 1024)).bytes; size += bytes.length;
      if (size > 6 * 1024 * 1024) throw new Error("Report aggregate limit exceeded");
      const body = decodeUtf8(bytes).replace(/\p{Cc}/gu, (control) => "\t\r\n".includes(control) ? control : "�"); sections.push({ title: name, body });
      if (artifact.stage !== undefined) stages.add(text(artifact.stage, 30));
      if (artifact.stage === "rules") { const rules = parseRules(body); facts.rules = { total: rules.length, byPriority: Object.fromEntries([...new Set(rules.map(r => r.priority))].map(p => [p, rules.filter(r => r.priority === p).length])), needsConfirmation: rules.filter(r => r.confidence !== "High").map(r => r.id) }; }
    } catch (error) { warnings.push(`${path}: ${String(error)}`); }
  }
  let verdict = "NOT VERIFIED";
  if (spec.proofRequest !== undefined) {
    try { const proof = await proofPack(root, await json(root, text(spec.proofRequest))); verdict = proof.verdict; facts.proof = proof; sections.unshift({ title: "Current evidence proof", body: JSON.stringify(proof, null, 2) }); }
    catch (error) { verdict = "NOT PROVEN"; warnings.push(`Proof could not be recomputed: ${String(error)}`); }
  }
  if (spec.topology !== undefined) {
    try { const topology = topologyFacts(await json(root, text(spec.topology))); facts.topology = topology; sections.push({ title: "Topology and persona flows", body: JSON.stringify(topology, null, 2) }); stages.add("map"); }
    catch (error) { warnings.push(`Topology: ${String(error)}`); }
  }
  const next = ["preflight", "assess", "map", "rules", "review", "plan", "build", "verify", "harden"].find(stage => !stages.has(stage)) ?? "status";
  const introduction = `${verdict}. Next artifact to inspect: ${next}. Artifact presence is not phase completion or human approval. Saved proof assertions are never trusted; the proof request is re-evaluated against current files.`;
  const markup = sections.map(s => `<section><h2>${html(s.title)}</h2><pre>${html(s.body)}</pre></section>`).join("\n");
  const htmlReport = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width"><title>${html(title)}</title><style>body{font:16px system-ui;max-width:1000px;margin:auto;padding:2rem;background:#1e1e1e;color:#d4d4d4}h1,h2{color:#cc785c}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #666;padding:1rem}</style></head><body><h1>${html(title)}</h1><p>${html(introduction)}</p><h2>Report notes</h2><ul>${warnings.map(w => `<li>${html(w)}</li>`).join("")}</ul>${markup}</body></html>`;
  const markdown = [`# ${md(title)}`, "", md(introduction), "", "## Report notes", ...warnings.map(w => `- ${md(w)}`), ...sections.flatMap(s => ["", `## ${md(s.title)}`, "", ...s.body.split("\n").map(line => md(line))])].join("\n") + "\n";
  return { html: htmlReport, markdown, verdict, next, warnings, facts };
}
