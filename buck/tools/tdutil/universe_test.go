// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func singleCellMap(t *testing.T, workspace string) cellMap {
	t.Helper()
	audit, err := json.Marshal(map[string]string{"root": workspace})
	if err != nil {
		t.Fatal(err)
	}
	cells, err := parseCellMap(workspace, audit)
	if err != nil {
		t.Fatal(err)
	}
	return cells
}

func aliasedCellMap(t *testing.T, workspace string) cellMap {
	t.Helper()
	audit, err := json.Marshal(map[string]string{
		"root":     workspace,
		"alias":    workspace,
		"nested":   filepath.Join(workspace, "src", "nested"),
		"external": filepath.Join(filepath.Dir(workspace), "external"),
	})
	if err != nil {
		t.Fatal(err)
	}
	cells, err := parseCellMap(workspace, audit)
	if err != nil {
		t.Fatal(err)
	}
	return cells
}

func exactUniversePlan(raw string) universePlan {
	return universePlan{
		basePatterns: []string{raw},
		headPatterns: []string{raw},
		patterns: []plannedPattern{{
			raw:  raw,
			kind: classifyPattern(raw),
			base: true,
			head: true,
		}},
	}
}

func TestClassifiesSupportedUniversePatterns(t *testing.T) {
	tests := []struct {
		pattern string
		want    universePattern
	}{
		{"root//src/...", universePattern{kind: universeRecursive, packageName: "root//src"}},
		{"root//...", universePattern{kind: universeRecursive, packageName: "root//"}},
		{"root//src/app:", universePattern{kind: universePackage, packageName: "root//src/app"}},
		{"root//src/app:bin", universePattern{kind: universeExact, packageName: "root//src/app", name: "bin"}},
		{"root//src/app", universePattern{kind: universeExact, packageName: "root//src/app", name: "app"}},
		{"//src/app:bin", universePattern{kind: universeOther}},
		{"root//src/app:bin*", universePattern{kind: universeOther}},
	}
	for _, test := range tests {
		if got := classifyPattern(test.pattern); got != test.want {
			t.Errorf("classifyPattern(%q) = %#v, want %#v", test.pattern, got, test.want)
		}
	}
}

func TestPairedPlanOmitsOnlyAnAbsentEndpoint(t *testing.T) {
	fixture := t.TempDir()
	base := filepath.Join(fixture, "base")
	head := filepath.Join(fixture, "head")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(head, "new", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}

	plan, err := planUniverse(base, singleCellMap(t, base), head, singleCellMap(t, head), []string{"root//new/pkg/..."})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.basePatterns) != 0 {
		t.Fatalf("base patterns = %#v", plan.basePatterns)
	}
	if !slices.Equal(plan.headPatterns, []string{"root//new/pkg/..."}) {
		t.Fatalf("head patterns = %#v", plan.headPatterns)
	}

	_, err = planUniverse(base, singleCellMap(t, base), head, singleCellMap(t, head), []string{"root//missing/..."})
	if err == nil || !strings.Contains(err.Error(), "neither endpoint") {
		t.Fatalf("missing pattern error = %v", err)
	}
}

func TestPairedPlanHandlesCellsIntroducedAtOneEndpoint(t *testing.T) {
	fixture := t.TempDir()
	base := filepath.Join(fixture, "base")
	head := filepath.Join(fixture, "head")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(head, "new", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	headAudit, err := json.Marshal(map[string]string{"root": head, "new": head})
	if err != nil {
		t.Fatal(err)
	}
	headCells, err := parseCellMap(head, headAudit)
	if err != nil {
		t.Fatal(err)
	}

	plan, err := planUniverse(base, singleCellMap(t, base), head, headCells, []string{"new//new/pkg/..."})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.basePatterns) != 0 {
		t.Fatalf("base patterns = %#v", plan.basePatterns)
	}
	if !slices.Equal(plan.headPatterns, []string{"new//new/pkg/..."}) {
		t.Fatalf("head patterns = %#v", plan.headPatterns)
	}
}

func TestAnchorStateDistinguishesAbsenceFromFilesystemFailures(t *testing.T) {
	workspace := t.TempDir()
	cells := singleCellMap(t, workspace)
	if err := os.WriteFile(filepath.Join(workspace, "file"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	state, err := inspectAnchor(workspace, cells, "root//missing")
	if err != nil || state != anchorAbsent {
		t.Fatalf("missing anchor = %v, %v", state, err)
	}
	state, err = inspectAnchor(workspace, cells, "root//file/child")
	if err != nil || state != anchorAbsent {
		t.Fatalf("child of file anchor = %v, %v", state, err)
	}
	_, err = inspectAnchor(workspace, cells, "root//file")
	if err == nil || !strings.Contains(err.Error(), "is not a directory") || !strings.Contains(err.Error(), "root//file") {
		t.Fatalf("file anchor error = %v", err)
	}
}

func TestAnchorStatePropagatesMetadataErrorsWithContext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink loop semantics differ on Windows")
	}
	workspace := t.TempDir()
	cells := singleCellMap(t, workspace)
	if err := os.Symlink("loop", filepath.Join(workspace, "loop")); err != nil {
		t.Fatal(err)
	}

	_, err := inspectAnchor(workspace, cells, "root//loop")
	if err == nil ||
		!strings.Contains(err.Error(), "failed to inspect universe package anchor") ||
		!strings.Contains(err.Error(), "root//loop") ||
		!strings.Contains(err.Error(), workspace) {
		t.Fatalf("symlink-loop anchor error = %v", err)
	}
}

func TestExactValidationUsesRepoPathsAcrossCellAliases(t *testing.T) {
	workspace := t.TempDir()
	cells := aliasedCellMap(t, workspace)
	base, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	head := emptySnapshot(cells)
	plan := exactUniversePlan("alias//src/app:app")
	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}

	missing := plan
	missing.patterns = []plannedPattern{{
		raw:  "alias//src/app:typo",
		kind: classifyPattern("alias//src/app:typo"),
		base: true,
		head: true,
	}}
	if err := validateUniverse(&missing, &base, &head); err == nil {
		t.Fatal("missing target validated")
	}
}
