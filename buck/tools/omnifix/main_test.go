// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestRealMain(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := realMain(
		context.Background(),
		[]string{"README.md"},
		strings.NewReader("hello  "),
		&stdout,
		&stderr,
	)

	if exitCode != 0 {
		t.Fatalf("realMain() = %d, stderr = %q", exitCode, stderr.String())
	}
	if want := "hello\n"; stdout.String() != want {
		t.Fatalf("stdout = %q, want %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want no output", stderr.String())
	}
}

func TestRealMainRequiresPath(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := realMain(context.Background(), nil, strings.NewReader("input"), &stdout, &stderr)

	if exitCode != 1 {
		t.Fatalf("realMain() = %d, want 1", exitCode)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want no output", stdout.String())
	}
	if !strings.Contains(stderr.String(), "No file path provided") {
		t.Fatalf("stderr = %q, want missing-path error", stderr.String())
	}
}
