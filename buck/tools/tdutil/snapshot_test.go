// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const snapshotTestFileJSON = `{"buck.file":"root//src/app/BUCK","buck.package":"root//src/app","buck.imports":["root//rules/rust.bzl"]}`
const snapshotTestErrorJSON = `{"buck.package":"root//broken","buck.error":"something exploded"}`

func snapshotTestGraph(t *testing.T) snapshot {
	t.Helper()
	collected, err := parseTargetsJSONLines(
		[]byte(targetJSON("app")+"\n"+snapshotTestFileJSON+"\n"+snapshotTestErrorJSON+"\n"),
		testCellMap(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	return collected
}

func TestSnapshotDocumentRoundTripPreservesGraph(t *testing.T) {
	original := snapshotTestGraph(t)
	document := buildSnapshotDocument(
		"buck2 vX",
		strings.Repeat("a", 40),
		[]string{"root//..."},
		[]string{"-c", "x.y=1"},
		"digest",
		&original,
	)
	data, err := encodeSnapshotDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseSnapshotDocument(data)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := parsed.toSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restored.targets, original.targets) {
		t.Fatalf("targets = %#v, want %#v", restored.targets, original.targets)
	}
	if !reflect.DeepEqual(restored.files, original.files) {
		t.Fatalf("files = %#v, want %#v", restored.files, original.files)
	}
	if !reflect.DeepEqual(restored.errors, original.errors) {
		t.Fatalf("errors = %#v, want %#v", restored.errors, original.errors)
	}

	// Cell behavior survives without the original checkout's absolute anchors.
	path, err := restored.cells.toRepoPath("nested//lib.rs")
	if err != nil || path == nil || *path != "src/nested/lib.rs" {
		t.Fatalf("nested path = %v, %v", path, err)
	}
	external, err := restored.cells.toRepoPath("external//x.bzl")
	if err != nil || external != nil {
		t.Fatalf("external path = %v, %v; want nil, nil", external, err)
	}
	cellPath, err := restored.cells.toCellPath("src/nested/lib.rs")
	if err != nil || cellPath != "nested//lib.rs" {
		t.Fatalf("inverse path = %q, %v", cellPath, err)
	}
}

func TestSnapshotDocumentEncodingIsDeterministic(t *testing.T) {
	collected := snapshotTestGraph(t)
	first, err := encodeSnapshotDocument(buildSnapshotDocument("v", strings.Repeat("a", 40), []string{"root//..."}, nil, "", &collected))
	if err != nil {
		t.Fatal(err)
	}
	second, err := encodeSnapshotDocument(buildSnapshotDocument("v", strings.Repeat("a", 40), []string{"root//..."}, nil, "", &collected))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("encodings differ:\n%s\n%s", first, second)
	}
}

func TestParseSnapshotDocumentFailsClosed(t *testing.T) {
	collected := snapshotTestGraph(t)
	valid, err := encodeSnapshotDocument(buildSnapshotDocument("v", strings.Repeat("a", 40), []string{"root//..."}, nil, "", &collected))
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"not JSON":       []byte("nope"),
		"future schema":  []byte(`{"schema":999}`),
		"trailing data":  append(append([]byte{}, valid...), []byte("{}")...),
		"bad commit":     []byte(`{"schema":1,"commit":"zz","universe":["root//..."]}`),
		"no universe":    []byte(`{"schema":1,"commit":"aa","universe":[]}`),
		"unknown fields": []byte(`{"schema":1,"commit":"aa","universe":["root//..."],"surprise":true}`),
	} {
		if _, err := parseSnapshotDocument(data); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := parseSnapshotDocument(valid); err != nil {
		t.Fatalf("valid document rejected: %v", err)
	}
}

func TestSnapshotMismatchReasonsCoverEveryRecordedInput(t *testing.T) {
	document := &snapshotDocument{
		Commit:            strings.Repeat("a", 40),
		Universe:          []string{"depot//..."},
		BuckArgs:          []string{"-c", "k=v"},
		LocalConfigSHA256: "d",
	}
	if reason := document.mismatchReason(strings.Repeat("a", 40), []string{"depot//..."}, []string{"-c", "k=v"}, "d"); reason != "" {
		t.Fatalf("matching inputs rejected: %s", reason)
	}
	if reason := document.mismatchReason(strings.Repeat("b", 40), []string{"depot//..."}, []string{"-c", "k=v"}, "d"); !strings.Contains(reason, "commit") {
		t.Errorf("commit mismatch reason = %q", reason)
	}
	if reason := document.mismatchReason(strings.Repeat("a", 40), []string{"root//..."}, []string{"-c", "k=v"}, "d"); !strings.Contains(reason, "universe") {
		t.Errorf("universe mismatch reason = %q", reason)
	}
	if reason := document.mismatchReason(strings.Repeat("a", 40), []string{"depot//..."}, nil, "d"); !strings.Contains(reason, "arguments") {
		t.Errorf("argument mismatch reason = %q", reason)
	}
	if reason := document.mismatchReason(strings.Repeat("a", 40), []string{"depot//..."}, []string{"-c", "k=v"}, "e"); !strings.Contains(reason, "config") {
		t.Errorf("config mismatch reason = %q", reason)
	}
}

