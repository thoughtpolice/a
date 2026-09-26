// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
)

type recordingRunner struct {
	spec   commandSpec
	stdout string
}

func (runner *recordingRunner) run(_ context.Context, spec commandSpec) (processResult, error) {
	runner.spec = spec
	return processResult{stdout: []byte(runner.stdout)}, nil
}

// Discovery runs from the caller's directory and lets jj search upward. -R
// names a workspace root exactly, so with it discovery failed from every
// subdirectory of the repository, which is where a caller usually is.
func TestVCSDiscoveryRunsFromTheStartDirectoryWithoutR(t *testing.T) {
	root := t.TempDir()
	runner := &recordingRunner{stdout: root + "\n"}
	start := root + "/src/pkg"
	jj, err := discoverJJ(context.Background(), runner, "jj", start)
	if err != nil {
		t.Fatal(err)
	}
	if jj.repository != root {
		t.Fatalf("repository = %q, want %q", jj.repository, root)
	}
	if runner.spec.dir != start {
		t.Fatalf("dir = %q, want the start directory %q", runner.spec.dir, start)
	}
	if slices.Contains(runner.spec.args, "-R") {
		t.Fatalf("args = %q, want no -R", runner.spec.args)
	}
}

// Port of vcs.rs::parses_one_revision.
func TestVCSParsesOneRevision(t *testing.T) {
	revision, err := parseSingleRevision([]byte("0123456789abcdef\n"), "mine")
	if err != nil {
		t.Fatal(err)
	}
	if revision != "0123456789abcdef" {
		t.Fatalf("revision = %q", revision)
	}
}

// Port of vcs.rs::single_revision_parser_requires_exactly_one.
func TestVCSSingleRevisionParserRequiresExactlyOne(t *testing.T) {
	for name, output := range map[string][]byte{
		"none": {},
		"many": []byte("abcd\nef01\n"),
		"bad":  []byte("not-a-commit\n"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseSingleRevision(output, name); err == nil {
				t.Fatalf("accepted %q", output)
			}
		})
	}
}

// Port of vcs.rs::parses_changed_paths_and_spaces.
func TestVCSParsesChangedPathsAndSpaces(t *testing.T) {
	input := []byte(`{"status":"modified","source":"src/lib.rs","target":"src/lib.rs"}
{"status":"added","source":"a directory/a file.txt","target":"a directory/a file.txt"}
`)
	paths, err := parseChangedPaths(input)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a directory/a file.txt", "src/lib.rs"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %q, want %q", paths, want)
	}
	empty, err := parseChangedPaths(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("empty diff = %q", empty)
	}
}

// Port of vcs.rs::rename_includes_both_endpoints.
func TestVCSRenameIncludesBothEndpoints(t *testing.T) {
	input := []byte(`{"status":"renamed","source":"old/name.rs","target":"new/name.rs"}
`)
	paths, err := parseChangedPaths(input)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"new/name.rs", "old/name.rs"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %q, want %q", paths, want)
	}
}

// Port of vcs.rs::changed_path_parser_fails_closed.
func TestVCSChangedPathParserFailsClosed(t *testing.T) {
	badInputs := [][]byte{
		[]byte("not json\n"),
		[]byte("{\"status\":\"weird\",\"source\":\"a\",\"target\":\"b\"}\n"),
		[]byte("{\"status\":\"added\",\"source\":\"/absolute\",\"target\":\"/absolute\"}\n"),
		[]byte("{\"status\":\"added\",\"source\":\"../escape\",\"target\":\"../escape\"}\n"),
		[]byte("{\"status\":\"added\",\"source\":\"a/./b\",\"target\":\"a/./b\"}\n"),
		[]byte("{\"status\":\"added\",\"source\":\"a//b\",\"target\":\"a//b\"}\n"),
		[]byte("{\"status\":\"added\",\"source\":\"windows\\\\path\",\"target\":\"windows\\\\path\"}\n"),
		append([]byte("not-utf8-"), 0xff, '\n'),
	}
	for index, bad := range badInputs {
		if _, err := parseChangedPaths(bad); err == nil {
			t.Fatalf("case %d accepted %q", index, bad)
		}
	}
}

// Port of vcs.rs::workspace_root_must_be_one_absolute_path.
func TestVCSWorkspaceRootMustBeOneAbsolutePath(t *testing.T) {
	expected := "/repo"
	if runtime.GOOS == "windows" {
		expected = `C:\repo`
	}
	parsed, err := parseWorkspaceRoot([]byte(expected + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if parsed != expected {
		t.Fatalf("root = %q, want %q", parsed, expected)
	}
	if _, err := parseWorkspaceRoot([]byte("relative/path\n")); err == nil {
		t.Fatal("accepted relative workspace root")
	}
	if _, err := parseWorkspaceRoot([]byte("/one\n/two\n")); err == nil || !strings.Contains(err.Error(), "malformed") {
		t.Fatalf("multi-root error = %v", err)
	}
}
