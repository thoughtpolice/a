# build-report

Summarize Buck2 `--build-report` JSON output.

## Overview

`build-report` reads the JSON reports written by `buck2 build --build-report`
and `buck2 test --build-report` and renders what happened: outcome counts,
artifact counts, dependency graph statistics, and — most importantly — failure
details grouped by root cause.

The tool understands the modern buck2 report encoding:

- **Interned messages**: error text lives in the report's string table and is
  resolved before display.
- **Per-configuration errors**: action failures are recorded on the configured
  entry, not the top-level target entry, and both levels are inspected.
- **Action errors**: the failing action's category, owning target, captured
  stderr/stdout, and failure reason are surfaced directly.
- **Root cause grouping**: buck2 assigns errors sharing an underlying cause a
  common `cause_index`. One broken library is reported once, with every
  affected target listed under it, instead of once per broken dependent.
- **Blame classification**: buck2's USER/INFRA error category and error tags
  (`ACTION_COMMAND_FAILURE`, `MISSING_TARGET`, ...) are shown per root cause.
- Targets recorded only in the legacy `failures` map (from
  `--build-report-options fill-out-failures`) and the historical plain-string
  error encoding are both still understood.

## Usage

```bash
# Summarize a build
buck2 build --build-report report.json //... ; build-report report.json

# Summarize a test run
buck2 test --build-report report.json //... ; build-report report.json

# Read the report from stdin
buck2 build --build-report=- //... | build-report -

# Markdown for CI artifacts and step summaries
build-report --format markdown --output summary.md report.json

# Structured output for scripting
build-report --format json report.json | jq .summary
```

## Output formats

- **console** (default): sectioned, colorized summary. Failure detail is
  capped to keep CI logs readable; pass `--all` to disable every cap. Colors
  follow the `NO_COLOR` convention and can be disabled with `--no-color`.
- **markdown**: GitHub-flavored report with metadata, distribution tables,
  and complete failure detail including fenced stderr excerpts.
- **json**: the processed report (`format_version` 2.x). This is a stable,
  deterministic schema that the tool also accepts as *input*, so a processed
  report can be stored and re-rendered as console or markdown output later.

## Exit status

- `0` — the report describes a successful build
- `1` — the report describes a failed build
- `2` — the report could not be read, or the usage was invalid

## Building and testing

```bash
buck2 build root//buck/tools/build-report
buck2 test root//buck/tools/build-report:unit
```
