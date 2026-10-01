// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Authoring checks adapted from Anthropic claude-plugins-official ab024cdc,
// plugins/plugin-dev and plugins/hookify (Apache-2.0); rewritten for OMP.

import type { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { decodeUtf8, readWorkspaceFile, workspacePath } from "../lib/files.ts";
import { result, type Tool, type ToolAPI } from "../lib/tool.ts";

export type Kind = "skill" | "agent" | "rule" | "mcp";
export interface Diagnostic { severity: "error" | "warning"; field: string; message: string }
export interface Validation { valid: boolean; diagnostics: Diagnostic[]; truncated: boolean }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const list = (v: unknown): boolean => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));

export function parseYaml(text: string): unknown {
  const runtime = globalThis as typeof globalThis & { Bun?: { YAML?: { parse(text: string): unknown } } };
  if (!runtime.Bun?.YAML?.parse) throw new Error("omp_validate YAML requires Bun with native Bun.YAML.parse; no substitute parser is used");
  return runtime.Bun.YAML.parse(text);
}

export function frontmatter(text: string, required: boolean): { metadata: unknown; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    if (required) throw new Error("Expected YAML frontmatter at the start of the file");
    return { metadata: {}, body: normalized.trim() };
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("Unterminated YAML frontmatter");
  return { metadata: parseYaml(lines.slice(1, end).join("\n")), body: lines.slice(end + 1).join("\n").trim() };
}

