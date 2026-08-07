// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"slices"
	"strings"
	"testing"
)

func determineTestTarget(packageName, name, hash string, deps, inputs []string) target {
	return target{
		label:           packageName + ":" + name,
		name:            name,
		packageName:     packageName,
		repoPackage:     splitRepoPackage(packageName),
		ruleType:        "root//rules/rust.bzl:rust_library",
		deps:            append([]string(nil), deps...),
		inputs:          append([]string(nil), inputs...),
		targetHash:      hash,
		labels:          nil,
		ciSrcs:          nil,
		ciSrcsMustMatch: nil,
		ciDeps:          nil,
	}
}

func determineTestSnapshot(t *testing.T, targets ...target) snapshot {
	t.Helper()
	result := emptySnapshot(singleCellMap(t, t.TempDir()))
	for _, item := range targets {
		result.targets[item.label] = item
	}
	return result
}

func determineTestFile(path string, imports []string) fileNode {
	pathCopy := path
	return fileNode{
		cellPath: "root//" + path,
		path:     &pathCopy,
		imports:  append([]string(nil), imports...),
	}
}

func affectedLabels(affected []affectedTarget) []string {
	result := make([]string, len(affected))
	for index, item := range affected {
		result[index] = item.target
	}
	return result
}

func TestChangedInputPropagatesToHeadDependents(t *testing.T) {
	base := determineTestSnapshot(t,
		determineTestTarget("root//lib", "lib", "same", nil, []string{"lib/lib.rs"}),
		determineTestTarget("root//app", "app", "same", []string{"root//lib:lib"}, nil),
	)
	head := base
	result, err := determine(&base, &head, []string{"lib/lib.rs"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(affectedLabels(result), []string{"root//app:app", "root//lib:lib"}) {
		t.Fatalf("affected = %#v", result)
	}
	if result[0].depth != 1 || result[1].depth != 0 {
		t.Fatalf("depths = %d, %d", result[0].depth, result[1].depth)
	}
}

func TestAddedRemovedAndHashChangedTargetsAreRoots(t *testing.T) {
	gone := determineTestTarget("root//pkg", "gone", "old", nil, nil)
	changedOld := determineTestTarget("root//pkg", "changed", "old", nil, nil)
	changedNew := determineTestTarget("root//pkg", "changed", "new", nil, nil)
	changedNew.ciSrcsMustMatch = []string{"never/**"}
	added := determineTestTarget("root//pkg", "new", "new", nil, nil)
	added.ciSrcsMustMatch = []string{"never/**"}
	base := determineTestSnapshot(t, gone, changedOld)
	head := determineTestSnapshot(t, added, changedNew)

	result, err := determine(&base, &head, []string{"unrelated"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(affectedLabels(result), []string{"root//pkg:changed", "root//pkg:new"}) {
		t.Fatalf("affected = %#v", result)
	}
}

func TestBuildAndInheritedPackageFilesDirtyPackages(t *testing.T) {
	targets := []target{
		determineTestTarget("root//a", "a", "x", nil, nil),
		determineTestTarget("root//a/b", "b", "x", nil, nil),
		determineTestTarget("root//other", "other", "x", nil, nil),
	}
	for index := range targets {
		targets[index].ciSrcsMustMatch = []string{"never/**"}
	}
	state := determineTestSnapshot(t, targets...)
	// The build file name comes from the cell's buckconfig, so the test states
	// one rather than relying on whatever this repository happens to use.
	options := determineOptions{config: buildFileTestConfig("BUILD")}
	build, err := determine(&state, &state, []string{"a/BUILD"}, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(build) != 1 {
		t.Fatalf("BUILD affected = %#v", build)
	}
	// A cell which does not name BUILD does not have its packages dirtied by
	// one, however much the file looks like a build file to a human.
	unnamed, err := determine(&state, &state, []string{"a/BUILD"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(unnamed) != 0 {
		t.Fatalf("unconfigured BUILD affected = %#v", unnamed)
	}
	packageAffected, err := determine(&state, &state, []string{"a/PACKAGE"}, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(packageAffected) != 2 {
		t.Fatalf("PACKAGE affected = %#v", packageAffected)
	}
}

func TestTransitiveNonBzlRuleImportReachesTargets(t *testing.T) {
	app := determineTestTarget("root//app", "app", "x", nil, nil)
	app.ruleType = "root//rules/rust.star:rust_library"
	app.ciSrcsMustMatch = []string{"never/**"}
	state := determineTestSnapshot(t, app)
	for _, file := range []fileNode{
		determineTestFile("rules/rust.star", []string{"rules/common.inc"}),
		determineTestFile("rules/common.inc", nil),
	} {
		state.files[file.cellPath] = file
	}

	result, err := determine(&state, &state, []string{"rules/common.inc"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || result[0].target != "root//app:app" {
		t.Fatalf("affected = %#v", result)
	}
	unrelated, err := determine(&state, &state, []string{"rules/unrelated.txt"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(unrelated) != 0 {
		t.Fatalf("unrelated affected = %#v", unrelated)
	}
}

func TestConfigChangeIsWholeHeadUniverse(t *testing.T) {
	state := determineTestSnapshot(t,
		determineTestTarget("root//a", "a", "x", nil, nil),
		determineTestTarget("root//b", "b", "x", nil, nil),
	)
	result, err := determine(&state, &state, []string{".buckconfig.d/ci.buckconfig"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 {
		t.Fatalf("affected = %#v", result)
	}
}

// buildFileTestConfig states one root cell whose build files are named as
// given, which is what a repository's buckconfig would otherwise supply.
func buildFileTestConfig(names ...string) tdutilConfig {
	config := defaultTdutilConfig()
	config.buildFiles = buildFileMatcher{cells: []cellBuildFiles{{root: "", names: names}}}
	return config
}

func TestGlobalConfigurationClassifierCoversBuckConventions(t *testing.T) {
	// The well-known Buck names hold for any repository, so they are matched
	// without anything being configured.
	config := defaultTdutilConfig()
	for _, path := range []string{
		".buckroot",
		".buckconfig",
		"cell/.buckconfig",
		"config/ci.buckconfig",
		".buckconfig.d/cells-common.include",
		"cell/buckconfigs/dev.bcfg",
		"config/dev.bcfg",
		"buck/ci.buckargs",
		"cell/dev.buckargs",
	} {
		if !config.isGlobalConfiguration(path) {
			t.Errorf("expected %q to match", path)
		}
	}
	for _, path := range []string{
		"src/config.rs",
		"buck/model/remote",
		"modes/remote",
		"config/buckconfig",
		"config/buckargs",
		"config/dev.cfg",
		// Not a Buck convention: only reachable once a repository says so.
		"buck/mode/remote",
	} {
		if config.isGlobalConfiguration(path) {
			t.Errorf("expected %q not to match", path)
		}
	}
}

func TestGlobalConfigurationHonoursConfiguredPaths(t *testing.T) {
	config := defaultTdutilConfig()
	config.globalConfigPaths = normalizeConfigPaths([]string{"buck/mode", "/ci/modes/"})
	for _, path := range []string{
		"buck/mode",
		"buck/mode/remote",
		"buck/mode/nested/config",
		"ci/modes/opt",
	} {
		if !config.isGlobalConfiguration(path) {
			t.Errorf("expected configured %q to match", path)
		}
	}
	// A configured path names a directory or a file, never a string prefix.
	for _, path := range []string{
		"buck/modes/remote",
		"buck/mode-extra/x",
		"ci/modesty",
	} {
		if config.isGlobalConfiguration(path) {
			t.Errorf("expected %q not to match", path)
		}
	}
}

func TestDepthZeroKeepsRootsOnly(t *testing.T) {
	state := determineTestSnapshot(t,
		determineTestTarget("root//a", "a", "x", nil, []string{"a/a.rs"}),
		determineTestTarget("root//b", "b", "x", []string{"root//a:a"}, nil),
	)
	depth := 0
	result, err := determine(&state, &state, []string{"a/a.rs"}, determineOptions{depth: &depth})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || result[0].target != "root//a:a" {
		t.Fatalf("affected = %#v", result)
	}
}

func TestRemovedTargetIsASilentRootForSurvivingDependents(t *testing.T) {
	consumer := determineTestTarget("root//app", "consumer", "same", []string{"root//old:gone"}, nil)
	base := determineTestSnapshot(t,
		determineTestTarget("root//old", "gone", "x", nil, nil),
		consumer,
	)
	head := determineTestSnapshot(t, consumer)
	result, err := determine(&base, &head, []string{"old/BUILD"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || result[0].target != "root//app:consumer" || result[0].depth != 1 {
		t.Fatalf("affected = %#v", result)
	}
	if result[0].affectedDep == nil || *result[0].affectedDep != "root//old:gone" {
		t.Fatalf("affected dependency = %v", result[0].affectedDep)
	}
}

func TestCIMustMatchGatesTargetAndReverseDependencyBridge(t *testing.T) {
	source := determineTestTarget("root//lib", "lib", "same", nil, []string{"lib/lib.rs"})
	gated := determineTestTarget("root//mid", "generated", "same", []string{"root//lib:lib"}, nil)
	gated.ciSrcsMustMatch = []string{"generated/**"}
	consumer := determineTestTarget("root//app", "app", "same", []string{"root//mid:generated"}, nil)
	state := determineTestSnapshot(t, source, gated, consumer)

	result, err := determine(&state, &state, []string{"lib/lib.rs"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(affectedLabels(result), []string{"root//lib:lib"}) {
		t.Fatalf("gated affected = %#v", result)
	}
	result, err = determine(&state, &state, []string{"lib/lib.rs", "generated/config.json"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(affectedLabels(result), []string{"root//app:app", "root//lib:lib", "root//mid:generated"}) {
		t.Fatalf("ungated affected = %#v", result)
	}
}

func TestIntrinsicRootBypassesGateAndRemainsABridge(t *testing.T) {
	root := determineTestTarget("root//lib", "lib", "same", nil, []string{"lib/lib.rs"})
	root.ciSrcsMustMatch = []string{"generated/**"}
	consumer := determineTestTarget("root//app", "app", "same", []string{"root//lib:lib"}, nil)
	state := determineTestSnapshot(t, root, consumer)

	result, err := determine(&state, &state, []string{"lib/lib.rs"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(affectedLabels(result), []string{"root//app:app", "root//lib:lib"}) {
		t.Fatalf("affected = %#v", result)
	}
}

func TestCISrcsCreatedRootMustPassItsGate(t *testing.T) {
	check := determineTestTarget("root//docs", "check", "same", nil, nil)
	check.ciSrcs = []string{"docs/**"}
	check.ciSrcsMustMatch = []string{"generated/**"}
	state := determineTestSnapshot(t, check)

	gated, err := determine(&state, &state, []string{"docs/readme.md"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(gated) != 0 {
		t.Fatalf("gated affected = %#v", gated)
	}
	selected, err := determine(&state, &state, []string{"docs/readme.md", "generated/index.json"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 1 || selected[0].target != "root//docs:check" {
		t.Fatalf("selected = %#v", selected)
	}
}
func TestInvalidCIGlobFailsClosedWithContext(t *testing.T) {
	invalid := determineTestTarget("root//pkg", "target", "x", nil, nil)
	invalid.ciSrcs = []string{"src/[unterminated"}
	state := determineTestSnapshot(t, invalid)
	_, err := determine(&state, &state, nil, determineOptions{})
	if err == nil ||
		!strings.Contains(err.Error(), "invalid `ci_srcs` glob") ||
		!strings.Contains(err.Error(), "src/[unterminated") ||
		!strings.Contains(err.Error(), "root//pkg:target") {
		t.Fatalf("invalid glob error = %v", err)
	}
}
