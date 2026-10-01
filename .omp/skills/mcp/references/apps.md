<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted and modified from Anthropic claude-plugins-official ab024cdc, mcp-server-dev/build-mcp-app, Apache-2.0. -->

# MCP app UI and security

An apps-capable host brokers a sandboxed iframe to a server UI resource. OMP's
MCP config/client guide is not a promise of this UI surface. Choose and verify a
real target host and its negotiated apps extension; plain text/JSON remains the
server's useful base result. Do not claim a widget implementation based on config.

A tool declares `_meta.ui.resourceUri`; a separate UI resource registration serves
HTML with `text/html;profile=mcp-app`. Use actual ext-apps APIs at the pinned
version. Tool results deliver data, not arbitrary HTML. Visibility metadata can
keep helper tools app-only for a supporting host, but is not authorization.

Inside the iframe install result/input/context handlers **before** connecting the
real App bridge. Keep tools/widgets focused: picker, chart, searchable table,
preview or progress, rather than a whole unrelated application. `ontoolresult`
updates the view; `ontoolinput` supplies inputs; user actions may use sendMessage,
updateModelContext or callServerTool. Validate every brokered payload and every
server request. Host context controls theme, size, safe areas and supported display
modes; handle changes, accessibility, keyboard navigation, loading/empty/error
states, resize and cancellation. Use host-mediated openLink/download APIs instead
of assuming popup/navigation/local-file access. Don't silently grant UI requests.

Use `ontoolinputpartial` for a bounded preparation state and `ontoolcancelled` to
clear it; partial inputs must not authorize server mutations. Read getHostContext
after connect, subscribe with onhostcontextchanged, and request only offered
display modes. Managed autoResize must handle dynamic content without infinite
resize loops. If a widget is blank, inspect its own iframe console for CSP or
import errors; distinguish cached UI resources from a server restart, and verify
a fresh host load before claiming updated UI is visible.

## Boundaries

The iframe cannot access host DOM, cookies or storage. Declare minimal CSP
resource/connect origins and verified host-required sandbox settings; default-deny
network. Bundle required browser code/assets through repository build targets,
not remote CDN imports or regex rewriting minified exports. Inline only necessary
trusted assets. Escape untrusted text, validate URLs, avoid unsafe HTML/script
insertion and never put credentials into a widget payload. Route upstream work
through an authorized server tool, not direct arbitrary widget fetches. Confirm
origin/message channel handling against the actual SDK; sandboxing does not repair
an authorization bug.

For destructive actions require server-enforced authorized consent. A widget
button, model message or helper visibility flag is not proof of user identity.
Check tenant ownership and stale confirmation/version at execution; do not keep
infinite-lived approvals. Tests include injected markup, malicious result URLs,
unauthorized helper calls, cross-tenant IDs, expired consent, cancel and offline.

## Payloads and hosted abuse

Host-specific payload limits are version-sensitive. Measure the selected host,
then cap encoded bytes comfortably below its limit; don't equate characters with
tokens or assume upstream Claude numeric caps apply everywhere. Prefer structured
content when supported. Validate result shape before parsing: a host may replace
large data with an artifact pointer. Bound pages/rows and mark truncation explicitly;
if projecting columns, retain derived-expression source fields too. Heavy geometry
or images can be fetched by a bounded app helper tool instead of flooding model
context. Helper requests still need auth and quota limits.

Public authless endpoints have no reliable per-user identity. Protect compute,
upstream quotas and egress with edge/per-replica limits and hard payload bounds;
return honest 429/Retry-After. Trust forwarded IPs only from the documented proxy
chain, never arbitrary X-Forwarded-For. Shared host proxy IPs are not unique users;
OAuth/identity is required for true user quotas. Cache only normalized, authorized
nonsecret results with tenant-aware keys and bounded TTL/size. Provider IP ranges
and directory submission rules are not portable security assumptions.

## Surface verification

Exercise the real host resource fetch and iframe bridge, not just protocol inspector
output. Observe visible results, safe HTML handling, CSP failures, empty/error
states, theme/resize, helper permissions, oversized/truncated results and cancel.
Use native browser APIs where possible and close the tab afterward. Keep artifacts
in private scratch, redact credentials and report host/version limits. No automatic
screenshots/publication or provider-directory submission.