export function validateMetadata(kind: Kind, input: unknown, body = "", limit = 100): Validation {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Diagnostic limit must be between 1 and 500");
  const diagnostics: Diagnostic[] = [];
  let errors = 0;
  let truncated = false;
  const add = (field: string, message: string, severity: Diagnostic["severity"] = "error") => {
    if (severity === "error") errors++;
    if (diagnostics.length < limit) diagnostics.push({ severity, field: field.slice(0, 200), message: message.slice(0, 500) }); else truncated = true;
  };
  if (!record(input)) {
    add("$", "Expected an object mapping");
    return { valid: false, diagnostics, truncated };
  }
  const m: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(input)) {
    const normalized = kind === "mcp" ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (Object.hasOwn(m, normalized)) add(k, "Duplicate normalized metadata key");
    m[normalized] = v;
  }
  const optional = (field: string, check: (v: unknown) => boolean, message: string) => {
    if (m[field] !== undefined && !check(m[field])) add(field, message);
  };
  if (kind !== "mcp") {
    if (!body.trim()) add("body", "An executable instruction body is required");
    if (kind !== "agent") {
      optional("enabled", (v) => typeof v === "boolean", "Expected boolean");
      if (m.enabled === false) add("enabled", "Disabled definition is skipped during discovery", "warning");
    }
  }
  if (kind === "skill" || kind === "agent") {
    if (kind === "agent" || m.name !== undefined) {
      if (!nonempty(m.name)) add("name", "Expected nonempty name");
      else if (kind === "skill" && /[/\\]/.test(m.name)) add("name", "Skill names cannot contain path separators");
      else if (kind === "agent" && ["main", "sub"].includes(m.name.trim().toLowerCase())) add("name", "main and sub are reserved agent names");
    }
    if (!nonempty(m.description)) add("description", "Native discovery requires a nonempty description");
  }
  if (kind === "skill") {
    for (const field of ["hide", "disableModelInvocation", "alwaysApply"]) optional(field, (v) => typeof v === "boolean", "Expected boolean");
    optional("globs", (v) => Array.isArray(v) && v.every((x) => typeof x === "string"), "Expected string array");
    if (m.globs !== undefined || m.alwaysApply !== undefined) add("globs", "Skill globs/alwaysApply are metadata, not invocation triggers", "warning");
  }
  if (kind === "agent") {
    for (const field of ["tools", "spawns", "model"]) optional(field, list, "Expected CSV string or string array");
    optional("autoloadSkills", (v) => Array.isArray(v) && v.every((x) => typeof x === "string"), "Expected skill-name array");
    for (const field of ["blocking", "readSummarize"]) optional(field, (v) => typeof v === "boolean", "Expected boolean");
    for (const field of ["prewalk", "advisor"]) optional(field, (v) => typeof v === "boolean" || nonempty(v), "Expected boolean or model selector");
    for (const field of ["thinkingLevel", "thinking"]) optional(field, nonempty, "Expected thinking-level string; model support is checked by runtime");
  }
  if (kind === "rule") {
    optional("description", (v) => typeof v === "string", "Expected string");
    optional("alwaysApply", (v) => typeof v === "boolean", "Expected boolean");
    for (const field of ["globs", "agents", "condition", "astCondition", "scope"]) optional(field, list, "Expected string or string array");
    optional("question", nonempty, "Expected nonempty yes/no question");
    optional("interruptMode", (v) => typeof v === "string" && ["never", "prose-only", "tool-only", "always"].includes(v), "Unknown interrupt mode");
    if (!m.alwaysApply && !nonempty(m.description) && !m.condition && !m.astCondition && !m.question && !m.ttsr_trigger && !m.ttsrTrigger) add("description", "Rule joins no prompt/addressable bucket without description, alwaysApply or trigger", "warning");
    if (m.condition && m.alwaysApply) add("alwaysApply", "Accepted TTSR triggers take precedence over alwaysApply", "warning");
    if (m.scope !== undefined && list(m.scope)) {
      const scopes = Array.isArray(m.scope) ? m.scope : String(m.scope).split(/,(?![^()]*\))/);
      for (const scope of scopes) if (typeof scope === "string" && !/^(text|thinking|tool|toolcall|tool:[^()\s]+\([^()]+\))$/.test(scope.trim())) add("scope", "Invalid stream scope token");
    }
    for (const legacy of ["event", "pattern", "conditions", "action"]) if (m[legacy] !== undefined) add(legacy, "Hookify event/action fields are not native OMP rule semantics");
  }
  if (kind === "mcp") {
    for (const field of ["disabledServers", "enabledServers"]) optional(field, (v) => Array.isArray(v) && v.every(nonempty), "Expected server-name array");
    optional("$schema", (v) => typeof v === "string", "Expected schema URI string");
    if (!record(m.mcpServers)) add("mcpServers", "Expected server configuration map");
    else for (const [name, server] of Object.entries(m.mcpServers)) {
      const prefix = `mcpServers.${name}`;
      if (!name.trim()) add(prefix, "Server name must not be empty");
      if (!record(server)) { add(prefix, "Expected server object"); continue; }
      const check = (field: string, predicate: (v: unknown) => boolean, message: string) => {
        if (server[field] !== undefined && !predicate(server[field])) add(`${prefix}.${field}`, message);
      };
      const type = server.type === undefined ? (server.url !== undefined && server.command === undefined ? "http" : "stdio") : server.type;
      if (typeof type !== "string" || !["stdio", "http", "sse"].includes(type)) add(`${prefix}.type`, "Unknown transport type");
      if (server.command !== undefined && server.url !== undefined) add(prefix, "command and url cannot coexist");
      if (type === "stdio" && !nonempty(server.command)) add(`${prefix}.command`, "stdio requires a command");
      if ((type === "http" || type === "sse") && !nonempty(server.url)) add(`${prefix}.url`, "Remote transport requires a URL");
      for (const field of ["command", "url", "cwd"]) check(field, nonempty, "Expected nonempty string");
      for (const field of ["enabled", "instructions"]) check(field, (v) => typeof v === "boolean", "Expected boolean");
      check("timeout", (v) => typeof v === "number" && Number.isFinite(v) && v >= 0, "Expected nonnegative finite timeout in milliseconds");
      check("requestIdFormat", (v) => v === "number" || v === "string", "Expected number or string");
      check("args", (v) => Array.isArray(v) && v.every((x) => typeof x === "string"), "Expected string array");
      for (const field of ["env", "headers"]) check(field, (v) => record(v) && Object.values(v).every((x) => typeof x === "string"), "Expected string-valued mapping");
      for (const field of ["auth", "oauth"]) {
        check(field, record, "Expected object");
        const auth = server[field];
        if (!record(auth)) continue;
        for (const [k, v] of Object.entries(auth)) {
          if (field === "oauth" && k === "callbackPort") {
            if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) add(`${prefix}.${field}.${k}`, "Expected TCP port 1–65535");
          } else if (typeof v !== "string") add(`${prefix}.${field}.${k}`, "Expected string");
        }
        if (field === "auth" && auth.type !== undefined && !["oauth", "apikey"].includes(String(auth.type))) add(`${prefix}.auth.type`, "Expected oauth or apikey");
        if (field === "auth" && auth.type === "apikey") add(`${prefix}.auth.type`, "apikey metadata does not inject stored keys; use env/headers", "warning");
      }
    }
  }
  return { valid: errors === 0, diagnostics, truncated };
}

