// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDenoFormatter(t *testing.T) {
	var gotName, gotStdin string
	var gotArgs []string
	runner := func(_ context.Context, name string, args []string, stdin string) (string, string, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		gotStdin = stdin
		return "const x = { a: 1 };\n", "", nil
	}
	formatter := newDenoFormatter(runner)

	input := "const  x = {a:1}\n"
	got, err := formatter.format(context.Background(), "src/app/Main.TSX", input)
	if err != nil {
		t.Fatal(err)
	}
	if want := "const x = { a: 1 };\n"; got != want {
		t.Fatalf("format() = %q, want %q", got, want)
	}
	if gotName != "buck/bin/deno" || gotStdin != input {
		t.Fatalf("runner got command %q and stdin %q", gotName, gotStdin)
	}
	wantArgs := []string{"fmt", "--ext", "tsx", "-"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("runner args = %#v, want %#v", gotArgs, wantArgs)
	}
}

func TestDenoFormatterMatching(t *testing.T) {
	formatter := newDenoFormatter(nil)
	for _, path := range []string{"a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", `dir\a.cjs`} {
		if !formatter.handles(path) {
			t.Errorf("handles(%q) = false, want true", path)
		}
	}
	for _, path := range []string{"a.json", "a.jsonc", "a.d", "ts", "a.rs", "a.go"} {
		if formatter.handles(path) {
			t.Errorf("handles(%q) = true, want false", path)
		}
	}
}

func TestDenoFormatterReportsCommandFailure(t *testing.T) {
	runner := func(_ context.Context, _ string, _ []string, _ string) (string, string, error) {
		return "", "error: Expected ';', '}' or <eof>\n", errors.New("exit status 1")
	}
	formatter := newDenoFormatter(runner)

	got, err := formatter.format(context.Background(), "broken.ts", "const = ;\n")
	if err == nil {
		t.Fatal("format() succeeded, want deno fmt error")
	}
	if got != "" {
		t.Fatalf("format() = %q, want no partial output", got)
	}
	if message := err.Error(); !strings.Contains(message, "Expected") || !strings.Contains(message, "exit status 1") {
		t.Fatalf("error = %q, want stderr and exit status", message)
	}
}
