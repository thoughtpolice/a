---
name: security-review
description: Review changed code across trust boundaries for security defects, or inspect explicitly selected files/content for 25 heuristic security-pattern candidates. Use for injection, HTML sinks, deserialization, TLS, crypto, XML, workflow-input, auth, SSRF, and path handling review; not a guarantee of safety or an automatic hook.
---
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official security-guidance/README.md and hooks/patterns.py at ab024cdc (Apache-2.0). Rewritten for explicit OMP review; no hook, model API, telemetry or session glue. -->

# Explicit security review

1. Establish changed-code scope and read applicable project security rules. Identify external/user-controlled inputs, permission decisions, sensitive operations and data, and the sanitization/validation boundaries between them. Do not upload repository data to an extra endpoint or expose credential values in reports.
2. If useful, invoke read-approved `security_patterns` on **explicit relative file paths** or **explicit content plus a path label**. Read [the catalog and limits](references/catalog.md) before interpreting output. This tool executes no commands, reads no descendants, installs no hooks, and never modifies settings. The helper [patterns.ts](scripts/patterns.ts) is pure and Bun-compatible, with no package dependencies.
3. Treat every result as a candidate location or workflow reminder. Trace input provenance through real callers to the sink; verify runtime/API version and safe forms. Comments may explain safety assumptions but do not prove them. Static lexical matches cannot establish exploitability, and absence of matches cannot establish safety.
4. Review changed trust-boundary logic beyond the catalog: authorization/object ownership checks (IDOR), authentication, SSRF destinations/redirects, path traversal, and accidental credentials. The catalog does **not** implement detectors for those classes. Do not echo secret-bearing source text; cite a location and describe the category instead.
5. Investigate focused changes inline; use native read-only `security-reviewer` when substantial independent investigation justifies delegation. Give scope, input/permission assumptions, source locations, and a requirement to challenge false positives. Use specialized read/find/grep/LSP tools, not recursive surprise scans.
6. Confirm a concrete attacker-controlled path and consequence against current code and guards. If exercising a scenario, stay within authorized local/deterministic boundaries; do not probe external systems. Distinguish a new regression from a pre-existing issue and static reasoning from observed behavior.
7. Read `skill://code-review/references/findings.md` for severity, confidence ≥80, citations and noise filtering. Return confirmed findings separately from unresolved heuristic candidates, plus explicit reviewed scope and verification limitations. No automatic fixes, commits, pushes or PR posting.

This is assistive review, not a replacement for human review, dependency scanning, specialized SAST/DAST or penetration testing. Never report “no candidates” as “no vulnerabilities.”
