// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Uses the modified Apache-2.0 Anthropic security-guidance catalog pinned at ab024cdc.

import { Buffer } from "node:buffer";
import { readWorkspaceFile } from "../lib/files.ts";
import { result, type Tool, type ToolAPI } from "../lib/tool.ts";
import { MAX_CONTENT_BYTES, MAX_FILES, MAX_TOTAL_BYTES, normalizeScanPath, scanSecurityPatterns, type Candidate } from "../skills/security-review/scripts/patterns.ts";

export interface SecurityPatternParams {
  paths?: string[];
  content?: string;
  path?: string;
}
export interface SecurityPatternReport {
  status: "heuristic-candidates-only";
  files: { path: string; bytes: number }[];
  candidates: Candidate[];
  limitations: string[];
}

export default function securityPatterns(pi: ToolAPI): Tool<SecurityPatternParams> {
  const Type = pi.typebox.Type;
  return {
    name: "security_patterns",
    label: "Security pattern candidates",
    description: "Read only explicitly selected workspace files OR scan explicit content with a relative path label. Reports source-free heuristic candidates, not vulnerabilities. No recursion, hooks, network, or shell commands.",
    approval: "read",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: MAX_FILES, uniqueItems: true, description: "Explicit relative workspace files, at most 256 KiB each and 2 MiB total; symlinks rejected." })),
      content: Type.Optional(Type.String({ maxLength: MAX_CONTENT_BYTES, description: "Explicit content, at most 256 KiB UTF-8; mutually exclusive with paths." })),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Relative filename/language label, required with content; no filesystem read." })),
    }, { additionalProperties: false }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const contentMode = params.content !== undefined;
      if (contentMode ? params.paths !== undefined || params.path === undefined : params.paths === undefined || params.path !== undefined) throw new Error("Select exactly one mode: paths, or content with path");
      const files: SecurityPatternReport["files"] = [];
      const candidates: Candidate[] = [];
      if (contentMode) {
        const path = normalizeScanPath(params.path!);
        candidates.push(...scanSecurityPatterns(path, params.content!));
        files.push({ path, bytes: Buffer.byteLength(params.content!, "utf8") });
      } else {
        const paths = params.paths!;
        if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FILES) throw new Error(`Select 1–${MAX_FILES} files`);
        const selected = paths.map(normalizeScanPath);
        if (new Set(selected).size !== selected.length) throw new Error("Duplicate file paths are not accepted");
        let total = 0;
        for (const path of selected) {
          signal?.throwIfAborted();
          const input = await readWorkspaceFile(pi.cwd, path, MAX_CONTENT_BYTES);
          total += input.bytes.length;
          if (total > MAX_TOTAL_BYTES) throw new Error(`Selected files exceed ${MAX_TOTAL_BYTES} bytes in total`);
          // Reject invalid UTF-8 instead of silently scanning altered/binary input.
          const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.bytes);
          if (content.includes("\0")) throw new Error("Binary file input is not accepted");
          candidates.push(...scanSecurityPatterns(path, content));
          files.push({ path, bytes: input.bytes.length });
        }
      }
      signal?.throwIfAborted();
      return result({
        status: "heuristic-candidates-only", files, candidates,
        limitations: [
          "First location per matching rule per file only; workflow rule 1 is a path reminder, not an injection finding.",
          "Case-sensitive lexical matching; no parser, alias resolution, data-flow analysis, comment/string exclusion, sanitizer or reachability proof.",
          "Same-line guards: YAML Safe within 80 characters; torch weights_only=True and NumPy allow_pickle=True within 200 characters. Multiline safe calls may be flagged or missed.",
          "Script-tag bounds: integrity lookahead 400 characters; before src 200, URL 300, after URL 100. Integrity presence is not integrity validation.",
          "No candidates does not establish safety; output intentionally omits source snippets and secret values.",
        ],
      } satisfies SecurityPatternReport);
    },
  };
}
