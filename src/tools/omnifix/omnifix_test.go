// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

type stubFormatter struct {
	formatterName string
	handlesFunc   func(path string) bool
	formatFunc    func(content string) (string, error)
}

func (s stubFormatter) name() string {
	return s.formatterName
}

func (s stubFormatter) handles(path string) bool {
	return s.handlesFunc(path)
}

func (s stubFormatter) format(_ context.Context, _ string, content string) (string, error) {
	return s.formatFunc(content)
}

func TestFixerComposesMatchingFormattersInOrder(t *testing.T) {
	fixer := newFixer(nil,
		stubFormatter{
			formatterName: "prefix",
			handlesFunc:   func(path string) bool { return strings.HasSuffix(path, ".txt") },
			formatFunc:    func(content string) (string, error) { return "PREFIX: " + content, nil },
		},
		stubFormatter{
			formatterName: "suffix",
			handlesFunc:   func(path string) bool { return strings.HasSuffix(path, ".txt") },
			formatFunc:    func(content string) (string, error) { return content + " :SUFFIX", nil },
		},
		stubFormatter{
			formatterName: "go-only",
			handlesFunc:   func(path string) bool { return strings.HasSuffix(path, ".go") },
			formatFunc:    func(content string) (string, error) { return "wrong: " + content, nil },
		},
	)

	got, err := fixer.formatFile(context.Background(), "file.txt", "content")
	if err != nil {
		t.Fatal(err)
	}
	if want := "PREFIX: content :SUFFIX"; got != want {
		t.Fatalf("formatFile() = %q, want %q", got, want)
	}

	got, err = fixer.formatFile(context.Background(), "file.md", "content")
	if err != nil {
		t.Fatal(err)
	}
	if got != "content" {
		t.Fatalf("unmatched formatFile() = %q, want original content", got)
	}
}

func TestFixerKeepsLastValidResultAfterFormatterFailure(t *testing.T) {
	var stderr bytes.Buffer
	failingRustfmt := newRustFormatter(func(
		_ context.Context,
		_ string,
		_ []string,
		_ string,
	) (string, string, error) {
		return "partial output", "bad Rust", errors.New("exit status 1")
	})
	fixer := newFixer(&stderr, whitespaceFormatter{}, failingRustfmt)

	got, err := fixer.formatFile(context.Background(), "main.rs", "fn main() {}  ")
	if err != nil {
		t.Fatal(err)
	}
	if want := "fn main() {}\n"; got != want {
		t.Fatalf("formatFile() = %q, want %q", got, want)
	}
	if !strings.Contains(stderr.String(), "rustfmt failed for main.rs: bad Rust") {
		t.Fatalf("stderr = %q, want rustfmt diagnostic", stderr.String())
	}
}

func TestFixerReturnsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	formatter := stubFormatter{
		formatterName: "cancelled",
		handlesFunc:   func(string) bool { return true },
		formatFunc:    func(string) (string, error) { return "", errors.New("command stopped") },
	}

	_, err := newFixer(nil, formatter).formatFile(ctx, "file.txt", "content")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("formatFile() error = %v, want context cancellation", err)
	}
}
