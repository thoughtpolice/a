// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"testing"
)

func TestBadLoads(t *testing.T) {
	for _, tc := range []struct {
		name, data string
		want       []badLoad
	}{
		{"root package", `load("//foo/bar.bzl", "x")`, []badLoad{{1, "//foo/bar.bzl"}}},
		{"cell", `load("@cell//foo/bar.bzl", "x")`, []badLoad{{1, "@cell//foo/bar.bzl"}}},
		{"cell root", `load("@cell//bar.bzl", "x")`, []badLoad{{1, "@cell//bar.bzl"}}},
		{"single quotes", `load('//foo/bar.bzl', 'x')`, []badLoad{{1, "//foo/bar.bzl"}}},
		{"spaced", "x = 1\n  load ( \"//foo/bar.bzl\", \"x\")  \n", []badLoad{{2, "//foo/bar.bzl"}}},
		{"split", "load(\n    \"//foo/bar.bzl\",\n    \"x\",\n)\n", []badLoad{{2, "//foo/bar.bzl"}}},
		{"comment", `# load("//foo/bar.bzl", "x")`, []badLoad{{1, "//foo/bar.bzl"}}},
		{"two", `load("//a/b.bzl", "x"); load("//c/d.bzl", "y")`, []badLoad{{1, "//a/b.bzl"}, {1, "//c/d.bzl"}}},
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

func TestLoadProblems(t *testing.T) {
	bad := []byte(`load("@root//buck/shims/shims.bzl", "shims")` + "\n")
	for _, path := range []string{"BUILD", "a/BUCK", "a/PACKAGE", "a/defs.bzl", "a/x.bxl"} {
		got := loadProblems(path, bad)
		want := []problem{{
			Path:    path,
			Line:    1,
			Check:   "load",
			Message: `load("@root//buck/shims/shims.bzl", ...) names a file path; write it as load("@root//buck/shims:shims.bzl", ...)`,
		}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %+v, want %+v", path, got, want)
		}
	}
	// Only Starlark is held to it; a document may show the wrong form.
	for _, path := range []string{"README.md", "a/BUILD.md", "a/defs.bzl.txt"} {
		if got := loadProblems(path, bad); got != nil {
			t.Errorf("%s: got %+v, want nothing", path, got)
		}
	}
}
