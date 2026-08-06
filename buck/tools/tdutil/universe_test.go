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

func TestMissingPackageExceptionRequiresPeerProofAndKeepsOtherErrors(t *testing.T) {
	workspace := t.TempDir()
	cells := aliasedCellMap(t, workspace)
	base, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	head := emptySnapshot(cells)
	head.errors["root//src/app"] = []string{
		"package `root//src/app:` does not exist\n    missing `BUILD` file (also missing alternatives `BUCK`)",
	}
	plan := exactUniversePlan("root//src/app:app")

	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
	if len(head.errors) != 0 {
		t.Fatalf("expected diagnostic remained: %#v", head.errors)
	}

	head.errors["root//src/app"] = []string{
		"package `root//src/app:` does not exist\n    missing `BUILD` file",
		"syntax failure",
	}
	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(head.errors["root//src/app"], []string{"syntax failure"}) {
		t.Fatalf("retained errors = %#v", head.errors)
	}
}

func TestMissingPackageExceptionIsSymmetricForAnAddedPackage(t *testing.T) {
	cells := testCellMap(t)
	base := emptySnapshot(cells)
	base.errors["root//src/app"] = []string{
		"package `root//src/app:` does not exist\n    missing `BUILD` file (also missing alternatives `BUCK`)",
	}
	head, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	plan := exactUniversePlan("root//src/app:app")

	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
	if len(base.errors) != 0 {
		t.Fatalf("expected diagnostic remained: %#v", base.errors)
	}
}

func TestEndpointTargetDiagnosticRequiresExactPatternAndPeerProof(t *testing.T) {
	cells := testCellMap(t)
	base := emptySnapshot(cells)
	base.errors["root//src/app"] = []string{"Unknown target `new` from package `root//src/app`."}
	head, err := parseTargetsJSONLines([]byte(targetJSON("new")), cells)
	if err != nil {
		t.Fatal(err)
	}
	plan := exactUniversePlan("root//src/app:new")

	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
	if len(base.errors) != 0 {
		t.Fatalf("expected diagnostic remained: %#v", base.errors)
	}

	base.errors["root//src/app"] = []string{"Unknown target `other` from package `root//src/app`."}
	err = validateUniverse(&plan, &base, &head)
	if err == nil || !strings.Contains(err.Error(), "more errors at base than head") {
		t.Fatalf("unproved target diagnostic error = %v", err)
	}
}

func TestEndpointTargetDiagnosticHandlesRemovalAndCannotHideOtherErrors(t *testing.T) {
	cells := testCellMap(t)
	base, err := parseTargetsJSONLines([]byte(targetJSON("gone")), cells)
	if err != nil {
		t.Fatal(err)
	}
	head := emptySnapshot(cells)
	head.errors["root//src/app"] = []string{"Unknown target `gone` from package `root//src/app`."}
	plan := exactUniversePlan("root//src/app:gone")

	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
	if len(head.errors) != 0 {
		t.Fatalf("expected diagnostic remained: %#v", head.errors)
	}

	head.errors["root//src/app"] = []string{
		"Unknown target `gone` from package `root//src/app`.",
		"syntax failure",
	}
	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(head.errors["root//src/app"], []string{"syntax failure"}) {
		t.Fatalf("retained errors = %#v", head.errors)
	}
}

// Collection refuses a regressed predecessor before determine() ever sees it,
// so select-all has to reach here too — otherwise the run would die with the
// head graph collected and unused, and the policy would be inert.
func TestSelectAllDefersTheBaseOnlyRejectionToDetermine(t *testing.T) {
	cells := testCellMap(t)
	base, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	head, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	base.errors["root//src/app"] = []string{"base failure"}

	plan := exactUniversePlan("root//src/app:app")
	if err := validateUniverse(&plan, &base, &head); err == nil {
		t.Fatal("the default policy stopped rejecting a base-only error")
	}

	permissive := exactUniversePlan("root//src/app:app")
	permissive.onGraphError = graphErrorSelectAll
	if err := validateUniverse(&permissive, &base, &head); err != nil {
		t.Fatalf("select-all was rejected during collection: %v", err)
	}
	affected, err := determine(&base, &head, nil, determineOptions{onGraphError: graphErrorSelectAll})
	if err != nil {
		t.Fatalf("determine failed after collection allowed it through: %v", err)
	}
	if len(affected) != len(head.targets) {
		t.Fatalf("affected = %d targets, want the whole head graph (%d)", len(affected), len(head.targets))
	}
}

