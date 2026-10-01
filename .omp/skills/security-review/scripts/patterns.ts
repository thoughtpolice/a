// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified port of Anthropic claude-plugins-official security-guidance/hooks/patterns.py
// at ab024cdc (Apache-2.0): all 25 frozen IDs and matching guards retained;
// messages rewritten as candidates, bounded input, source-free first locations added.

import { Buffer } from "node:buffer";

export const MAX_CONTENT_BYTES = 256 * 1024;
export const MAX_FILES = 32;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

interface Rule {
  readonly id: number;
  readonly name: string;
  readonly message: string;
  readonly gate?: (path: string) => boolean;
  readonly pathMatch?: (path: string) => boolean;
  readonly substrings?: readonly string[];
  readonly regex?: RegExp;
  readonly firstIndex?: (content: string) => number;
}
const js = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
];
const py = [".py", ".pyi", ".ipynb"];
const docs = [".md", ".mdx", ".txt", ".rst", ".json", ".yaml", ".yml"];
const isJS = (path: string): boolean => js.some((ext) => path.endsWith(ext));
const isPy = (path: string): boolean => py.some((ext) => path.endsWith(ext));
const deserialize =
  "Candidate unsafe deserialization: establish input trust; prefer schema-validated data rather than executable object loading.";
const yaml =
  "Candidate unsafe YAML loader: verify loader semantics; use safe_load plus schema validation for simple data.";

