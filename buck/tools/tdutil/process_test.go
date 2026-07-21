// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

const processCancellationHelperEnvironment = "TDUTIL_PROCESS_CANCELLATION_HELPER"

func TestProcessRunnerCancellation(t *testing.T) {
	if os.Getenv(processCancellationHelperEnvironment) == "1" {
		for {
			time.Sleep(time.Hour)
		}
	}
	t.Setenv(processCancellationHelperEnvironment, "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = (osProcessRunner{}).run(ctx, commandSpec{
		path: executable,
		args: []string{"-test.run=^TestProcessRunnerCancellation$"},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline exceeded", err)
	}
}

const processStreamHelperEnvironment = "TDUTIL_PROCESS_STREAM_HELPER"

// The helper brackets its payload in markers because the testing framework may
// write its own lines to stdout (for example under -test.v) before the helper
// branch runs.
func TestProcessRunnerStreamsLinesAndReportsExitStatus(t *testing.T) {
	if os.Getenv(processStreamHelperEnvironment) == "1" {
		_, _ = os.Stdout.WriteString("tdutil-stream-begin\none\n\ntwo\ntdutil-stream-end")
		_, _ = os.Stderr.WriteString("stream warning\n")
		os.Exit(3)
	}
	t.Setenv(processStreamHelperEnvironment, "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	result, err := (osProcessRunner{}).runLines(context.Background(), commandSpec{
		path: executable,
		args: []string{"-test.run=^TestProcessRunnerStreamsLinesAndReportsExitStatus$"},
	}, func(line []byte) { lines = append(lines, string(line)) })
	if err != nil {
		t.Fatal(err)
	}
	begin := slices.Index(lines, "tdutil-stream-begin")
	end := slices.Index(lines, "tdutil-stream-end")
	if begin < 0 || end != len(lines)-1 {
		t.Fatalf("lines = %#v", lines)
	}
	if payload := lines[begin+1 : end]; !slices.Equal(payload, []string{"one", "", "two"}) {
		t.Fatalf("payload = %#v", payload)
	}
	if result.exitCode != 3 || result.signaled {
		t.Fatalf("status = %d signaled=%v", result.exitCode, result.signaled)
	}
	if !strings.Contains(string(result.stderr), "stream warning") {
		t.Fatalf("stderr = %q", result.stderr)
	}
	if len(result.stdout) != 0 {
		t.Fatalf("streamed stdout was also buffered: %q", result.stdout)
	}
}

func TestProcessRunnerStreamCancellation(t *testing.T) {
	if os.Getenv(processCancellationHelperEnvironment) == "1" {
		for {
			time.Sleep(time.Hour)
		}
	}
	t.Setenv(processCancellationHelperEnvironment, "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = (osProcessRunner{}).runLines(ctx, commandSpec{
		path: executable,
		args: []string{"-test.run=^TestProcessRunnerStreamCancellation$"},
	}, func([]byte) {})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline exceeded", err)
	}
}
