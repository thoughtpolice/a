// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func graphTestTarget(packageName, name string, deps, inputs []string) target {
	return target{
		label:           packageName + ":" + name,
		name:            name,
		packageName:     packageName,
		repoPackage:     splitRepoPackage(packageName),
		ruleType:        "root//rules/rust.bzl:rust_library",
		deps:            append([]string(nil), deps...),
		inputs:          append([]string(nil), inputs...),
		targetHash:      "hash",
		labels:          nil,
		ciSrcs:          nil,
		ciSrcsMustMatch: nil,
		ciDeps:          nil,
	}
}

// headReach walks the head reverse-dependency edges the way propagation does,
// without the reason bookkeeping determine() layers on top.
func (g *graph) headReach(seeds []string, depthLimit *int) labelSet {
	return propagate(g.headReverseDeps, seeds, depthLimit)
}

func splitRepoPackage(packageName string) string {
	for index := 0; index+1 < len(packageName); index++ {
		if packageName[index:index+2] == "//" {
			return packageName[index+2:]
		}
	}
	return ""
}

func graphTestSnapshot(t *testing.T, targets []target, files []fileNode) snapshot {
	t.Helper()
	result := emptySnapshot(singleCellMap(t, t.TempDir()))
	for _, item := range targets {
		result.targets[item.label] = item
	}
	for _, item := range files {
		result.files[item.cellPath] = item
	}
	return result
}

func graphTestFile(path string, imports []string) fileNode {
	pathCopy := path
	return fileNode{
		cellPath: "root//" + path,
		path:     &pathCopy,
		imports:  append([]string(nil), imports...),
	}
}

func setContains(values labelSet, value string) bool {
	_, ok := values[value]
	return ok
}

func TestUnionIndexesKeepDeletedAndAddedInputs(t *testing.T) {
	base := graphTestSnapshot(t, []target{
		graphTestTarget("root//app", "lib", nil, []string{"app/old.rs"}),
	}, nil)
	changed := graphTestTarget("root//app", "lib", nil, []string{"app/new.rs"})
	changed.targetHash = "new"
	head := graphTestSnapshot(t, []target{changed}, nil)
	graph := newGraph(&base, &head, defaultTdutilConfig())

	if !setContains(graph.labelsForInput("app/old.rs"), "root//app:lib") {
		t.Fatal("deleted input was not retained in union index")
	}
	if !setContains(graph.labelsForInput("app/new.rs"), "root//app:lib") {
		t.Fatal("added input was not included in union index")
	}
	got, ok := graph.target("root//app:lib")
	if !ok || got.targetHash != "new" {
		t.Fatalf("preferred target = %#v, %v", got, ok)
	}
	if !setContains(graph.labelsForPackage("app"), "root//app:lib") {
		t.Fatal("package index omitted target")
	}
	if !setContains(graph.labelsForRule("rules/rust.bzl"), "root//app:lib") {
		t.Fatal("rule index omitted target")
	}
}

func TestHeadPropagationUsesOnlyHeadEdges(t *testing.T) {
	base := graphTestSnapshot(t, []target{
		graphTestTarget("root//a", "a", nil, nil),
		graphTestTarget("root//old", "old", []string{"root//a:a"}, nil),
	}, nil)
	head := graphTestSnapshot(t, []target{
		graphTestTarget("root//a", "a", nil, nil),
		graphTestTarget("root//new", "new", []string{"root//a:a"}, nil),
	}, nil)

	reached := newGraph(&base, &head, defaultTdutilConfig()).headReach([]string{"root//a:a"}, nil)
	if !setContains(reached, "root//new:new") {
		t.Fatal("head dependent was not reached")
	}
	if setContains(reached, "root//old:old") {
		t.Fatal("base-only dependent entered head propagation")
	}
}