// Equivalent to the upstream call + same-line greedy wildcard + shell=True
// regex, without quadratic rescanning of a long line with many call prefixes.
function subprocessShellIndex(content: string): number {
  const calls = /subprocess\.(?:run|call|Popen|check_output|check_call)\(/g;
  const shells = /shell\s*=\s*True/g;
  let shell = shells.exec(content);
  let call: RegExpExecArray | null;
  while (shell && (call = calls.exec(content))) {
    while (shell && shell.index < calls.lastIndex) shell = shells.exec(content);
    if (!shell) break;
    const newline = content.indexOf("\n", calls.lastIndex);
    if (newline < 0 || shell.index < newline) return call.index;
    calls.lastIndex = newline + 1;
  }
  return -1;
}

// Ungated upstream rules deliberately remain ungated; callers must verify language,
// parser version, reachability and input trust before treating a candidate as a defect.
export const SECURITY_PATTERNS: readonly Rule[] = [
  {
    id: 1,
    name: "github_actions_workflow",
    pathMatch: (p) =>
      p.includes(".github/workflows/") &&
      (p.endsWith(".yml") || p.endsWith(".yaml")),
    message:
      "Workflow review reminder, not an injection match: inspect untrusted event expressions in run commands and checkout refs; use quoted environment variables and validated refs.",
  },
  {
    id: 2,
    name: "child_process_exec",
    gate: isJS,
    substrings: ["child_process.exec", "execSync("],
    regex: /(?<![a-zA-Z0-9_.])exec\(/,
    message:
      "Candidate shell execution: trace command inputs; prefer execFile/spawn with argument arrays without a shell.",
  },
  {
    id: 3,
    name: "new_function_injection",
    gate: isJS,
    substrings: ["new Function"],
    message:
      "Candidate dynamic code construction: do not interpolate untrusted strings; consider property access or a safe expression parser.",
  },
  {
    id: 4,
    name: "eval_injection",
    gate: (p) => !docs.some((ext) => p.endsWith(ext)),
    regex: /(?<![a-zA-Z0-9_.])eval\(/,
    message:
      "Candidate dynamic evaluation: establish input trust; prefer a data or safe expression parser.",
  },
  {
    id: 5,
    name: "react_dangerously_set_html",
    gate: isJS,
    substrings: ["dangerouslySetInnerHTML"],
    message:
      "Candidate React HTML sink: trace content and verify an appropriate HTML sanitizer.",
  },
  {
    id: 6,
    name: "document_write_xss",
    gate: isJS,
    substrings: ["document.write"],
    message:
      "Candidate document.write sink: inspect input trust; prefer safe DOM construction.",
  },
  {
    id: 7,
    name: "innerHTML_xss",
    gate: isJS,
    substrings: [".innerHTML =", ".innerHTML="],
    message:
      "Candidate innerHTML assignment: prefer textContent for text or sanitize HTML.",
  },
  {
    id: 8,
    name: "pickle_deserialization",
    gate: isPy,
    regex:
      /(?<![a-zA-Z0-9_])pickle\.(loads?|Unpickler)\b|(?<![a-zA-Z0-9_])pkl_load\(/,
    message: deserialize,
  },
  {
    id: 9,
    name: "os_system_injection",
    gate: isPy,
    regex: /\bos\.system\s*\(/,
    substrings: ["from os import system"],
    message:
      "Candidate shell invocation: trace inputs; prefer subprocess argument arrays without a shell.",
  },
  {
    id: 10,
    name: "python_subprocess_shell",
    firstIndex: subprocessShellIndex,
    message:
      "Candidate subprocess shell=True: trace command inputs; prefer an argument list without a shell.",
  },
  {
    id: 11,
    name: "go_exec_shell_injection",
    regex: /exec\.Command\(\s*"(?:sh|bash|\/bin\/sh|\/bin\/bash)"/,
    message:
      "Candidate Go shell interpreter invocation: trace command inputs; prefer direct program arguments and validate input semantics.",
  },
  {
    id: 12,
    name: "unsafe_yaml_load",
    regex: /\byaml\.load\s*\((?![^)\n]{0,80}\bSafe)/,
    message: yaml,
  },
  {
    id: 13,
    name: "node_createcipher_no_iv",
    regex: /\bcrypto\.(createCipher|createDecipher)\b/,
    message:
      "Candidate obsolete cipher API: use createCipheriv/createDecipheriv with correctly managed keys and IVs.",
  },
  {
    id: 14,
    name: "aes_ecb_mode",
    regex: /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|["']aes-\d+-ecb["']/,
    message:
      "Candidate ECB mode: verify use; prefer authenticated encryption such as AES-GCM.",
  },
  {
    id: 15,
    name: "tls_verification_disabled",
    regex:
      /\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|ssl\._create_unverified_context|check_hostname\s*=\s*False/,
    message:
      "Candidate disabled TLS verification: verify deployment context; configure trusted CAs rather than disabling peer verification.",
  },
  {
    id: 16,
    name: "marshal_loads",
    regex: /\bmarshal\.loads?\s*\(/,
    message: deserialize,
  },
  {
    id: 17,
    name: "shelve_open",
    regex: /\bshelve\.open\s*\(/,
    message: deserialize,
  },
  {
    id: 18,
    name: "xml_unsafe_parse",
    regex:
      /\b(xml\.etree\.ElementTree|ElementTree|ET)\.(parse|fromstring|XML)\s*\(|\bminidom\.(parse|parseString)\s*\(|\bxml\.sax\.(parse|make_parser)\b/,
    message:
      "Candidate XML parser: verify parser/version, entity handling and resource limits for untrusted XML; consider defusedxml.",
  },
  {
    id: 19,
    name: "pickle_variants_load",
    regex: /\b(cPickle|cloudpickle|dill)\.(load|loads)\s*\(/,
    message: deserialize,
  },
  {
    id: 20,
    name: "outerHTML_xss",
    gate: isJS,
    substrings: [".outerHTML =", ".outerHTML="],
    message:
      "Candidate outerHTML assignment: prefer safe DOM construction or sanitized HTML.",
  },
  {
    id: 21,
    name: "insertAdjacentHTML_xss",
    gate: isJS,
    substrings: [".insertAdjacentHTML("],
    message:
      "Candidate insertAdjacentHTML sink: use insertAdjacentText for text or sanitize HTML.",
  },
  {
    id: 22,
    name: "script_src_without_sri",
    regex:
      /<script\s+(?![^>]{0,400}integrity\s*=)[^>]{0,200}src\s*=\s*["'](?:https?:)?\/\/[^"']{1,300}["'][^>]{0,100}>/,
    message:
      "Candidate external script without an integrity attribute: verify trusted delivery; consider SRI with crossorigin for immutable assets.",
  },
  {
    id: 23,
    name: "torch_unsafe_load",
    regex:
      /(?:\btorch\.load|\.torch_load)\s*\((?![^)\n]{0,200}weights_only\s*=\s*True)/,
    message:
      "Candidate torch object loading: verify runtime defaults and input trust; weights_only=True restricts object loading where supported.",
  },
  {
    id: 24,
    name: "yaml_unsafe_load_variants",
    regex: /(?:\byaml\.unsafe_load|\.yaml_unsafe_load)\s*\(/,
    message: yaml,
  },
  {
    id: 25,
    name: "pickle_wrapper_load",
    regex:
      /\bjoblib\.load\s*\(|\b(?:pd|pandas)\.read_pickle\s*\(|\.cloudpickle_load\s*\(|\b(?:np|numpy)\.load\s*\([^)\n]{0,200}allow_pickle\s*=\s*True/,
    message: deserialize,
  },
];

export interface Candidate {
  ruleId: number;
  ruleName: string;
  kind: "candidate" | "path-reminder";
  path: string;
  line: number | null;
  column: number | null;
  message: string;
}

// Explicit-content labels obey the same relative-path policy as file selections.
// This is lexical validation only: scanning content does not access the filesystem.
export function normalizeScanPath(input: string): string {
  if (
    typeof input !== "string" || !input || input.length > 4096 ||
    /\p{Cc}/u.test(input)
  ) {
    throw new Error(
      "Expected a bounded relative path without control characters",
    );
  }
  const path = input.replaceAll("\\", "/");
  if (
    path.startsWith("/") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  ) throw new Error("Expected a relative path within the workspace");
  const parts = path.split("/").filter((part) => part !== ".");
  if (!parts.length) throw new Error("Expected a file path");
  return parts.join("/");
}

export function scanSecurityPatterns(
  inputPath: string,
  content: string,
): Candidate[] {
  const path = normalizeScanPath(inputPath);
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES
  ) {
    throw new Error(
      `Content must be a string of at most ${MAX_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
  const candidates: Candidate[] = [];
  for (const rule of SECURITY_PATTERNS) {
    if (rule.gate && !rule.gate(path)) continue;
    if (rule.pathMatch?.(path)) {
      candidates.push({
        ruleId: rule.id,
        ruleName: rule.name,
        kind: "path-reminder",
        path,
        line: null,
        column: null,
        message: rule.message,
      });
      continue;
    }
    let index = -1;
    for (const substring of rule.substrings ?? []) {
      const found = content.indexOf(substring);
      if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    const matched = rule.regex?.exec(content);
    if (matched && (index < 0 || matched.index < index)) index = matched.index;
    const customIndex = rule.firstIndex?.(content) ?? -1;
    if (customIndex >= 0 && (index < 0 || customIndex < index)) {
      index = customIndex;
    }
    if (index < 0) continue;
    let line = 1;
    let lastNewline = -1;
    for (let cursor = 0; cursor < index; cursor++) {
      if (content.charCodeAt(cursor) === 10) {
        line++;
        lastNewline = cursor;
      }
    }
    candidates.push({
      ruleId: rule.id,
      ruleName: rule.name,
      kind: "candidate",
      path,
      line,
      column: index - lastNewline,
      message: rule.message,
    });
  }
  return candidates;
}
