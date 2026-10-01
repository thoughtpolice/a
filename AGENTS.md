# Repository guidance

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

This monorepo uses [Buck2](https://buck2.build) for builds and tests, and
[Jujutsu (jj)](https://jj-vcs.github.io) for version control. Changes can affect
many downstream targets; use the build graph rather than guessing dependencies.

## Required policies

- Run builds and tests through Buck2. Do not invoke Cargo, npm, or other build
  systems directly; use the repository's Buck2 wrappers.
- Use jj for repository changes. Never use Git to write to the repository.
- Create logical, tested commits that build. Use a short conventional commit
  message (`topic: description`) with a lower-case description. When committing,
  run this exact command from the intended workspace:
  ```bash
  jj commit -m 'topic: description' --config=user.name=Claude --config=user.email=noreply@anthropic.com
  ```
- Use an isolated jj workspace when instructed. Keep development workspaces
  under `work/`; consult the `jj` skill's workspace guide before creating or integrating one.
- Do not install packages or modify the system. Dependencies belong in the build
  graph, normally under `buck/third-party/`. If a system change is unavoidable,
  explain why and obtain permission first.
- Treat third-party source as read-only. Inspect it or build it through Buck2;
  obtain permission before running any other commands inside it.
- Include SPDX copyright and license headers in every new file, using the
  language's comment syntax and the applicable license. For repository-owned code:
  ```text
  SPDX-FileCopyrightText: © 2024-<current year> Austin Seipp
  SPDX-License-Identifier: Apache-2.0
  ```
  Preserve existing third-party attribution and licenses. In skill Markdown,
  place SPDX HTML comments after the YAML frontmatter so discovery still works.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Main projects; TypeScript tools live under `src/tools/` |
| `buck/` | Build configuration, toolchains, and third-party dependencies |
| `buck/toolchains/` | Language toolchains |
| `buck/third-party/` | External libraries, crates, and container definitions |
| `.omp/skills/` | OMP-native workflows and package-confined resources; [import inventory](.omp/skills/SOURCES.md) records upstream provenance and exclusions |
| `.omp/tools/` | Native TypeScript tools for Buck2, artifact/report generation, evidence checks, authoring validation, and proof bookkeeping |
| `.claude/` | Claude-specific settings, hooks, and hook tests |
| `work/` | jj development workspaces |
| `cellar/` | Archived material; usually out of scope |

Buck2 packages use `BUILD` files and may use `PACKAGE` files for package settings.
Read nearby targets before adding new ones. Consult [docs/buck2.md](docs/buck2.md)
for build-system details, [Buck2 workflows](.omp/skills/buck2/SKILL.md), and
[jj workflows](.omp/skills/jj/SKILL.md). Read a project's `notes/` directory when relevant.

## Language conventions

### Rust

- Use `depot.rust_binary()`, `depot.rust_library()`, and `depot.rust_test()`.
- Include `third-party//by-name/mi/mimalloc:rust` for allocation.
- Edition 2021 is the default; set `edition = "2024"` when needed.
- Rust targets receive `depot_VERSION`; build mode comes from
  `read_choice("project", "buildmode")` (`debug` or `release`).
- Tests have `insta` snapshot support when needed.

### Deno / TypeScript

- Use `deno.binary()` from `@toolchains//deno:defs.bzl`.
- Declare permissions explicitly and grant only those needed (for example,
  `permissions = ["read", "write", "run", "env"]`).
- Include `deno.jsonc` and `deno.lock` for dependency management.

### C++

- Use `depot.cxx_binary()`, `depot.cxx_library()`, and
  `depot.prebuilt_cxx_library()` for prebuilt libraries.
- Cache upload is enabled by default.

### Third-party dependencies

- Manage Rust crates through reindeer, `Cargo.toml`, and fixups.
- Follow existing `BUILD` patterns for system libraries such as libz, SQLite,
  and zstd.
- Use `depot.oci.pull()` for container images.

## Verification and CI

- Run `buck2 test` for changed code and build definitions. Use the `buck2`
  testing and target-determination guides to cover the changed package and downstream users.
- Fix failures rather than commenting out or removing tests to make a change
  pass. Temporary debugging changes must not remain in the delivered result.
  If a test cannot be fixed, report the blocker and ask for direction.
- Put tests and build logic in the Buck2 graph whenever possible. GitHub Actions
  (`.github/workflows/ci.yml`) should allocate resources, determine affected
  targets, and run Buck2—not implement a separate testing workflow.
- After changing DotSlash launchers (normally under `buck/bin/`), run
  `buck2 test depot//buck/bin:tests`.
- Prefer complete fixes and useful comments. Avoid comments that merely repeat
  the next line of code.
