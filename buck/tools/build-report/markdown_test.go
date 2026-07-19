// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func markdownFixture(t *testing.T, fixture string) string {
	t.Helper()
	var builder strings.Builder
	renderMarkdown(&builder, analyzeFixture(t, fixture))
	return builder.String()
}

func TestMarkdownSuccess(t *testing.T) {
	output := markdownFixture(t, fixtureSuccessBuild)
	mustContain(t, output,
		"# Buck2 Build Report",
		"| Build ID | `b1d22bda-529d-43c",
		"| Status | ✅ SUCCESS |",
		"| Total targets | **4** |",
		"| Succeeded | 4 (100.0%) |",
		"## Dependency graphs",
		"| Total | 76 |",
		"### Largest",
		"| 1 | `depot//src/tools/omnifix:omnifix` | 52 |",
		"## Cells",
		"█",
	)
	mustNotContain(t, output, "## Failures", "Truncated")
}

func TestMarkdownFailures(t *testing.T) {
	output := markdownFixture(t, fixtureSharedCause)
	mustContain(t, output,
		"| Status | ❌ FAILED |",
		"## Failures",
		"4 root causes affecting 5 targets.",
		"### 1. [USER] Action failed: depot//lib/broken:broken (cfg:linux-x86_64) (rustc emit-link)",
		"*Tags: ACTION_COMMAND_FAILURE, ANY_ACTION_EXECUTION*",
		"Action `rustc emit-link` failed for `depot//lib/broken:broken (cfg:linux-x86_64)`",
		"**stderr:**",
		"error[E0308]: mismatched types",
		"- `depot//lib/broken:broken` (cfg:linux-arm64)",
		"## Configurations",
	)
	// Markdown never truncates: every affected target is listed.
	if got := strings.Count(output, "- `depot//"); got < 5 {
		t.Errorf("expected every affected target listed, found %d bullets", got)
	}
}

func TestMarkdownTruncatedWarning(t *testing.T) {
	output := markdownFixture(t, fixtureTestReport)
	mustContain(t, output, "| Truncated | ⚠ yes — every count below is a lower bound |")
	mustNotContain(t, output, "## Dependency graphs")
}

func TestMarkdownFencesResistBackticks(t *testing.T) {
	var builder strings.Builder
	fencedBlock(&builder, "content with ``` fence inside")
	output := builder.String()
	if !strings.Contains(output, "````text") {
		t.Errorf("fence not lengthened past embedded backticks:\n%s", output)
	}
}
