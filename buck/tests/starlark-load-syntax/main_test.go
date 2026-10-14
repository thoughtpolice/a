// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestBadLoads(t *testing.T) {
	for _, tc := range []struct {
		name, data string
		want       []badLoad
	}{
		{"root package", `load("//foo/bar.bzl", "x")`, []badLoad{{1, `load("//foo/bar.bzl", "x")`, "//foo/bar.bzl"}}},
		{"cell", `load("@cell//foo/bar.bzl", "x")`, []badLoad{{1, `load("@cell//foo/bar.bzl", "x")`, "@cell//foo/bar.bzl"}}},
		{"cell root", `load("@cell//bar.bzl", "x")`, []badLoad{{1, `load("@cell//bar.bzl", "x")`, "@cell//bar.bzl"}}},
		{"single quotes", `load('//foo/bar.bzl', 'x')`, []badLoad{{1, `load('//foo/bar.bzl', 'x')`, "//foo/bar.bzl"}}},
		{"spaced", "x = 1\n  load ( \"//foo/bar.bzl\", \"x\")  \n", []badLoad{{2, `load ( "//foo/bar.bzl", "x")`, "//foo/bar.bzl"}}},
		{"split", "load(\n    \"//foo/bar.bzl\",\n    \"x\",\n)\n", []badLoad{{2, `"//foo/bar.bzl",`, "//foo/bar.bzl"}}},
		{"comment", `# load("//foo/bar.bzl", "x")`, []badLoad{{1, `# load("//foo/bar.bzl", "x")`, "//foo/bar.bzl"}}},
		{"two", `load("//a/b.bzl", "x"); load("//c/d.bzl", "y")`, []badLoad{
			{1, `load("//a/b.bzl", "x"); load("//c/d.bzl", "y")`, "//a/b.bzl"},
			{1, `load("//a/b.bzl", "x"); load("//c/d.bzl", "y")`, "//c/d.bzl"},
		}},
		{"target", `load("//foo:bar.bzl", "x")`, nil},
		{"cell target", `load("@cell//:bar.bzl", "x")`, nil},
		{"relative", `load(":defs.bzl", "x")`, nil},
		{"not bzl", `load("//foo/bar.star", "x")`, nil},
		{"no load", `export_file(name = "//foo/bar.bzl")`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := badLoads([]byte(tc.data)); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCorrected(t *testing.T) {
	for path, want := range map[string]string{
		"//foo/bar.bzl":         "//foo:bar.bzl",
		"//foo/baz/bar.bzl":     "//foo/baz:bar.bzl",
		"//bar.bzl":             "//:bar.bzl",
		"@cell//foo/bar.bzl":    "@cell//foo:bar.bzl",
		"@cell//bar.bzl":        "@cell//:bar.bzl",
		"cell//a/b/c/d/bar.bzl": "cell//a/b/c/d:bar.bzl",
	} {
		if got := corrected(path); got != want {
			t.Errorf("corrected(%q) = %q, want %q", path, got, want)
		}
	}
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, data := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStarlarkFiles(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"BUILD":                   "",
		"PACKAGE":                 "",
		"defs.bzl":                "",
		"src/a/BUILD":             "",
		"src/a/rules.bzl":         "",
		"src/a/README.md":         "",
		"src/a/BUILD.bazel":       "",
		"src/network/BUILD":       "",
		"src/work/BUILD":          "",
		"src/buck-out/BUILD":      "",
		"src/.hidden/BUILD":       "",
		"src/.dot.bzl":            "",
		".github/BUILD":           "",
		"work/ws/BUILD":           "",
		"buck-out/v2/gen/x.bzl":   "",
		"tilde/.buckconfig":       "",
		"tilde/aseipp/BUILD":      "",
		"src/rules.bzl/README.md": "",
	})
	if err := os.Symlink("BUILD", filepath.Join(root, "src", "a", "link.bzl")); err != nil {
		t.Fatal(err)
	}
	got, err := starlarkFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"BUILD",
		"PACKAGE",
		"defs.bzl",
		"src/a/BUILD",
		"src/a/rules.bzl",
		"src/buck-out/BUILD",
		"src/network/BUILD",
		"src/work/BUILD",
		"tilde/aseipp/BUILD",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func runTool(t *testing.T) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(&stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRun(t *testing.T) {
	t.Setenv("BUILD_WORKSPACE_DIRECTORY", "")
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		".buckroot":      "",
		"BUILD":          `load("//rules:defs.bzl", "x")`,
		"rules/defs.bzl": `load("@prelude//:rules.bzl", "y")`,
		"sub/dir/notes":  "",
	})
	t.Chdir(filepath.Join(root, "sub", "dir"))
	if code, stdout, stderr := runTool(t); code != 0 || stdout != "✓ All 2 files use correct load() syntax\n" {
		t.Errorf("exit %d\n%s%s", code, stdout, stderr)
	}

	writeFiles(t, root, map[string]string{"pkg/BUILD": "load(\"//rules/defs.bzl\", \"x\")\n"})
	code, stdout, stderr := runTool(t)
	if code != 1 {
		t.Errorf("exit %d\n%s%s", code, stdout, stderr)
	}
	for _, want := range []string{
		"Found 1 files with incorrect load() syntax:",
		"\npkg/BUILD:\n",
		`  Line 1: load("//rules/defs.bzl", "x")`,
		`    Found: load("//rules/defs.bzl", ...)`,
		`    Should be: load("//rules:defs.bzl", ...)`,
		"Total files checked: 3",
		"Files with errors: 1",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("output lacks %q:\n%s", want, stdout)
		}
	}

	// BUILD_WORKSPACE_DIRECTORY names the root without a .buckroot.
	t.Chdir("/")
	if code, _, stderr := runTool(t); code != 1 || !strings.Contains(stderr, "no .buckroot") {
		t.Errorf("outside the repository: exit %d\n%s", code, stderr)
	}
	t.Setenv("BUILD_WORKSPACE_DIRECTORY", root)
	if code, stdout, _ := runTool(t); code != 1 || !strings.Contains(stdout, "Total files checked: 3") {
		t.Errorf("BUILD_WORKSPACE_DIRECTORY: exit %d\n%s", code, stdout)
	}
}
