// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
)

func analyzeFixture(t *testing.T, fixture string) *Report {
	t.Helper()
	raw, err := parseRawReport([]byte(fixture))
	if err != nil {
		t.Fatalf("parseRawReport: %v", err)
	}
	return analyze(raw)
}

func TestAnalyzeSuccessBuild(t *testing.T) {
	report := analyzeFixture(t, fixtureSuccessBuild)

	if report.Build.Status != statusSuccess {
		t.Errorf("status = %q", report.Build.Status)
	}
	summary := report.Summary
	if summary.TotalTargets != 4 || summary.Succeeded != 4 || summary.Failed != 0 {
		t.Errorf("summary = %+v", summary)
	}
	if summary.SuccessRatePct != 100 {
		t.Errorf("success rate = %v", summary.SuccessRatePct)
	}
	if summary.DefaultOutputs != 4 || summary.OtherOutputs != 1 {
		t.Errorf("outputs = %d default, %d other", summary.DefaultOutputs, summary.OtherOutputs)
	}
	if summary.Configurations != 1 {
		t.Errorf("configurations = %d", summary.Configurations)
	}
	if len(report.Failures) != 0 {
		t.Errorf("failures = %+v", report.Failures)
	}

	graph := report.Graph
	if graph == nil {
		t.Fatal("expected graph stats")
	}
	// Sizes are 5, 7, 12, 52: total 76, mean 19, even-count median
	// rounds (7+12)/2 up to 10.
	if graph.TotalNodes != 76 || graph.MeanNodes != 19 || graph.MedianNodes != 10 || graph.MaxNodes != 52 {
		t.Errorf("graph = %+v", graph)
	}
	if graph.Largest[0].Target != "depot//src/tools/omnifix:omnifix" {
		t.Errorf("largest = %+v", graph.Largest[0])
	}

	cells := report.Breakdowns.ByCell
	want := []GroupCount{
		{Name: "depot", Targets: 3, Percent: 75},
		{Name: "tilde", Targets: 1, Percent: 25},
	}
	if !reflect.DeepEqual(cells, want) {
		t.Errorf("cells = %+v, want %+v", cells, want)
	}
	// A single configuration carries no signal, so no breakdown.
	if report.Breakdowns.ByConfiguration != nil {
		t.Errorf("configuration breakdown = %+v", report.Breakdowns.ByConfiguration)
	}
}

func TestAnalyzeTestReportHasNoGraph(t *testing.T) {
	report := analyzeFixture(t, fixtureTestReport)
	if report.Graph != nil {
		t.Errorf("test reports carry no graph sizes, got %+v", report.Graph)
	}
	if !report.Build.Truncated {
		t.Error("truncated flag lost")
	}
	if report.Summary.DefaultOutputs != 1 {
		t.Errorf("default outputs = %d", report.Summary.DefaultOutputs)
	}
}

func TestAnalyzeActionFailure(t *testing.T) {
	report := analyzeFixture(t, fixtureActionFailure)

	if report.Build.Status != statusFailed {
		t.Errorf("status = %q", report.Build.Status)
	}
	if report.Summary.Succeeded != 1 || report.Summary.Failed != 1 {
		t.Errorf("summary = %+v", report.Summary)
	}
	if report.Summary.SuccessRatePct != 50 {
		t.Errorf("success rate = %v", report.Summary.SuccessRatePct)
	}
	if len(report.Failures) != 1 {
		t.Fatalf("failures = %+v", report.Failures)
	}
	failure := report.Failures[0]
	if failure.Category != "USER" {
		t.Errorf("category = %q", failure.Category)
	}
	if !strings.HasPrefix(failure.Message, "Action failed: depot//probe:fails") {
		t.Errorf("message = %q", failure.Message)
	}
	if failure.Action == nil || failure.Action.Category != "genrule" {
		t.Errorf("action = %+v", failure.Action)
	}
	wantTargets := []FailedTarget{{Target: "depot//probe:fails", Configuration: "cfg:<empty>#1a608cc1468ec806"}}
	if !reflect.DeepEqual(failure.Targets, wantTargets) {
		t.Errorf("targets = %+v", failure.Targets)
	}
	wantTags := []string{"ACTION_COMMAND_FAILURE", "ANY_ACTION_EXECUTION"}
	if !reflect.DeepEqual(failure.Tags, wantTags) {
		t.Errorf("tags = %+v", failure.Tags)
	}
}

func TestAnalyzeMissingTarget(t *testing.T) {
	report := analyzeFixture(t, fixtureMissingTarget)
	if len(report.Failures) != 1 {
		t.Fatalf("failures = %+v", report.Failures)
	}
	failure := report.Failures[0]
	if failure.Action != nil {
		t.Errorf("missing targets have no action error, got %+v", failure.Action)
	}
	if !strings.Contains(failure.Message, "Unknown target `nonexistent`") {
		t.Errorf("message = %q", failure.Message)
	}
	if !reflect.DeepEqual(failure.Tags, []string{"MISSING_TARGET"}) {
		t.Errorf("tags = %+v", failure.Tags)
	}
	// The unconfigured error carries no configuration.
	if failure.Targets[0].Configuration != "" {
		t.Errorf("configuration = %q", failure.Targets[0].Configuration)
	}
}

