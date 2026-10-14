// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"testing"
)

func TestGoFormatter(t *testing.T) {
	var gotName, gotStdin string
	var gotArgs []string
	runner := func(_ context.Context, name string, args []string, stdin string) (string, string, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		gotStdin = stdin
		return "package main\n\nfunc main() {}\n", "", nil
	}
	formatter := newGoFormatter(runner)

	if !formatter.handles("src/main.go") {
		t.Fatal("Go formatter did not handle a Go source file")
	}
	if formatter.handles("src/main.rs") {
		t.Fatal("Go formatter handled a non-Go source file")
	}
	input := "package main\nfunc main(){}"
	got, err := formatter.format(context.Background(), "src/main.go", input)
	if err != nil {
		t.Fatal(err)
	}
	if want := "package main\n\nfunc main() {}\n"; got != want {
		t.Fatalf("format() = %q, want %q", got, want)
	}
	if gotName != "gofmt" || gotStdin != input {
		t.Fatalf("runner got command %q and stdin %q", gotName, gotStdin)
	}
	if len(gotArgs) != 0 {
		t.Fatalf("runner args = %#v, want no arguments", gotArgs)
	}
}
