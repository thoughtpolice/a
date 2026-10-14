// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runTool runs git-fetch against a fake server for want, returning the
// exit status, stderr, and the git dir and work tree.
func runTool(t *testing.T, format *objectFormat, pack []byte, want oid, extra ...string) (int, string, string, string) {
	t.Helper()
	srv := newFakeServer(t, format, pack, want).start()
	out := t.TempDir()
	gitDir, workTree := filepath.Join(out, ".git"), filepath.Join(out, "work")
	var stdout, stderr bytes.Buffer
	args := append([]string{
		"--git-dir=" + gitDir,
		"--work-tree=" + workTree,
		"--repo=" + srv.URL + "/repo",
		"--rev=" + format.hex(want),
		"--object-format=" + format.name,
	}, extra...)
	code := run(args, &stdout, &stderr)
	return code, stderr.String(), gitDir, workTree
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRun(t *testing.T) {
	for _, format := range []*objectFormat{sha1Format, sha256Format} {
		t.Run(format.name, func(t *testing.T) {
			pack, commit := repoPack(format, map[string]testFile{
				"README":  {modeFile, "hello\n"},
				"src/lib": {modeExec, "code\n"},
			})
			code, stderr, gitDir, workTree := runTool(t, format, pack, commit)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, stderr)
			}
			if got := readTree(t, workTree); len(got) != 2 || got["README"] != "hello\n" || got["src/lib"] != "code\n" {
				t.Errorf("work tree %v", got)
			}
			hexID := format.hex(commit)
			if got := readFile(t, filepath.Join(gitDir, "HEAD")); got != hexID+"\n" {
				t.Errorf("HEAD %q", got)
			}
			if got := readFile(t, filepath.Join(gitDir, "shallow")); got != hexID+"\n" {
				t.Errorf("shallow %q", got)
			}
			config := readFile(t, filepath.Join(gitDir, "config"))
			if !strings.Contains(config, "bare = true") ||
				strings.Contains(config, "objectformat") != (format.name == "sha256") {
				t.Errorf("config %q", config)
			}
			packs, _ := filepath.Glob(filepath.Join(gitDir, "objects", "pack", "*"))
			if len(packs) != 2 || !strings.HasSuffix(packs[0], ".idx") || !strings.HasSuffix(packs[1], ".pack") {
				t.Fatalf("packs %v", packs)
			}
			if !bytes.Equal([]byte(readFile(t, packs[1])), pack) {
				t.Error("the stored pack differs from the one fetched")
			}
		})
	}
}

func TestRunPeelsAnnotatedTags(t *testing.T) {
	b := newPackBuilder(sha1Format)
	commit := b.addCommit(b.addTree(map[string]testFile{"a": {modeFile, "a"}}))
	tag := b.addTag(b.addTag(commit, typeCommit), typeTag)
	code, stderr, gitDir, _ := runTool(t, sha1Format, b.bytes(), tag)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := readFile(t, filepath.Join(gitDir, "HEAD")); got != sha1Format.hex(commit)+"\n" {
		t.Errorf("HEAD %q, want the tagged commit", got)
	}
}

func TestRunRefusesNonCommits(t *testing.T) {
	b := newPackBuilder(sha1Format)
	blob := b.add(typeBlob, []byte("a"))
	code, stderr, _, _ := runTool(t, sha1Format, b.bytes(), blob)
	if code != 1 || !strings.Contains(stderr, "is a blob, not a commit") {
		t.Fatalf("exit %d: %s", code, stderr)
	}
}

func TestRunRefusesPacksWithoutTheRev(t *testing.T) {
	pack, _ := testRepo(t, sha1Format)
	code, stderr, _, _ := runTool(t, sha1Format, pack, oid{1, 2, 3})
	if code != 1 || !strings.Contains(stderr, "the pack does not contain 010203") {
		t.Fatalf("exit %d: %s", code, stderr)
	}
}

func TestRunChecksArguments(t *testing.T) {
	dir := t.TempDir()
	nonEmpty := filepath.Join(dir, "full")
	os.MkdirAll(filepath.Join(nonEmpty, "x"), 0o777)
	rev := strings.Repeat("a", 40)
	tests := []struct {
		args []string
		code int
		want string
	}{
		{[]string{"--version"}, 0, ""},
		{[]string{"--git-dir=a"}, 2, "usage:"},
		{[]string{"--bogus"}, 2, "flag provided but not defined"},
		{[]string{"--git-dir=a", "--work-tree=b", "--repo=https://x", "--rev=abc"}, 1, "--rev must be a full sha1 object id (40 hex digits)"},
		{[]string{"--git-dir=a", "--work-tree=b", "--repo=https://x", "--rev=" + rev, "--object-format=sha256"}, 1, "64 hex digits"},
		{[]string{"--git-dir=a", "--work-tree=b", "--repo=https://x", "--rev=" + strings.Repeat("g", 40)}, 1, "--rev must be"},
		{[]string{"--git-dir=a", "--work-tree=b", "--repo=https://x", "--rev=" + rev, "--object-format=md5"}, 1, "sha1 or sha256"},
		{[]string{"--git-dir=" + nonEmpty, "--work-tree=b", "--repo=https://x", "--rev=" + rev}, 1, "is not empty"},
		{[]string{"--git-dir=a", "--work-tree=b", "--repo=ssh://x/y", "--rev=" + rev}, 1, "not an http or https URL"},
	}
	for _, tt := range tests {
		var stdout, stderr bytes.Buffer
		code := run(tt.args, &stdout, &stderr)
		if code != tt.code || !strings.Contains(stderr.String(), tt.want) {
			t.Errorf("%q: exit %d, stderr %q; want exit %d and %q", tt.args, code, stderr.String(), tt.code, tt.want)
		}
		if tt.args[0] == "--version" && stdout.String() != "git-fetch "+version+"\n" {
			t.Errorf("--version printed %q", stdout.String())
		}
	}
}