func TestAnalyzeSharedCause(t *testing.T) {
	report := analyzeFixture(t, fixtureSharedCause)

	summary := report.Summary
	// 1 success, 4 FAILs in results, 1 fill-out-failures target, 1 CANCELED.
	if summary.TotalTargets != 7 || summary.Succeeded != 1 || summary.Failed != 5 {
		t.Errorf("summary = %+v", summary)
	}
	if !reflect.DeepEqual(summary.OtherOutcomes, map[string]int{"CANCELED": 1}) {
		t.Errorf("other outcomes = %+v", summary.OtherOutcomes)
	}
	if summary.SuccessRatePct != 14.3 {
		t.Errorf("success rate = %v", summary.SuccessRatePct)
	}
	if summary.Configurations != 2 {
		t.Errorf("configurations = %d", summary.Configurations)
	}
	if len(report.Breakdowns.ByConfiguration) != 2 {
		t.Errorf("configuration breakdown = %+v", report.Breakdowns.ByConfiguration)
	}

	if len(report.Failures) != 4 {
		t.Fatalf("expected 4 root causes, got %d: %+v", len(report.Failures), report.Failures)
	}

	// The shared cause affects two targets across two configurations and
	// sorts first; its action detail comes from the error that carried one.
	shared := report.Failures[0]
	wantTargets := []FailedTarget{
		{Target: "depot//bin/uses-broken:uses-broken", Configuration: "cfg:linux-x86_64#1111111111111111"},
		{Target: "depot//lib/broken:broken", Configuration: "cfg:linux-arm64#2222222222222222"},
		{Target: "depot//lib/broken:broken", Configuration: "cfg:linux-x86_64#1111111111111111"},
	}
	if !reflect.DeepEqual(shared.Targets, wantTargets) {
		t.Errorf("shared cause targets = %+v", shared.Targets)
	}
	if shared.Action == nil || shared.Action.Identifier != "emit-link" {
		t.Errorf("shared cause action = %+v", shared.Action)
	}
	if !strings.Contains(shared.Action.Stderr, "error[E0308]") {
		t.Errorf("stderr = %q", shared.Action.Stderr)
	}
	wantTags := []string{"ACTION_COMMAND_FAILURE", "ANY_ACTION_EXECUTION"}
	if !reflect.DeepEqual(shared.Tags, wantTags) {
		t.Errorf("shared cause tags = %+v", shared.Tags)
	}

	var messages []string
	for _, failure := range report.Failures[1:] {
		messages = append(messages, firstLine(failure.Message))
	}
	// Legacy string error, fill-out-failures entry, and the target that
	// failed without any recorded details each get their own line.
	for _, want := range []string{
		"download of https://example.com/dep.tar.gz failed: timeout",
		"Unknown target `unanalyzable` from package `depot//tools`.",
		"target failed but the report records no error details",
	} {
		found := false
		for _, message := range messages {
			if message == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing root cause %q in %q", want, messages)
		}
	}
}

func TestLabelHelpers(t *testing.T) {
	cases := []struct {
		label, cell, pkg string
	}{
		{"depot//buck/tools/quicktd:quicktd", "depot", "depot//buck/tools/quicktd"},
		{"tilde//aseipp/hello:hello", "tilde", "tilde//aseipp/hello"},
		{"depot//pkg:name[sub]", "depot", "depot//pkg"},
		{"weird-label", "unknown", "weird-label"},
	}
	for _, item := range cases {
		if got := cellOf(item.label); got != item.cell {
			t.Errorf("cellOf(%q) = %q, want %q", item.label, got, item.cell)
		}
		if got := packageOf(item.label); got != item.pkg {
			t.Errorf("packageOf(%q) = %q, want %q", item.label, got, item.pkg)
		}
	}
}

func TestGraphStatsMedianOddCount(t *testing.T) {
	graphed := []TargetNodes{
		{Target: "a//x:1", Nodes: 1},
		{Target: "a//x:2", Nodes: 100},
		{Target: "a//x:3", Nodes: 7},
	}
	stats := graphStats(graphed, 108)
	if stats.MedianNodes != 7 {
		t.Errorf("median = %d, want 7", stats.MedianNodes)
	}
	if stats.MeanNodes != 36 {
		t.Errorf("mean = %d, want 36", stats.MeanNodes)
	}
	if graphStats(nil, 0) != nil {
		t.Error("no graphed targets should produce nil stats")
	}
}
