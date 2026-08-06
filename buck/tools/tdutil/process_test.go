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

// A `--keep-going` run over a broken graph can report a diagnostic per
// package, so stderr is bounded. buck2 reports the failure that actually
// stopped it last, which is why the tail is what survives.
func TestBoundedBufferKeepsTheTailAndSaysWhatItDropped(t *testing.T) {
	buffer := boundedBuffer{limit: 8}
	for _, chunk := range []string{"abc", "def", "ghij"} {
		written, err := buffer.Write([]byte(chunk))
		if err != nil || written != len(chunk) {
			t.Fatalf("Write(%q) = %d, %v", chunk, written, err)
		}
	}
	contents := string(buffer.Bytes())
	if !strings.HasSuffix(contents, "cdefghij") {
		t.Fatalf("contents = %q, want the last eight bytes", contents)
	}
	if !strings.HasPrefix(contents, "[2 earlier byte(s) elided]\n") {
		t.Fatalf("contents = %q, want an elision notice", contents)
	}

	// A single write larger than the whole limit is truncated the same way.
	buffer = boundedBuffer{limit: 4}
	if _, err := buffer.Write([]byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	if contents := string(buffer.Bytes()); !strings.HasSuffix(contents, "6789") {
		t.Fatalf("contents = %q", contents)
	}

	// Below the limit nothing is elided and no notice is invented.
	buffer = boundedBuffer{limit: 16}
	if _, err := buffer.Write([]byte("short\n")); err != nil {
		t.Fatal(err)
	}
	if contents := string(buffer.Bytes()); contents != "short\n" {
		t.Fatalf("contents = %q", contents)
	}
}

const processStderrFloodEnvironment = "TDUTIL_PROCESS_STDERR_FLOOD_HELPER"

// The retained stderr must stay bounded no matter how much the child writes,
// and the run must still complete normally.
func TestProcessRunnerBoundsChildStderr(t *testing.T) {
	if os.Getenv(processStderrFloodEnvironment) == "1" {
		noise := strings.Repeat("x", 64*1024)
		for index := 0; index < 64; index++ {
			_, _ = os.Stderr.WriteString(noise)
		}
		_, _ = os.Stderr.WriteString("\nthe failure that mattered\n")
		os.Exit(7)
	}
	t.Setenv(processStderrFloodEnvironment, "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	result, err := (osProcessRunner{}).run(context.Background(), commandSpec{
		path: executable,
		args: []string{"-test.run=^TestProcessRunnerBoundsChildStderr$"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.exitCode != 7 {
		t.Fatalf("exit code = %d", result.exitCode)
	}
	if len(result.stderr) > stderrLimit+128 {
		t.Fatalf("retained %d stderr bytes, want at most the limit plus its notice", len(result.stderr))
	}
	if !strings.HasSuffix(string(result.stderr), "the failure that mattered\n") {
		t.Fatal("the tail of stderr was dropped")
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
