// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"slices"
	"strings"
	"testing"
)

// parseTargetsJSONLines builds a snapshot from a whole JSONL dump at once.
// Collection itself streams the dump line by line and never holds it, so this
// exists only to let tests state a graph as literal Buck output.
func parseTargetsJSONLines(data []byte, cells cellMap) (snapshot, error) {
	parser := newTargetStreamParser(cells, defaultTdutilConfig())
	feedLines(data, parser.consume)
	return parser.finish()
}

func targetJSON(name string) string {
	return `{"name":"` + name + `","buck.package":"root//src/app","buck.type":"root//rules/rust.bzl:rust_library","buck.deps":["root//src/lib:lib"],"buck.inputs":["root//src/app/lib.rs","nested//generated.rs","external//builtin.bzl"],"buck.target_hash":"abc","labels":["ci:linux"],"ci_srcs":["config/**"],"ci_srcs_must_match":["**/*.rs"],"ci_deps":["root//tools/..."]}`
}

func TestParsesAllTargetFieldsAndExternalInputs(t *testing.T) {
	snapshot, err := parseTargetsJSONLines([]byte(targetJSON("app")), testCellMap(t))
	if err != nil {
		t.Fatal(err)
	}
	target := snapshot.targets["root//src/app:app"]
	if target.repoPackage != "src/app" {
		t.Fatalf("repo package = %q", target.repoPackage)
	}
	// Three inputs are declared and two survive: the one in an external cell
	// has no repository path and is dropped rather than failing the parse.
	if !slices.Equal(target.inputs, []string{"src/app/lib.rs", "src/nested/generated.rs"}) {
		t.Fatalf("inputs = %#v", target.inputs)
	}
	if target.targetHash != "abc" {
		t.Fatalf("hash = %q", target.targetHash)
	}
	if !slices.Equal(target.labels, []string{"ci:linux"}) ||
		!slices.Equal(target.ciSrcs, []string{"config/**"}) ||
		!slices.Equal(target.ciSrcsMustMatch, []string{"**/*.rs"}) ||
		!slices.Equal(target.ciDeps, []string{"root//tools/..."}) {
		t.Fatalf("CI attributes = labels=%#v srcs=%#v must=%#v deps=%#v", target.labels, target.ciSrcs, target.ciSrcsMustMatch, target.ciDeps)
	}
	ruleFile, ok := target.ruleFile()
	if !ok || ruleFile != "root//rules/rust.bzl" {
		t.Fatalf("rule file = %q, %v", ruleFile, ok)
	}
}
func TestOptionalArraysDefaultButRequiredFieldsDoNot(t *testing.T) {
	cells := testCellMap(t)
	valid := `{"name":"x","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":[],"buck.inputs":[],"buck.target_hash":"h"}`
	snapshot, err := parseTargetsJSONLines([]byte(valid), cells)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.targets["root//:x"].labels) != 0 {
		t.Fatal("missing optional labels did not default to empty")
	}

	missingInputs := `{"name":"x","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":[],"buck.target_hash":"h"}`
	if _, err := parseTargetsJSONLines([]byte(missingInputs), cells); err == nil {
		t.Fatal("missing required inputs were accepted")
	}
	wrongDeps := `{"name":"x","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":"nope","buck.inputs":[],"buck.target_hash":"h"}`
	if _, err := parseTargetsJSONLines([]byte(wrongDeps), cells); err == nil {
		t.Fatal("non-array deps were accepted")
	}
}

func TestParserFailsClosedOnBadOrUnknownRecords(t *testing.T) {
	cells := testCellMap(t)
	for _, input := range []string{
		"not json",
		`{"diagnostic":"new shape"}`,
		`{"buck.file":"root//BUCK"}`,
	} {
		if _, err := parseTargetsJSONLines([]byte(input), cells); err == nil {
			t.Fatalf("invalid record %q was accepted", input)
		}
	}
	duplicate := targetJSON("app") + "\n" + targetJSON("app")
	if _, err := parseTargetsJSONLines([]byte(duplicate), cells); err == nil {
		t.Fatal("duplicate target record was accepted")
	}
}

func TestAcceptsLegacyBuckHashSpelling(t *testing.T) {
	input := `{"name":"x","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":[],"buck.inputs":[],"buck.hash":"h"}`
	snapshot, err := parseTargetsJSONLines([]byte(input), testCellMap(t))
	if err != nil {
		t.Fatal(err)
	}
	if got := snapshot.targets["root//:x"].targetHash; got != "h" {
		t.Fatalf("target hash = %q", got)
	}
}

func TestTargetParserRejectsInvalidUTF8(t *testing.T) {
	input := append([]byte(`{"name":"`), 0xff)
	input = append(input, []byte(`","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":[],"buck.inputs":[],"buck.target_hash":"h"}`)...)
	if _, err := parseTargetsJSONLines(input, testCellMap(t)); err == nil {
		t.Fatal("invalid UTF-8 target JSON was accepted")
	}
}

func TestTargetParserMatchesSerdeUnicodeSurrogateValidation(t *testing.T) {
	for _, escapedName := range []string{`\ud800`, `\udc00`, `\ud800x`, `\ud800\ud800`} {
		input := `{"name":"` + escapedName + `","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":[],"buck.inputs":[],"buck.target_hash":"h"}`
		if _, err := parseTargetsJSONLines([]byte(input), testCellMap(t)); err == nil {
			t.Errorf("lone surrogate in name %q was accepted", escapedName)
		}
	}

	validPair := `{"name":"\ud83d\ude00","buck.package":"root//","buck.type":"root//r.bzl:r","buck.deps":[],"buck.inputs":[],"buck.target_hash":"h"}`
	snapshot, err := parseTargetsJSONLines([]byte(validPair), testCellMap(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := snapshot.targets["root//:😀"]; !ok {
		t.Fatalf("decoded targets = %#v", snapshot.targets)
	}
}

func TestParsesImportsAndResolvesRepoPaths(t *testing.T) {
	input := strings.Join([]string{
		targetJSON("app"),
		`{"buck.file":"root//src/app/BUCK","buck.package":"root//src/app","buck.imports":["root//rules/rust.bzl","external//prelude.bzl"]}`,
	}, "\n")
	snapshot, err := parseTargetsJSONLines([]byte(input), testCellMap(t))
	if err != nil {
		t.Fatal(err)
	}
	file := snapshot.files["root//src/app/BUCK"]
	if file.path == nil || *file.path != "src/app/BUCK" {
		t.Fatalf("file path = %v", file.path)
	}
	if file.repoPackage == nil || *file.repoPackage != "src/app" {
		t.Fatalf("repo package = %v", file.repoPackage)
	}
	if !slices.Equal(file.imports, []string{"rules/rust.bzl"}) {
		t.Fatalf("imports = %#v", file.imports)
	}
}

// Without --keep-going buck2 aborts rather than reporting a loading error
// inline, so a record which claims otherwise means the dump is describing a
// graph tdutil cannot account for. Refusing it keeps the failure loud.
func TestErrorRecordIsRefusedRatherThanAccumulated(t *testing.T) {
	input := `{"buck.package":"root//broken","buck.error":"Error parsing: ` + "`root//broken:BUCK`" + `"}`
	_, err := parseTargetsJSONLines([]byte(input), testCellMap(t))
	if err == nil || !strings.Contains(err.Error(), "reported a graph error") {
		t.Fatalf("error = %v, want a refusal naming the graph error", err)
	}
	if err != nil && !strings.Contains(err.Error(), "Error parsing") {
		t.Fatalf("error = %v, want buck2's own wording carried through", err)
	}
}
