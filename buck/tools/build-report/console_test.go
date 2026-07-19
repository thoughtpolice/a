// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func consoleFixture(t *testing.T, fixture string, all bool) string {
	t.Helper()
	var builder strings.Builder
	renderConsole(&builder, analyzeFixture(t, fixture), false, all)
	return builder.String()
}

func mustContain(t *testing.T, output string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(output, want) {
			t.Errorf("output missing %q in:\n%s", want, output)
		}
	}
}

func mustNotContain(t *testing.T, output string, rejects ...string) {
	t.Helper()
	for _, reject := range rejects {
		if strings.Contains(output, reject) {
			t.Errorf("output should not contain %q in:\n%s", reject, output)
		}
	}
}

func TestConsoleSuccess(t *testing.T) {
	output := consoleFixture(t, fixtureSuccessBuild, false)
	mustContain(t, output,
		"✓ SUCCESS",
		"b1d22bda-529d-43c",
		"4 total — 4 succeeded (100.0%)",
		"4 default outputs (+1 other)",
		"76 nodes · mean 19 · median 10 · max 52",
		"📦 Cells",
		"depot",
		"📏 Largest dependency graphs",
		"depot//src/tools/omnifix:omnifix",
	)
	mustNotContain(t, output, "❌ Failures", "\x1b[", "truncated")
}

func TestConsoleColors(t *testing.T) {
	var builder strings.Builder
	renderConsole(&builder, analyzeFixture(t, fixtureSuccessBuild), true, false)
	if !strings.Contains(builder.String(), "\x1b[32m") {
		t.Error("expected green escape codes when color is enabled")
	}
}

func TestConsoleActionFailure(t *testing.T) {
	output := consoleFixture(t, fixtureActionFailure, false)
	mustContain(t, output,
		"✗ FAILED",
		"1 failed",
		"❌ Failures — 1 root cause, 1 failed target",
		"[USER] ",
		// The configuration hash is stripped from the headline.
		"Action failed: depot//probe:fails (cfg:<empty>) (genrule)",
		"Local command returned non-zero exit code 1",
		"stderr:",
		"│ error: fake compile failure in probe",
		"affects 1 target:",
		"• depot//probe:fails",
	)
	// cfg:<empty> is the unconfigured marker: noise next to each target.
	mustNotContain(t, output, "#1a608cc1468ec806", "• depot//probe:fails (cfg:<empty>)")
}

func TestConsoleMissingTarget(t *testing.T) {
	output := consoleFixture(t, fixtureMissingTarget, false)
	mustContain(t, output,
		"Unknown target `nonexistent` from package `depot//buck/tools/quicktd`.",
		// The message body past the headline is preserved.
		"Available targets:",
		"MISSING_TARGET",
	)
}

func TestConsoleTestReportOmitsGraph(t *testing.T) {
	output := consoleFixture(t, fixtureTestReport, false)
	mustNotContain(t, output, "📏", "Graph:")
	mustContain(t, output, "⚠ buck2 truncated this report")
}

func TestConsoleSharedCause(t *testing.T) {
	output := consoleFixture(t, fixtureSharedCause, false)
	mustContain(t, output,
		"❌ Failures — 4 root causes, 5 failed targets",
		"1 canceled",
		"affects 3 targets:",
		"(cfg:linux-arm64)",
		"error[E0308]: mismatched types",
		"🧩 Configurations",
		"cfg:linux-x86_64",
		"target failed but the report records no error details",
		"depot//tools/unanalyzable:unanalyzable",
	)
}

func TestConsoleTruncatesLongFailureLists(t *testing.T) {
	report := analyzeFixture(t, fixtureActionFailure)
	failure := &report.Failures[0]
	failure.Targets = nil
	for index := 0; index < 25; index++ {
		failure.Targets = append(failure.Targets, FailedTarget{
			Target: strings.Repeat("x", index%3+1) + "//pkg:target",
		})
	}
	report.Summary.Failed = 25

	var builder strings.Builder
	renderConsole(&builder, report, false, false)
	capped := builder.String()
	mustContain(t, capped, "affects 25 targets:", "... 15 more targets (rerun with --all)")

	builder.Reset()
	renderConsole(&builder, report, false, true)
	full := builder.String()
	mustNotContain(t, full, "more targets (rerun with --all)")
	if got := strings.Count(full, "//pkg:target"); got != 25 {
		t.Errorf("--all should list all 25 targets, found %d", got)
	}
}

func TestConsoleTruncatesLongStreams(t *testing.T) {
	report := analyzeFixture(t, fixtureActionFailure)
	var lines []string
	for index := 0; index < 40; index++ {
		lines = append(lines, "log line")
	}
	lines = append(lines, "final error line")
	report.Failures[0].Action.Stderr = strings.Join(lines, "\n")

	var builder strings.Builder
	renderConsole(&builder, report, false, false)
	output := builder.String()
	// The tail is kept: that is where the actual error lands.
	mustContain(t, output, "final error line", "... 26 earlier lines omitted (rerun with --all)")
}
