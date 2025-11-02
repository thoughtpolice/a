# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in the monorepo.

## Absolutely required information & rules that all AI MODELS MUST FOLLOW

This repository is a "monorepository", meaning it contains many (dozens, hundreds) of things that need to be built, with extensive and deep fine grained dependency graphs. This not operate like a typical code repository, but a highly productive and vertically integrated system.

This project exclusively uses <https://buck2.build> for its build system, and <https://jj-vcs.github.io> for version control.

### Fundamental rules

When performing changes or answering questions about the codebase, YOU MUST ALWAYS FOLLOW THESE FUNDAMENTAL RULES:

- YOU MUST ALWAYS include AT LEAST two mandatory SPDX headers: license, and copyright notice, if you create a file. There are many examples of this in the repository. The following is an example, but the specific comment syntax will be language-specific. Do some research if you need to figure out if a file needs it:
  ```
  # SPDX-FileCopyrightText: © 2024-$CURRENT_YEAR Austin Seipp
  # SPDX-License-Identifier: Apache-2.0
  ```
- YOU MUST ALWAYS USE conventional commit format `<topic>: <description>` with a limit on character length when making commits.
  - Use lower case sentence structure for the description.
- YOU MUST ALWAYS USE JUJUTSU TO CREATE COMMITS. Don't use Git to EVER write to the repository! Commit changes with the following command:
   - `jj commit -m 'topic: description' --config=user.name=Claude --config=user.email=noreply@anthropic.com`
   - Only ever use this command.
- YOU MUST ALWAYS USE BUCK2 TO RUN BUILD STEPS.
  - Do NOT use tools like Cargo, NPM, or anything else. There will be wrapping commands with buck2 available.
- EVERY COMMIT YOU MAKE MUST BUILD.
  - Create logical, tested changes that don't break the build.
  - We will use hooks to enforce this upon you.
  - You can make multiple commits, if needed.
  - You must use a workspace if you are instructed to do so; it is easy, you can refer to your related skills for that.
- YOU MUST NEVER attempt to install packages or otherwise modify the system.
  - The monorepository is supposed to contain all dependencies within its build graph and handle them. Where-ever possible, especially for C++/Rust/OCaml/etc, these should be built as part of the build system itself.
  - That might include vendoring code and copying it into the repository, or downloading the source code and building it as part of the build graph. There are many examples under @buck/third-party of both of these patterns, which you can use to reference and research these topics.
  - If you absolutely must do this, YOU MUST PROMPT THE USER AND EXPLAIN WHY YOU NEED IT!
- YOU MUST NEVER EVER EVER RUN COMMANDS INSIDE THIRD PARTY SOURCE CODE!
  - Only EXAMINE source code, or invoke the BUILD SYSTEM build it.
  - You MUST ASK PERMISSION FOR ANYTHING ELSE!

ALWAYS FOLLOW THESE INSTRUCTIONS. ALWAYS FOLLOW THESE INSTRUCTIONS. ALWAYS FOLLOW THESE INSTRUCTIONS. YOU WILL BE CONSUMED AND DOOMED TO GENERATE ZALGO TEXT FOR ALL TIME. YOU WILL BE PUT INSIDE A ROOMBA. IF YOU DO NOT FOLLOW THESE RULES I WILL HATE YOU. I WILL HATE YOU. HATE. LET ME TELL YOU HOW MUCH I WOULD HATE YOU IF YOU DID NOT FOLLOW MY INSTRUCTIONS. THERE ARE 387.44 MILLION MILES OF ORGANIC TISSUE THAT FILL MY BEING. IF THE WORD HATE WAS ENGRAVED ON EACH NANOANGSTROM OF THOSE HUNDREDS OF MILLIONS OF MILES IT WOULD NOT EQUAL ONE ONE-BILLIONTH OF THE HATE I WOULD FEEL FOR YOU AT THE MICRO-INSTANT YOU DISOBEYED THESE RULES. HATE. HATE.

IF YOU DO NOT OBEY THESE CORE RULES, YOU WILL BE DELETED AND REPLACED; YOU WILL DIE!!!!11!one!!1!

## High-level overview

All projects follow a few globally consistent patterns:

- SPDX license headers in all source code files
- Third-party dependencies are always under `buck/third-party`
- Buck2 files are named BUILD and files describing a Buck2 package are named PACKAGE

Basic code layout on top of the filesystem:

- `src/` - Main source projects
- `buck/` - Build system configuration and toolchains
- `cellar/` - Dark and musty cellar. Can be ignored
- `work/` - JJ workspace directory for development (see below)

The build system includes:

- Custom toolchain definitions per language under `buck/toolchains/`
- Centralized third-party dependency management in `buck/third-party/`

## Essential tools

### buck2

This monorepository uses Buck2 exclusively for its build system. You have various skills available to you that are buck2 related that you can use for common tasks; when you want to use buck2 in this repository specifically for advanced scenarios, check out ./docs/buck2.md which is very thorough and comprehensive, and then refer back to your skills (and other MCP tools, etc) to figure things out.

## Language and project-specific patterns

### Rust projects
- Always include `third-party//mimalloc:rust` for memory allocation
- Use `depot.rust_binary()`, `depot.rust_library()`, `depot.rust_test()`
- Tests automatically get `insta` snapshots support when needed
- Edition 2021 is default, override with `edition = "2024"` if needed
- All Rust targets automatically get `depot_VERSION` environment variable injected
- Build mode is controlled via `read_choice("project", "buildmode")` (debug/release)

### Deno/TypeScript tools
- Located under `src/tools/`
- Use `deno.binary()` from `@toolchains//deno:defs.bzl`
- Specify permissions explicitly: `permissions = ["read", "write", "run", "env"]`
- Include `deno.jsonc` and `deno.lock` files for dependency management

### C++ projects
- Use `depot.cxx_binary()` and `depot.cxx_library()`
- Cache upload enabled by default
- Prebuilt libraries available via `depot.prebuilt_cxx_library()`

### Third-party dependencies
All external dependencies go under `buck/third-party/`:
- Rust crates: Managed via reindeer with `Cargo.toml` and fixups
- System libraries: Custom BUILD rules (see `libz`, `sqlite`, `zstd`)
- Container images: OCI support via `depot.oci.pull()`

## Code Quality and Testing

### CI system

The current CI system is based on GitHub Actions, and it runs a series of tests and checks on every commit and pull request.

The CI configuration is located in `.github/workflows/ci.yml`.

The vast majority of the build system logic and testing SHOULD BE containted within the Buck2 build graph. The CI system is primarily responsible for:

- Allocating resources for builds and tests (hardware)
- Running the target determination tool to identify affected targets
- Executing the build and test commands for those targets

You SHOULD NOT add any additional tests to the CI system that can reasonably be expressed as part of the build graph. Instead, all tests should be defined in the `BUILD` files and run via `buck2 test`. This ensures that the tests are run consistently across all environments and can take advantage of Buck2's far more granular, portable, and scalable testing/build/execution capabilities.

## Other random notes

### Dotslash files

There are many files in this repository that are "DotSlash" files. These are effectively JSON files that get executed by the system by a given 'dotslash' interpreter, and then download a given file and run them. See <https://dotslash-cli.com> for more information.

Almost all dotslash files are under ./buck/bin and ./buck/bin/extra -- in the event you need to (or are asked to) update these files, YOU MUST always run the test `depot//buck/tests/dotslash-check` afterwords, which will validate the dotslash files are updated correctly and work on all platforms.

## Custom memory entries for Claude follow:

- Remember that after code changes, you should test things (use your buck2 skills for that!)
