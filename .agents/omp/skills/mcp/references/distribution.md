<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted and modified from Anthropic claude-plugins-official ab024cdc, mcp-server-dev/build-mcpb and build-mcp-server, Apache-2.0. -->

# Portable deployment and requested bundles

## Remote service

For SaaS APIs prefer a reviewed Streamable HTTP deployment when hosting is already
available. Choose stateless versus session-backed transport deliberately and keep
per-user authorization independent of process/session affinity. Reuse the repo's
available SDK, HTTP framework and Buck2/runtime entrypoints. Edge workers and
containers have different stream, lifespan, filesystem and dependency constraints;
check the real pinned platform contract. No automatic provisioning, tunnel,
package manager, deployment or publish commands. Obtain actual required deploy
permissions, TLS endpoint, secret store and runtime before implementing.

Prove initialize/list/call through the deployed endpoint with a real client;
exercise auth failure, wrong audience, isolation, unsupported methods, cancellation,
proxy/origin policy and timeout. A health check alone is not MCP proof. Report
endpoint/transport/runtime/version and observed behavior without disclosing tokens.

## Local stdio and bundle choice

Local servers are justified by explicit local process/filesystem/desktop/OS access,
not merely by an upstream cloud API. Stdout is protocol-only. Pin the runtime and
all transitive dependencies, native modules and target architecture. Use the
existing Buck2 artifact/build conventions and a documented launch contract;
no package/system installs. Local tools run with the invoking user's privileges,
so enforcement belongs in server handlers. MCPB is an external consumer format,
not an OMP-native install/runtime, and not every bundle automatically ships a runtime.

For explicitly requested packaging, choose the actual consumer before creating an
archive. A portable server distribution can contain reviewed launch artifacts,
manifest, licenses/notices and usage instructions. Archive only allowlisted regular
files: reject absolute/traversal paths, symlink/hardlink entries, extraction escape,
excess entry count/expanded bytes and self-inclusion. Put output outside input and
refuse overwrites unless requested. Do not include credentials, caches, tests or
development node_modules accidentally. Preserve third-party notices and check
runtime redistribution licenses. No fake `.skill`/MCPB compatibility helper.

## MCPB consumer contract (on request)

MCPB is a ZIP with `manifest.json`, actual server/dependencies and optional assets.
Select and validate against the target manifest schema (upstream reference uses
v0.4 with additionalProperties false); don't claim that schema is current forever.
Identity includes manifest_version/name/version/description/author/server.
`server.type` is node/python/binary in that external schema; this port uses TS/Bun
or a real compatible binary, never a Python implementation. `entry_point` describes
the actual launch file; `server.mcp_config.command/args/env` drives spawning.
Bundle-relative `${__dirname}` and `${user_config.KEY}` substitutions belong to
that consumer, not OMP env resolution. No automatic prefixed env names.

`user_config` defines actual type/title/description/default/required bounds and
`sensitive: true` storage where the consumer implements it. File/directory pickers
improve input UX but do not authorize arbitrary paths. `compatibility` declares
real host/platform/runtime requirements; icon/screenshots/localization/privacy
metadata must correspond to actual files/policy. Generated tools/prompts listings
are display metadata, not enforcement. Validate, package/sign only with available,
authorized build tooling and real keys; never install a packer or invent a signature.

## Local security and clean-target proof

Check client roots support; accept only approved decoded file URIs, otherwise
require an explicit configured root. Normalize lexical paths **and** enforce
filesystem/symlink confinement at open, not a `startsWith` prefix or path.join alone.
Reject ancestor symlinks or use safe descriptor-based traversal. Prevent race-based
escapes where the filesystem is adversarial. Cap file bytes before allocation,
listing entries, search work, command duration and result size. Never silently
truncate security-significant input. Spawn allowlisted programs with validated
argv and no input-derived shell command; handle option injection explicitly.

Separate reads/writes/delete with honest annotations and real user authorization;
read tools still expose secrets and are not automatically safe. Redact output,
logs and transcripts. Don't assume MCPB has a sandbox or permissions block.

Test the distribution on the supported clean target without the dev toolchain:
runtime/dependencies/assets present, stdio handshake and real normal/error calls,
path traversal, symlink escape, argument injection, too-large file, denied write,
secrets redaction and shutdown. For app bundles also verify the actual host widget
surface. Report exact consumer/version/platform and limits; OMP connecting to a
manually launched server does not prove MCPB installation support.
