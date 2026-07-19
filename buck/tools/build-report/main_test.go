// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFixtureFile(t *testing.T, fixture string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "report.json")
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func runMain(t *testing.T, stdin string, args ...string) (int, string, string) {
	t.Helper()
	t.Setenv("NO_COLOR", "1")
	var stdout, stderr strings.Builder
	code := realMain(args, strings.NewReader(stdin), &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestMainSuccessReport(t *testing.T) {
	path := writeFixtureFile(t, fixtureSuccessBuild)
	code, stdout, stderr := runMain(t, "", path)
	if code != 0 {
		t.Fatalf("exit = %d, stderr: %s", code, stderr)
	}
	if !strings.Contains(stdout, "✓ SUCCESS") {
		t.Errorf("stdout:\n%s", stdout)
	}
}

func TestMainFailedBuildExitsOne(t *testing.T) {
	path := writeFixtureFile(t, fixtureActionFailure)
	code, stdout, _ := runMain(t, "", path)
	if code != 1 {
		t.Fatalf("exit = %d, want 1 for a failed build", code)
	}
	if !strings.Contains(stdout, "✗ FAILED") {
		t.Errorf("stdout:\n%s", stdout)
	}
}

func TestMainReadsStdin(t *testing.T) {
	code, stdout, stderr := runMain(t, fixtureSuccessBuild, "-")
	if code != 0 {
		t.Fatalf("exit = %d, stderr: %s", code, stderr)
	}
	if !strings.Contains(stdout, "✓ SUCCESS") {
		t.Errorf("stdout:\n%s", stdout)
	}
}

func TestMainJSONRoundTrip(t *testing.T) {
	rawPath := writeFixtureFile(t, fixtureActionFailure)
	processedPath := filepath.Join(t.TempDir(), "processed.json")

	code, stdout, stderr := runMain(t, "", "--format", "json", "--output", processedPath, rawPath)
	if code != 1 {
		t.Fatalf("exit = %d, stderr: %s", code, stderr)
	}
	if !strings.Contains(stdout, "Report written to "+processedPath) {
		t.Errorf("stdout:\n%s", stdout)
	}

	// Rendering the processed report must match rendering the raw one.
	directCode, directOut, _ := runMain(t, "", rawPath)
	processedCode, processedOut, _ := runMain(t, "", processedPath)
	if directCode != processedCode || directOut != processedOut {
		t.Errorf("processed rendering diverged from raw rendering:\n--- raw ---\n%s\n--- processed ---\n%s",
			directOut, processedOut)
	}
}

func TestMainMarkdownFormat(t *testing.T) {
	path := writeFixtureFile(t, fixtureSuccessBuild)
	code, stdout, _ := runMain(t, "", "--format", "markdown", path)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout, "# Buck2 Build Report") {
		t.Errorf("stdout:\n%s", stdout)
	}
}

func TestMainHelp(t *testing.T) {
	code, stdout, _ := runMain(t, "", "--help")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout, "USAGE:") {
		t.Errorf("stdout:\n%s", stdout)
	}
}

func TestMainUsageErrors(t *testing.T) {
	valid := writeFixtureFile(t, fixtureSuccessBuild)
	cases := []struct {
		name string
		args []string
	}{
		{"no arguments", nil},
		{"two inputs", []string{valid, valid}},
		{"unknown flag", []string{"--bogus", valid}},
		{"unknown format", []string{"--format", "yaml", valid}},
		{"unreadable file", []string{filepath.Join(t.TempDir(), "absent.json")}},
		{"invalid json", []string{writeFixtureFile(t, "not json")}},
		{"v1 processed report", []string{writeFixtureFile(t, `{"format_version": "1.0.0"}`)}},
	}
	for _, item := range cases {
		code, _, stderr := runMain(t, "", item.args...)
		if code != 2 {
			t.Errorf("%s: exit = %d, want 2 (stderr: %s)", item.name, code, stderr)
		}
		if stderr == "" {
			t.Errorf("%s: expected an error message on stderr", item.name)
		}
	}
}