func TestBaseOnlyGraphErrorsFailClosedButSharedErrorsDoNot(t *testing.T) {
	cells := testCellMap(t)
	base, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	head, err := parseTargetsJSONLines([]byte(targetJSON("app")), cells)
	if err != nil {
		t.Fatal(err)
	}
	plan := exactUniversePlan("root//src/app:app")

	base.errors["root//src/app"] = []string{"base failure"}
	err = validateUniverse(&plan, &base, &head)
	if err == nil || !strings.Contains(err.Error(), "more errors at base than head") || !strings.Contains(err.Error(), "base failure") {
		t.Fatalf("base-only error = %v", err)
	}

	head.errors["root//src/app"] = []string{"head failure"}
	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}

	base.errors["root//src/app"] = append(base.errors["root//src/app"], "extra base failure")
	err = validateUniverse(&plan, &base, &head)
	if err == nil || !strings.Contains(err.Error(), "2 versus 1") || !strings.Contains(err.Error(), "extra base failure") {
		t.Fatalf("additional base error = %v", err)
	}

	head.errors["root//src/app"] = append(head.errors["root//src/app"], "different extra head wording")
	if err := validateUniverse(&plan, &base, &head); err != nil {
		t.Fatal(err)
	}
}

func TestBaseErrorCountsAreComparedByRepoPackageAcrossAliases(t *testing.T) {
	workspace := t.TempDir()
	baseAudit, err := json.Marshal(map[string]string{"root": workspace})
	if err != nil {
		t.Fatal(err)
	}
	headAudit, err := json.Marshal(map[string]string{"depot": workspace})
	if err != nil {
		t.Fatal(err)
	}
	baseCells, err := parseCellMap(workspace, baseAudit)
	if err != nil {
		t.Fatal(err)
	}
	headCells, err := parseCellMap(workspace, headAudit)
	if err != nil {
		t.Fatal(err)
	}
	base := emptySnapshot(baseCells)
	base.errors["root//pkg"] = []string{"old", "extra"}
	head := emptySnapshot(headCells)
	head.errors["depot//pkg"] = []string{"new wording"}

	err = rejectBaseOnlyGraphErrors(&base, &head)
	if err == nil || !strings.Contains(err.Error(), "2 versus 1") {
		t.Fatalf("alias-normalized error = %v", err)
	}

	head.errors["depot//pkg"] = append(head.errors["depot//pkg"], "another new wording")
	if err := rejectBaseOnlyGraphErrors(&base, &head); err != nil {
		t.Fatal(err)
	}
}

func TestMissingBuildFileMatcherRequiresTheCompleteBuckGrammar(t *testing.T) {
	packageName := "root//src/app"
	for _, diagnostic := range []string{
		"package `root//src/app:` does not exist\n    missing `BUILD` file",
		"package `root//src/app:` does not exist\n    missing `BUILD` file (also missing alternatives `BUILD.v2`, `BUCK.v2`, `BUCK`)",
	} {
		if !isMissingPackageError(packageName, diagnostic) {
			t.Errorf("expected %q to match", diagnostic)
		}
	}

	for _, diagnostic := range []string{
		"package `root//src/app:` does not exist\n    missing `BUILD` file; syntax failure",
		"package `root//src/app:` does not exist\n    missing `BUILD` file (also missing alternatives )",
		"package `root//src/app:` does not exist\n    missing `BUILD` file (also missing alternatives `BUCK`) trailing",
		"package `root//src/app:` does not exist\n    missing `dir/BUILD` file",
		"package `root//src/app:` does not exist\n    missing `` file",
	} {
		if isMissingPackageError(packageName, diagnostic) {
			t.Errorf("expected %q to fail closed", diagnostic)
		}
	}
}
