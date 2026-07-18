// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"reflect"
	"testing"
)

func TestBuildifierMatchesStarlarkFiles(t *testing.T) {
	formatter := newBuildifierFormatter(nil)
	tests := []struct {
		path string
		want bool
	}{
		{path: "src/tools/omnifix/BUILD", want: true},
		{path: "src/protos/BUCK", want: true},
		{path: "rules/defs.bzl", want: true},
		{path: "buck/tools/query.bxl", want: true},
		{path: "MODULE.bazel", want: true},
		{path: "WORKSPACE.bazel", want: true},
		{path: "README.md", want: false},
		{path: "build.go", want: false},
	}

	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			if got := formatter.handles(test.path); got != test.want {
				t.Fatalf("handles(%q) = %t, want %t", test.path, got, test.want)
			}
		})
	}
}

func TestBuildifierFormatter(t *testing.T) {
	var gotName, gotStdin string
	var gotArgs []string
	runner := func(_ context.Context, name string, args []string, stdin string) (string, string, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		gotStdin = stdin
		return "load(\"//rules:defs.bzl\", \"rule\")\n", "", nil
	}
	formatter := newBuildifierFormatter(runner)
	input := "load(\"//rules:defs.bzl\",\"rule\")"

	got, err := formatter.format(context.Background(), `rules\defs.bzl`, input)
	if err != nil {
		t.Fatal(err)
	}
	if want := "load(\"//rules:defs.bzl\", \"rule\")\n"; got != want {
		t.Fatalf("format() = %q, want %q", got, want)
	}
	if gotName != buildifierCommand || gotStdin != input {
		t.Fatalf("runner got command %q and stdin %q", gotName, gotStdin)
	}
	if want := []string{"-path=rules/defs.bzl"}; !reflect.DeepEqual(gotArgs, want) {
		t.Fatalf("runner args = %#v, want %#v", gotArgs, want)
	}
}
