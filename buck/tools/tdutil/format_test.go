// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func formatMetadata() metadata {
	return metadata{
		baseRevset: "@-",
		headRevset: "@",
		baseCommit: "aaa",
		headCommit: "bbb",
		universe:   []string{"root//..."},
	}
}

func formatTargets() []affectedTarget {
	dependency := "root//app:lib"
	return []affectedTarget{{
		target:      "root//app:test",
		ruleType:    "prelude//rules.bzl:rust_test",
		depth:       1,
		reason:      "input `app/test.rs` changed",
		affectedDep: &dependency,
	}}
}

// Port of format.rs::text_is_at_file_compatible_and_terminated.
func TestFormatTextIsAtFileCompatibleAndTerminated(t *testing.T) {
	var output bytes.Buffer
	meta := formatMetadata()
	if err := render(&output, formatText, &meta, formatTargets()); err != nil {
		t.Fatal(err)
	}
	if got, want := output.String(), "root//app:test\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

// Port of format.rs::empty_text_is_empty.
func TestFormatEmptyTextIsEmpty(t *testing.T) {
	var output bytes.Buffer
	meta := formatMetadata()
	if err := render(&output, formatText, &meta, nil); err != nil {
		t.Fatal(err)
	}
	if output.Len() != 0 {
		t.Fatalf("output = %q, want empty", output.String())
	}
}

// Port of format.rs::json_has_metadata_and_reasons.
func TestFormatJSONHasMetadataAndReasons(t *testing.T) {
	var output bytes.Buffer
	meta := formatMetadata()
	if err := render(&output, formatJSON, &meta, formatTargets()); err != nil {
		t.Fatal(err)
	}
	var document struct {
		Base       string       `json:"base"`
		Head       string       `json:"head"`
		BaseCommit string       `json:"base_commit"`
		HeadCommit string       `json:"head_commit"`
		Universe   []string     `json:"universe"`
		Count      int          `json:"count"`
		Targets    []jsonTarget `json:"targets"`
	}
	if err := json.Unmarshal(output.Bytes(), &document); err != nil {
		t.Fatalf("decoding output %q: %v", output.String(), err)
	}
	if document.Base != "@-" || document.Head != "@" || document.BaseCommit != "aaa" || document.HeadCommit != "bbb" {
		t.Fatalf("metadata = %+v", document)
	}
	if document.Count != 1 || len(document.Targets) != 1 {
		t.Fatalf("count/targets = %d/%d", document.Count, len(document.Targets))
	}
	target := document.Targets[0]
	if target.RuleType != "prelude//rules.bzl:rust_test" || target.Depth != 1 || target.AffectedDep == nil || *target.AffectedDep != "root//app:lib" {
		t.Fatalf("target = %+v", target)
	}
}

// Port of format.rs::json_lines_are_one_object_per_target.
func TestFormatJSONLinesAreOneObjectPerTarget(t *testing.T) {
	var output bytes.Buffer
	meta := formatMetadata()
	if err := render(&output, formatJSONLines, &meta, formatTargets()); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(output.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("lines = %d, want 1; output %q", len(lines), output.String())
	}
	var target jsonTarget
	if err := json.Unmarshal([]byte(lines[0]), &target); err != nil {
		t.Fatal(err)
	}
	if target.Target != "root//app:test" {
		t.Fatalf("target = %q", target.Target)
	}
}

type shortWriter struct{}

func (shortWriter) Write(contents []byte) (int, error) {
	if len(contents) == 0 {
		return 0, nil
	}
	return len(contents) - 1, nil
}

func TestFormatRejectsShortWrite(t *testing.T) {
	meta := formatMetadata()
	err := render(shortWriter{}, formatText, &meta, formatTargets())
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("error = %v, want io.ErrShortWrite", err)
	}
}

func TestFormatRejectsInvalidUTF8(t *testing.T) {
	meta := formatMetadata()
	targets := formatTargets()
	targets[0].reason = string([]byte{0xff})
	var output bytes.Buffer
	if err := render(&output, formatJSON, &meta, targets); err == nil {
		t.Fatal("render accepted invalid UTF-8")
	}
	if output.Len() != 0 {
		t.Fatalf("partial output = %q", output.Bytes())
	}
}
