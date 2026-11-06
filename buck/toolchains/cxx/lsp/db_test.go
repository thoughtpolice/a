// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestTokenize(t *testing.T) {
	got := tokenize("-I\nbuck-out/x\n\"-DNAME=a b\" '-DQ=\"q\"' a\\ b \"-Dx=\\\"y\\\"\"\n")
	want := []string{"-I", "buck-out/x", "-DNAME=a b", `-DQ="q"`, "a b", `-Dx="y"`}
	if !slices.Equal(got, want) {
		t.Errorf("tokenize = %q, want %q", got, want)
	}
}

type tree struct {
	t    *testing.T
	root string
}

func newTree(t *testing.T) *tree {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &tree{t, root}
}

func (r *tree) path(rel string) string { return filepath.Join(r.root, rel) }

func (r *tree) write(rel, content string) {
	if err := os.MkdirAll(filepath.Dir(r.path(rel)), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(r.path(rel), []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

// link makes a relative link at rel to target, as the prelude's trees are.
func (r *tree) link(rel, target string) {
	if err := os.MkdirAll(filepath.Dir(r.path(rel)), 0o755); err != nil {
		r.t.Fatal(err)
	}
	to, err := filepath.Rel(filepath.Dir(r.path(rel)), r.path(target))
	if err != nil {
		r.t.Fatal(err)
	}
	if err := os.Symlink(to, r.path(rel)); err != nil {
		r.t.Fatal(err)
	}
}

func TestEntries(t *testing.T) {
	r := newTree(t)
	r.write("src/lib/lib.h", "")
	r.write("src/lib/lib.c", "")
	r.write("buck-out/gen/version.h", "")
	r.write("buck-out/archive/include/vendor/v.h", "")

	// A tree whose headers are all found from a directory elsewhere, the
	// repository's root.
	r.link("buck-out/lib/buck-headers/src/lib/lib.h", "src/lib/lib.h")
	// One with a generated header, found only through the tree, and one
	// from an extracted archive.
	r.link("buck-out/renamed/buck-headers/vendor/v.h", "buck-out/archive/include/vendor/v.h")
	r.link("buck-out/renamed/buck-headers/src/lib/version.h", "buck-out/gen/version.h")

	r.write("buck-out/args/deps", "-I\nbuck-out/lib/buck-headers\n-isystembuck-out/renamed/buck-headers\n-I\n/usr/include\n")
	r.write("buck-out/args/top", "@buck-out/args/deps\n\"-DX=a b\"\n@nested\n")
	r.write("buck-out/args/nested", "-DNESTED\n")

	db := newDatabase(r.root)
	entries, err := db.entries([]buckEntry{
		{Arguments: []string{"/bin/sh", "@buck-out/args/top", "-c", "src/lib/lib.h"}, File: "src/lib/lib.h", Header: true},
		{Arguments: []string{"/bin/sh", "@buck-out/args/top", "-c", "src/lib/lib.c"}, File: "src/lib/lib.c"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].File != r.path("src/lib/lib.c") || entries[1].File != r.path("src/lib/lib.h") {
		t.Fatalf("entries %+v, want the source's first", entries)
	}
	want := []string{
		"/bin/sh",
		"-I", r.root,
		"-isystem" + r.path("buck-out/archive/include"), "-isystembuck-out/renamed/buck-headers",
		"-I", "/usr/include",
		"-DX=a b",
		"-DNESTED",
		"-c", "src/lib/lib.c",
	}
	if got := entries[0].Arguments; !slices.Equal(got, want) {
		t.Errorf("arguments\n%q\nwant\n%q", got, want)
	}
	if entries[0].Directory != r.root {
		t.Errorf("directory %s, want %s", entries[0].Directory, r.root)
	}
	if got := db.drivers(); !slices.Equal(got, []string{"/bin/sh"}) {
		t.Errorf("drivers %v", got)
	}
}

func TestCompilerOnPath(t *testing.T) {
	db := newDatabase(t.TempDir())
	if got := db.compiler("sh"); !filepath.IsAbs(got) {
		t.Errorf("compiler(sh) = %s, want an absolute path", got)
	}
	if got := db.compiler("bin/cc"); got != filepath.Join(db.root, "bin/cc") {
		t.Errorf("compiler(bin/cc) = %s", got)
	}
}

func TestMissingArgumentFile(t *testing.T) {
	db := newDatabase(t.TempDir())
	if got := db.expand([]string{"cc", "@missing", "-c", "a.c"}, 0); !slices.Equal(got, []string{"cc", "@missing", "-c", "a.c"}) {
		t.Errorf("expand = %q", got)
	}
}
