// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func testCellMap(t *testing.T) cellMap {
	t.Helper()
	base := t.TempDir()
	repository := filepath.Join(base, "repo")
	audited, err := json.Marshal(map[string]string{
		"root":     repository,
		"alias":    repository,
		"nested":   filepath.Join(repository, "src", "nested"),
		"external": filepath.Join(base, "external"),
	})
	if err != nil {
		t.Fatal(err)
	}
	cells, err := parseCellMap(repository, audited)
	if err != nil {
		t.Fatal(err)
	}
	return cells
}

func TestCellsResolveAndChooseLongestInverseRoot(t *testing.T) {
	cells := testCellMap(t)

	path, err := cells.toRepoPath("root//src/main.rs")
	if err != nil || path == nil || *path != "src/main.rs" {
		t.Fatalf("root path = %v, %v", path, err)
	}
	path, err = cells.toRepoPath("nested//lib.rs")
	if err != nil || path == nil || *path != "src/nested/lib.rs" {
		t.Fatalf("nested path = %v, %v", path, err)
	}
	path, err = cells.toRepoPath("external//x.bzl")
	if err != nil || path != nil {
		t.Fatalf("external path = %v, %v; want nil, nil", path, err)
	}

	cellPath, err := cells.toCellPath("src/nested/lib.rs")
	if err != nil || cellPath != "nested//lib.rs" {
		t.Fatalf("nested inverse path = %q, %v", cellPath, err)
	}
	cellPath, err = cells.toCellPath("README.md")
	if err != nil || cellPath != "alias//README.md" {
		t.Fatalf("equal-root alias = %q, %v", cellPath, err)
	}
}

func TestCellsRejectUnknownAndEscapingPaths(t *testing.T) {
	cells := testCellMap(t)
	if _, err := cells.toRepoPath("missing//x"); err == nil {
		t.Fatal("unknown cell was accepted")
	}
	if _, err := cells.toRepoPath("root//../outside"); err == nil {
		t.Fatal("escaping cell path was accepted")
	}
	if _, err := parseCellMap(filepath.Join(t.TempDir(), "repo"), []byte("[]")); err == nil {
		t.Fatal("non-object cell audit was accepted")
	}
}

func TestCellMapRejectsInvalidUTF8(t *testing.T) {
	repository := filepath.Join(t.TempDir(), "repo")
	data := append([]byte(`{"root":"`+repository), 0xff)
	data = append(data, []byte(`"}`)...)
	if _, err := parseCellMap(repository, data); err == nil {
		t.Fatal("invalid UTF-8 cell audit was accepted")
	}
}