func TestRemovedTargetCanSeedHeadDependents(t *testing.T) {
	base := graphTestSnapshot(t, []target{
		graphTestTarget("root//a", "gone", nil, nil),
	}, nil)
	head := graphTestSnapshot(t, []target{
		graphTestTarget("root//b", "consumer", []string{"root//a:gone"}, nil),
	}, nil)

	reached := newGraph(&base, &head, defaultTdutilConfig()).headReach([]string{"root//a:gone"}, nil)
	if !setContains(reached, "root//a:gone") || !setContains(reached, "root//b:consumer") {
		t.Fatalf("reached = %#v", reached)
	}
}

func TestPropagationObeysDepthAndHandlesCycles(t *testing.T) {
	head := graphTestSnapshot(t, []target{
		graphTestTarget("root//a", "a", []string{"root//c:c"}, nil),
		graphTestTarget("root//b", "b", []string{"root//a:a"}, nil),
		graphTestTarget("root//c", "c", []string{"root//b:b"}, nil),
	}, nil)
	base := graphTestSnapshot(t, nil, nil)
	graph := newGraph(&base, &head, defaultTdutilConfig())
	depth := 1
	reached := graph.headReach([]string{"root//a:a"}, &depth)
	if len(reached) != 2 || !setContains(reached, "root//a:a") || !setContains(reached, "root//b:b") {
		t.Fatalf("depth-one propagation = %#v", reached)
	}
	if reached := graph.headReach([]string{"root//a:a"}, nil); len(reached) != 3 {
		t.Fatalf("cycle propagation = %#v", reached)
	}
}

func TestCIDepLiteralsRelativePackagesAndRecursivePatternsAreEdges(t *testing.T) {
	dependency := graphTestTarget("root//lib", "dep", nil, nil)
	nested := graphTestTarget("root//lib/nested", "dep", nil, nil)
	literal := graphTestTarget("root//app", "literal", nil, nil)
	literal.ciDeps = []string{"root//lib:dep"}
	relative := graphTestTarget("root//app", "relative", nil, nil)
	relative.ciDeps = []string{":literal"}
	packageTarget := graphTestTarget("root//app", "package", nil, nil)
	packageTarget.ciDeps = []string{"root//lib:"}
	recursive := graphTestTarget("root//app", "recursive", nil, nil)
	recursive.ciDeps = []string{"root//lib/..."}
	head := graphTestSnapshot(t, []target{dependency, nested, literal, relative, packageTarget, recursive}, nil)
	base := graphTestSnapshot(t, nil, nil)
	graph := newGraph(&base, &head, defaultTdutilConfig())

	if !setContains(graph.headDependents("root//lib:dep"), "root//app:literal") {
		t.Fatal("literal ci_dep edge missing")
	}
	if !setContains(graph.headDependents("root//app:literal"), "root//app:relative") {
		t.Fatal("relative ci_dep edge missing")
	}
	if !setContains(graph.headDependents("root//lib:dep"), "root//app:package") {
		t.Fatal("package ci_dep edge missing")
	}
	if setContains(graph.headDependents("root//lib/nested:dep"), "root//app:package") {
		t.Fatal("package ci_dep crossed package boundary")
	}
	if !setContains(graph.headDependents("root//lib/nested:dep"), "root//app:recursive") {
		t.Fatal("recursive ci_dep edge missing")
	}
}

func TestCIDepLabelsWithEllipsisTargetNamesRemainExact(t *testing.T) {
	for _, pattern := range []string{"root//lib:literal...", "root//lib:literal/..."} {
		if !targetPatternMatches(pattern, pattern) {
			t.Errorf("exact pattern %q did not match itself", pattern)
		}
		if targetPatternMatches(pattern, "root//lib:literal/child") {
			t.Errorf("exact pattern %q matched child target", pattern)
		}
		if targetPatternMatches(pattern, "root//lib/nested:literal") {
			t.Errorf("exact pattern %q matched nested package", pattern)
		}
	}
}