interface Params { kind: Kind; path: string; maxDiagnostics?: number }
export function resourceLinks(body: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      lines.push("");
    } else if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = marker[1]; lines.push("");
    } else lines.push(line);
  }
  const prose = lines.join("\n");
  const runs = [...prose.matchAll(/`+/g)].filter((run) => {
    let escapes = 0;
    for (let i = run.index - 1; i >= 0 && prose[i] === "\\"; i--) escapes++;
    return escapes % 2 === 0;
  });
  const next: number[] = [], byWidth = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = byWidth.get(runs[i][0].length) ?? -1;
    byWidth.set(runs[i][0].length, i);
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    if (next[i] < 0) continue;
    chunks.push(prose.slice(cursor, runs[i].index), "\uFFFC");
    i = next[i]; cursor = runs[i].index + runs[i][0].length;
  }
  chunks.push(prose.slice(cursor));
  const visible = chunks.join("");
  const inline = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  const references = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|[^\s]+)(?:[ \t]+.*)?$/gm;
  return [...visible.matchAll(inline), ...visible.matchAll(references)].map((match) => match[1]);
}
export async function validateFile(cwd: string, params: Params, signal?: AbortSignal): Promise<Validation> {
  signal?.throwIfAborted();
  const limit = params.maxDiagnostics ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Diagnostic limit must be between 1 and 500");
  let file: { path: string; bytes: Buffer };
  try { file = await readWorkspaceFile(cwd, params.path, 1024 * 1024); }
  catch { return { valid: false, diagnostics: [{ severity: "error", field: "path", message: "Cannot read bounded regular file inside selected workspace (symlinks rejected)" }], truncated: false }; }
  let parsed: { metadata: unknown; body: string };
  try {
    const text = decodeUtf8(file.bytes);
    parsed = params.kind === "mcp" ? { metadata: JSON.parse(text), body: "" } : frontmatter(text, params.kind !== "rule");
  } catch (error) {
    const message = error instanceof Error && error.message.includes("requires Bun") ? error.message : "Invalid JSON/YAML or missing/unterminated frontmatter";
    return { valid: false, diagnostics: [{ severity: "error", field: "$", message }], truncated: false };
  }
  const checked = validateMetadata(params.kind, parsed.metadata, parsed.body, limit);
  if (params.kind !== "skill") return checked;
  const root = dirname(file.path);
  const append = (field: string, message: string) => {
    checked.valid = false;
    if (checked.diagnostics.length < limit) checked.diagnostics.push({ severity: "error", field, message }); else checked.truncated = true;
  };
  if (basename(file.path) !== "SKILL.md") append("path", "Native skill entrypoint must be SKILL.md");
  // Resource links only: external and skill:// references are not fetched or executed.
  const links = resourceLinks(parsed.body);
  if (links.length > 1000) append("links", "Resource link count exceeds the 1000-link validation limit");
  const visited = new Set<string>();
  for (const link of links.slice(0, 1000)) {
    signal?.throwIfAborted();
    const raw = link.replace(/^<|>$/g, "");
    if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    let path: string;
    try { path = decodeURIComponent(raw.split(/[?#]/)[0]); }
    catch { append("links", "Malformed encoded resource link"); continue; }
    if (!path || visited.has(path)) continue;
    visited.add(path);
    try {
      const info = await lstat(await workspacePath(root, path));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("Invalid resource");
    }
    catch { append("links", `Missing, escaping, oversized or symlinked resource: ${path.slice(0, 160)}`); }
  }
  if (record(parsed.metadata) && nonempty(parsed.metadata.name) && parsed.metadata.name !== basename(root)) {
    if (checked.diagnostics.length < limit) checked.diagnostics.push({ severity: "warning", field: "name", message: "Skill name differs from package directory; native scanners permit this but portable packages may reject it" }); else checked.truncated = true;
  }
  const location = relative(resolve(cwd), file.path).replaceAll("\\", "/");
  if (location.startsWith(".omp/skills/") && location.split("/").length !== 4) append("path", "Native skills must be directly nested under .omp/skills/<package>/SKILL.md");
  return checked;
}

export default function factory(pi: ToolAPI): Tool<Params> {
  const T = pi.typebox.Type;
  return {
    name: "omp_validate", label: "Validate OMP authoring", approval: "read",
    description: "Read-only native semantic validation for explicit skill, agent, rule or strict-JSON MCP files. Bun native YAML required for frontmatter; does not execute code, resolve secrets, connect servers or write settings. Bounded diagnostics, package resource confinement.",
    parameters: T.Object({ kind: T.Union([T.Literal("skill"), T.Literal("agent"), T.Literal("rule"), T.Literal("mcp")]), path: T.String(), maxDiagnostics: T.Optional(T.Integer({ minimum: 1, maximum: 500 })) }),
    async execute(_id, params, _onUpdate, _ctx, signal) { return result(await validateFile(pi.cwd, params, signal)); },
  };
}
