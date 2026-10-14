// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// checkoutFiles checks a commit of files out into a new directory.
func checkoutFiles(t *testing.T, files map[string]testFile) (string, error) {
	t.Helper()
	data, commit := repoPack(sha1Format, files)
	p, err := readPack(sha1Format, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "work")
	return dir, checkout(p, commit, dir)
}

// readTree returns every file and symlink under dir, by slash-separated
// path, with a symlink's value being "-> target".
func readTree(t *testing.T, dir string) map[string]string {
	t.Helper()
	got := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if d.Type()&fs.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			got[filepath.ToSlash(rel)] = "-> " + target
			return err
		}
		data, err := os.ReadFile(path)
		got[filepath.ToSlash(rel)] = string(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCheckoutWritesContentsModesAndSymlinks(t *testing.T) {
	submodule := strings.Repeat("ab", 20)
	dir, err := checkoutFiles(t, map[string]testFile{
		"README":         {modeFile, "hello\n"},
		"bin/run":        {modeExec, "#!/bin/sh\n"},
		"bin/odd":        {0o100664, "group-writable modes check out as 0644\n"},
		"link":           {modeSymlink, "README"},
		"dangling":       {modeSymlink, "../nowhere"},
		"a/b/c/deep.txt": {modeFile, "deep\n"},
		"vendor/module":  {modeGitlink, submodule},
		"empty":          {modeDir, ""},
		"x/empty":        {modeDir, ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"README":         "hello\n",
		"bin/run":        "#!/bin/sh\n",
		"bin/odd":        "group-writable modes check out as 0644\n",
		"link":           "-> README",
		"dangling":       "-> ../nowhere",
		"a/b/c/deep.txt": "deep\n",
	}
	got := readTree(t, dir)
	for path, contents := range want {
		if got[path] != contents {
			t.Errorf("%s: got %q, want %q", path, got[path], contents)
		}
	}
	if len(got) != len(want) {
		t.Errorf("checked out %v, want %v", got, want)
	}
	for path, exec := range map[string]bool{"README": false, "bin/run": true, "bin/odd": false} {
		info, err := os.Stat(filepath.Join(dir, path))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode()&0o100 != 0; got != exec {
			t.Errorf("%s: executable %v, want %v", path, got, exec)
		}
	}
	// Submodules are empty directories; empty trees are not checked out,
	// nor are directories holding only empty trees.
	if entries, err := os.ReadDir(filepath.Join(dir, "vendor/module")); err != nil || len(entries) != 0 {
		t.Errorf("submodule: %v, %v", entries, err)
	}
	for _, path := range []string{"empty", "x"} {
		if _, err := os.Lstat(filepath.Join(dir, path)); !os.IsNotExist(err) {
			t.Errorf("%s exists: %v", path, err)
		}
	}
}

// listOne lists a tree that holds a single entry named name.
func listOne(t *testing.T, name string, mode uint32) error {
	t.Helper()
	b := newPackBuilder(sha1Format)
	tree := b.add(typeTree, sha1Format.encodeTree([]treeEntry{{mode, name, b.add(typeBlob, nil)}}))
	p, err := readPack(sha1Format, bytes.NewReader(b.bytes()))
	if err != nil {
		t.Fatal(err)
	}
	var entries []indexEntry
	return listTree(p, tree, "", &entries)
}

func TestCheckoutRefusesUnsafeNames(t *testing.T) {
	for _, name := range []string{
		".git", ".GIT", ".Git", "git~1", "GIT~1", ".git.", ".git ", ".git . .", ".git:stream",
		`a\.git`, `.git\a`, "..", ".", "", "a/b",
	} {
		if listOne(t, name, modeFile) == nil {
			t.Errorf("checked out %q", name)
		}
	}
	for _, name := range []string{".gitignore", ".github", "git", ".git-blame-ignore-revs", ".gitx", "x.git", `a\b`} {
		if err := listOne(t, name, modeFile); err != nil {
			t.Errorf("%q: %v", name, err)
		}
	}
	if listOne(t, ".GitModules.", modeSymlink) == nil {
		t.Error("checked out a symlinked .gitmodules")
	}
	if err := listOne(t, ".gitmodules", modeFile); err != nil {
		t.Error(err)
	}
}

func TestCheckoutRefusesCollisions(t *testing.T) {
	b := newPackBuilder(sha1Format)
	blob := b.add(typeBlob, []byte("x"))
	tree := b.add(typeTree, sha1Format.encodeTree([]treeEntry{{modeFile, "a", blob}, {modeFile, "a", blob}}))
	commit := b.addCommit(tree)
	p, err := readPack(sha1Format, bytes.NewReader(b.bytes()))
	if err != nil {
		t.Fatal(err)
	}
	err = checkout(p, commit, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "another path") {
		t.Fatalf("got %v", err)
	}
}

func TestCheckoutRefusesUnsupportedEncodings(t *testing.T) {
	_, err := checkoutFiles(t, map[string]testFile{
		".gitattributes": {modeFile, "*.txt working-tree-encoding=UTF-16\n"},
		"a.txt":          {modeFile, "a\n"},
	})
	if err == nil || !strings.Contains(err.Error(), "working-tree-encoding=UTF-16 is not supported") {
		t.Fatalf("got %v", err)
	}
}

type caseFile struct {
	path string
	mode uint32
	data string
}

type wantFile struct {
	path, data string
}

type checkoutCase struct {
	name  string
	files []caseFile
	want  []wantFile // the regular files git checks out
	fails bool       // git refuses to check this out
}

// TestCheckoutMatchesGit checks out the cases in cases_test.go, which
// record what git itself checks out for them.
func TestCheckoutMatchesGit(t *testing.T) {
	for _, tc := range checkoutCases {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]testFile{}
			for _, f := range tc.files {
				files[f.path] = testFile{f.mode, f.data}
			}
			dir, err := checkoutFiles(t, files)
			if tc.fails {
				if err == nil {
					t.Fatal("git refuses this checkout, but it succeeded")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := readTree(t, dir)
			for path := range got {
				if strings.HasPrefix(got[path], "-> ") {
					delete(got, path)
				}
			}
			for _, want := range tc.want {
				if got[want.path] != want.data {
					t.Errorf("%s: got %q, want %q", want.path, got[want.path], want.data)
				}
			}
			if len(got) != len(tc.want) {
				t.Errorf("checked out %d files, want %d", len(got), len(tc.want))
			}
		})
	}
}