func TestLoadBaseSnapshotVerifiesBuckVersion(t *testing.T) {
	repository := t.TempDir()
	collected := snapshotTestGraph(t)
	document := buildSnapshotDocument("buck2 old", strings.Repeat("a", 40), []string{"depot//..."}, nil, "", &collected)
	data, err := encodeSnapshotDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "doc.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	versionRunner := func(version string) buckFakeRunner {
		return buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
			if len(spec.args) != 1 || spec.args[0] != "--version" {
				t.Fatalf("unexpected command %q", spec.args)
			}
			return processResult{stdout: []byte(version + "\n")}, nil
		}}
	}
	loaded, reason := loadBaseSnapshot(
		context.Background(),
		versionRunner("buck2 new"),
		path, "buck2", repository,
		strings.Repeat("a", 40), []string{"depot//..."}, nil,
	)
	if loaded != nil || !strings.Contains(reason, "buck2") {
		t.Fatalf("version drift accepted: loaded=%v reason=%q", loaded != nil, reason)
	}
	loaded, reason = loadBaseSnapshot(
		context.Background(),
		versionRunner("buck2 old"),
		path, "buck2", repository,
		strings.Repeat("a", 40), []string{"depot//..."}, nil,
	)
	if loaded == nil {
		t.Fatalf("matching snapshot rejected: %s", reason)
	}
}

func TestPlanUniverseCachedBaseInspectsOnlyHead(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	cells := singleCellMap(t, workspace)
	plan, err := planUniverseCachedBase(workspace, cells, []string{"root//src/...", "root//gone/...", "root//weird:a:b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.basePatterns) != 0 {
		t.Fatalf("base patterns = %#v, want none", plan.basePatterns)
	}
	if !slices.Equal(plan.headPatterns, []string{"root//src/...", "root//weird:a:b"}) {
		t.Fatalf("head patterns = %#v", plan.headPatterns)
	}
	if len(plan.patterns) != 3 {
		t.Fatalf("planned = %#v", plan.patterns)
	}
	for index, wantHead := range []bool{true, false, true} {
		planned := plan.patterns[index]
		if !planned.base || planned.head != wantHead {
			t.Fatalf("planned[%d] = base %v head %v", index, planned.base, planned.head)
		}
	}
}

func TestCachedBaseStillSelectsDependentsOfDeletedTargets(t *testing.T) {
	baseJSONL := `{"name":"lib","buck.package":"root//src","buck.type":"root//rules.bzl:lib","buck.deps":[],"buck.inputs":["root//src/lib.rs"],"buck.target_hash":"h1"}
{"name":"app","buck.package":"root//src","buck.type":"root//rules.bzl:bin","buck.deps":["root//src:lib"],"buck.inputs":["root//src/app.rs"],"buck.target_hash":"h2"}
`
	headJSONL := `{"name":"app","buck.package":"root//src","buck.type":"root//rules.bzl:bin","buck.deps":["root//src:lib"],"buck.inputs":["root//src/app.rs"],"buck.target_hash":"h2"}
`
	baseGraph, err := parseTargetsJSONLines([]byte(baseJSONL), singleCellMap(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	document := buildSnapshotDocument("v", strings.Repeat("a", 40), []string{"root//..."}, nil, "", &baseGraph)

	workspace := t.TempDir()
	runner := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		if hasArgumentSequence(spec.args, "audit", "cell") {
			return successfulBuckResult(cellAuditFor(t, workspace)), nil
		}
		return successfulBuckResult([]byte(headJSONL)), nil
	}}
	base, head, err := collectSnapshotPairFromDocument(
		context.Background(),
		runner,
		document,
		workspace,
		"buck2",
		nil,
		"",
		[]string{"root//..."},
	)
	if err != nil {
		t.Fatal(err)
	}
	affected, err := determine(&base, &head, []string{"src/lib.rs"}, determineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(affected) != 1 || affected[0].target != "root//src:app" {
		t.Fatalf("affected = %#v, want only the surviving dependent", affected)
	}
}