func TestCIDepsFromRemovedTargetsReachSurvivingConsumers(t *testing.T) {
	base := graphTestSnapshot(t, []target{
		graphTestTarget("root//literal", "gone", nil, nil),
		graphTestTarget("root//relative", "gone", nil, nil),
		graphTestTarget("root//package", "gone", nil, nil),
		graphTestTarget("root//tree/nested", "gone", nil, nil),
	}, nil)
	literal := graphTestTarget("root//app", "literal_consumer", nil, nil)
	literal.ciDeps = []string{"root//literal:gone"}
	relative := graphTestTarget("root//relative", "relative_consumer", nil, nil)
	relative.ciDeps = []string{":gone"}
	packageTarget := graphTestTarget("root//app", "package_consumer", nil, nil)
	packageTarget.ciDeps = []string{"root//package:"}
	recursive := graphTestTarget("root//app", "recursive_consumer", nil, nil)
	recursive.ciDeps = []string{"root//tree/..."}
	head := graphTestSnapshot(t, []target{literal, relative, packageTarget, recursive}, nil)
	graph := newGraph(&base, &head, defaultTdutilConfig())

	tests := []struct{ removed, consumer string }{
		{"root//literal:gone", "root//app:literal_consumer"},
		{"root//relative:gone", "root//relative:relative_consumer"},
		{"root//package:gone", "root//app:package_consumer"},
		{"root//tree/nested:gone", "root//app:recursive_consumer"},
	}
	for _, test := range tests {
		if _, ok := graph.headTarget(test.removed); ok {
			t.Errorf("removed target %q remains at head", test.removed)
		}
		if !setContains(graph.headReach([]string{test.removed}, nil), test.consumer) {
			t.Errorf("removed target %q did not reach %q", test.removed, test.consumer)
		}
	}
}

func TestBaseOnlyCIDepsDependentsDoNotEnterTheHeadGraph(t *testing.T) {
	removed := graphTestTarget("root//lib", "gone", nil, nil)
	oldConsumer := graphTestTarget("root//app", "old_consumer", nil, nil)
	oldConsumer.ciDeps = []string{"root//lib:gone"}
	base := graphTestSnapshot(t, []target{removed, oldConsumer}, nil)
	head := graphTestSnapshot(t, nil, nil)

	reached := newGraph(&base, &head, defaultTdutilConfig()).headReach([]string{"root//lib:gone"}, nil)
	if len(reached) != 1 || !setContains(reached, "root//lib:gone") {
		t.Fatalf("head propagation = %#v", reached)
	}
}

func TestCIHintAddsSyntheticEdgeToRealTarget(t *testing.T) {
	hint := graphTestTarget("root//app", "ci_hint@real", nil, nil)
	hint.ruleType = "root//rules/ci.bzl:ci_hint"
	real := graphTestTarget("root//app", "real", nil, nil)
	head := graphTestSnapshot(t, []target{hint, real}, nil)
	base := graphTestSnapshot(t, nil, nil)

	if !setContains(newGraph(&base, &head, defaultTdutilConfig()).headDependents("root//app:ci_hint@real"), "root//app:real") {
		t.Fatal("ci_hint synthetic edge missing")
	}
}

func TestImportUnionAndTransitiveReverseWalk(t *testing.T) {
	base := graphTestSnapshot(t, nil, []fileNode{
		graphTestFile("BUCK", []string{"rules/a.bzl"}),
		graphTestFile("rules/a.bzl", []string{"rules/common.bzl"}),
	})
	head := graphTestSnapshot(t, nil, []fileNode{
		graphTestFile("rules/b.bzl", []string{"rules/common.bzl"}),
	})
	importers := newGraph(&base, &head, defaultTdutilConfig()).transitiveImporters([]string{"rules/common.bzl"})
	for _, path := range []string{"rules/common.bzl", "rules/a.bzl", "rules/b.bzl", "BUCK"} {
		if !setContains(importers, path) {
			t.Errorf("transitive importers omitted %q: %#v", path, importers)
		}
	}
}
