// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These tests exercise bounded capture at both its streaming writer boundary
// and the real os/exec pipe boundary. The test executable acts as a noisy child,
// requiring no installed Buck/tdutil and producing no repository mutations.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBoundedCommandOutput(t *testing.T) {
	t.Parallel()
	for _, limit := range []int{0, 1, 64, 1024} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			output := boundedCommandOutput{limit: limit}
			full := bytes.Repeat([]byte("a"), limit)
			if n, err := output.Write(full); n != len(full) || err != nil {
				t.Fatalf("full write = %d, %v", n, err)
			}
			if output.truncated || !bytes.Equal(output.contents, full) {
				t.Fatal("exactly-full output was not preserved")
			}
			for range 3 {
				if n, err := output.Write([]byte("discarded")); n != 9 || err != nil {
					t.Fatalf("overflow write = %d, %v; must continue draining", n, err)
				}
			}
			if !output.truncated || len(output.contents) != limit || len(output.diagnostic()) > limit {
				t.Fatalf("capture = %+v", output)
			}
			if limit >= len(outputTruncatedMarker) && !bytes.HasSuffix(output.diagnostic(), []byte(outputTruncatedMarker)) {
				t.Fatal("missing diagnostic truncation marker")
			}
		})
	}
}

// TestCommandOutputChild is normally a no-op. A selected child invocation emits
// exact byte counts, concurrently on stdout/stderr, then exits without Go's
// ordinary PASS output so the parent can verify byte-for-byte capture.
func TestCommandOutputChild(t *testing.T) {
	separator := -1
	for index, arg := range os.Args {
		if arg == "--orchestra-output-child" {
			separator = index
			break
		}
	}
	if separator < 0 {
		return
	}
	args := os.Args[separator+1:]
	if len(args) != 4 {
		os.Exit(80)
	}
	stdoutCount, err := strconv.Atoi(args[1])
	if err != nil {
		os.Exit(81)
	}
	stderrCount, err := strconv.Atoi(args[2])
	if err != nil {
		os.Exit(82)
	}
	exitCode, err := strconv.Atoi(args[3])
	if err != nil {
		os.Exit(83)
	}
	write := func(writer io.Writer, value byte, count int) {
		chunk := bytes.Repeat([]byte{value}, 8<<10)
		for count > 0 {
			next := min(count, len(chunk))
			written, writeErr := writer.Write(chunk[:next])
			if writeErr != nil || written != next {
				os.Exit(84)
			}
			count -= next
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		write(os.Stderr, 'e', stderrCount)
	}()
	switch args[0] {
	case "json":
		fmt.Fprint(os.Stdout, `{"complete":true}`)
	case "json-padding":
		fmt.Fprint(os.Stdout, `{"complete":true}`)
		write(os.Stdout, ' ', stdoutCount)
	default:
		write(os.Stdout, 'o', stdoutCount)
	}
	<-done
	if args[0] == "wait" {
		time.Sleep(time.Hour)
	}
	os.Exit(exitCode)
}

func commandOutputChild(t *testing.T, mode string, stdoutCount, stderrCount, exitCode int) (string, []string) {
	t.Helper()
	command, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return command, []string{
		"-test.run=^TestCommandOutputChild$", "--", "--orchestra-output-child",
		mode, strconv.Itoa(stdoutCount), strconv.Itoa(stderrCount), strconv.Itoa(exitCode),
	}
}

func TestBuckCommandBoundsBothDiagnosticStreams(t *testing.T) {
	t.Parallel()
	for _, exitCode := range []int{0, 32} {
		t.Run(strconv.Itoa(exitCode), func(t *testing.T) {
			command, args := commandOutputChild(t, "streams", commandDiagnosticLimit*3, commandDiagnosticLimit*4, exitCode)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			stdout, stderr, err := runBuckCommand(ctx, command, args, "")
			if exitCode == 0 && err != nil {
				t.Fatal(err)
			}
			if exitCode != 0 {
				var exited *exec.ExitError
				if !errors.As(err, &exited) || exited.ExitCode() != exitCode {
					t.Fatalf("exit error = %v", err)
				}
			}
			for name, contents := range map[string][]byte{"stdout": stdout, "stderr": stderr} {
				if len(contents) != commandDiagnosticLimit || !bytes.HasSuffix(contents, []byte(outputTruncatedMarker)) {
					t.Fatalf("%s capture length = %d; missing bound or marker", name, len(contents))
				}
			}
		})
	}
}

func TestTDUtilCommandPreservesJSONDespiteNoisyDiagnostics(t *testing.T) {
	t.Parallel()
	command, args := commandOutputChild(t, "json", 0, commandDiagnosticLimit*3, 0)
	stdout, stderr, err := runTDUtilCommand(context.Background(), command, args, "")
	if err != nil || string(stdout) != `{"complete":true}` {
		t.Fatalf("stdout = %q; error = %v", stdout, err)
	}
	if len(stderr) != commandDiagnosticLimit || !bytes.HasSuffix(stderr, []byte(outputTruncatedMarker)) {
		t.Fatal("stderr exceeded its bound or lacked the truncation marker")
	}
}

func TestTDUtilCommandRejectsOversizedJSON(t *testing.T) {
	t.Parallel()
	// The retained prefix is itself valid JSON followed by whitespace. Merely
	// truncating and then parsing would silently accept this incomplete output.
	command, args := commandOutputChild(t, "json-padding", tdutilJSONLimit, commandDiagnosticLimit*3, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	stdout, stderr, err := runTDUtilCommand(ctx, command, args, "")
	if stdout != nil || !errors.Is(err, errCommandOutputLimit) || !strings.Contains(err.Error(), strconv.Itoa(tdutilJSONLimit)) {
		t.Fatalf("stdout length = %d; error = %v", len(stdout), err)
	}
	if len(stderr) > commandDiagnosticLimit {
		t.Fatalf("stderr length = %d", len(stderr))
	}
}

func TestCompleteCommandOutputLimitBoundaries(t *testing.T) {
	t.Parallel()
	for _, extra := range []int{0, 1} {
		t.Run(strconv.Itoa(extra), func(t *testing.T) {
			command, args := commandOutputChild(t, "streams", 1024+extra, 0, 0)
			stdout, _, err := runCapturedCommand(context.Background(), command, args, "", 1024, true)
			if extra == 0 {
				if err != nil || !bytes.Equal(stdout, bytes.Repeat([]byte("o"), 1024)) {
					t.Fatalf("exact-cap stdout = %d bytes; error = %v", len(stdout), err)
				}
			} else if stdout != nil || !errors.Is(err, errCommandOutputLimit) {
				t.Fatalf("overflow stdout = %d bytes; error = %v", len(stdout), err)
			}
		})
	}
}

func TestCapturedCommandPreservesDirectoryAndCancellation(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	// Buck's generated Go test main deliberately changes to its package root.
	// Use a plain child here so test-runner initialization cannot mask Cmd.Dir.
	stdout, _, err := runBuckCommand(context.Background(), "sh", []string{"-c", "pwd"}, directory)
	if err != nil || strings.TrimSpace(string(stdout)) != directory {
		t.Fatalf("working directory = %q; error = %v", stdout, err)
	}
	command, args := commandOutputChild(t, "wait", commandDiagnosticLimit*3, commandDiagnosticLimit*3, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	stdout, stderr, err := runBuckCommand(ctx, command, args, "")
	if err == nil || ctx.Err() == nil || time.Since(started) > 2*time.Second {
		t.Fatalf("canceled command returned after %v: %v", time.Since(started), err)
	}
	if len(stdout) > commandDiagnosticLimit || len(stderr) > commandDiagnosticLimit {
		t.Fatal("canceled command exceeded capture limits")
	}
}

func TestBuckDiagnosticTruncationPreservesTestEvidence(t *testing.T) {
	t.Parallel()
	command, childArgs := commandOutputChild(t, "streams", commandDiagnosticLimit*3, commandDiagnosticLimit*3, 0)
	executor := buckTestExecutor{
		command: command, mode: "local", hostPlatform: "linux-x86_64", timeout: 10 * time.Second,
		runCommand: func(ctx context.Context, executable string, args []string, directory string) ([]byte, []byte, error) {
			writeBuckEvents(t, argumentAfter(t, args, "--event-log"),
				buckResultLine(t, "root//pkg", "test", 2, 1000),
				buckEndLine(t, 32),
			)
			return runBuckCommand(ctx, executable, childArgs, directory)
		},
	}
	results, err := executor.Execute(context.Background(), job{
		Kind: "run_tests", Platform: "linux-x86_64",
		Tests: []plannedTest{{ID: "test", Label: "root//pkg:test"}},
	}, io.Discard)
	if err != nil || len(results) != 1 || results[0].Outcome != "fail" {
		t.Fatalf("test evidence = %+v; error = %v", results, err)
	}
}
