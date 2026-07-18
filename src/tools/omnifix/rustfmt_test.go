// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestRustFormatter(t *testing.T) {
	var gotName, gotStdin string
	var gotArgs []string
	runner := func(_ context.Context, name string, args []string, stdin string) (string, string, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		gotStdin = stdin
		return "fn main() {}\n", "", nil
	}
	formatter := newRustFormatter(runner)

	if !formatter.handles("src/main.rs") || formatter.handles("src/main.go") {
		t.Fatal("Rust formatter file matching is incorrect")
	}
	input := "fn main(){}"
	got, err := formatter.format(context.Background(), "src/main.rs", input)
	if err != nil {
		t.Fatal(err)
	}
	if want := "fn main() {}\n"; got != want {
		t.Fatalf("format() = %q, want %q", got, want)
	}
	if gotName != "rustfmt" || gotStdin != input {
		t.Fatalf("runner got command %q and stdin %q", gotName, gotStdin)
	}
	wantArgs := []string{"--emit=stdout", "--edition=2024"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("runner args = %#v, want %#v", gotArgs, wantArgs)
	}
}

func TestRustFormatterReportsCommandFailure(t *testing.T) {
	runner := func(_ context.Context, _ string, _ []string, _ string) (string, string, error) {
		return "partial output", "parse error\n", errors.New("exit status 1")
	}
	formatter := newRustFormatter(runner)

	got, err := formatter.format(context.Background(), "broken.rs", "not valid Rust\n")
	if err == nil {
		t.Fatal("format() succeeded, want rustfmt error")
	}
	if got != "" {
		t.Fatalf("format() = %q, want no partial output", got)
	}
	if message := err.Error(); !strings.Contains(message, "parse error") || !strings.Contains(message, "exit status 1") {
		t.Fatalf("error = %q, want stderr and exit status", message)
	}
}
