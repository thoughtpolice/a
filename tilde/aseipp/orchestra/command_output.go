// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This module bounds the agent's subprocess-output memory while preserving the
// distinction between diagnostics and evidence. Buck's stdout/stderr are only
// diagnostics: authoritative test events live in its separate event-log file.
// tdutil's stdout is a complete JSON document and must fail, never silently
// truncate, when it exceeds its explicit limit. Both streams continue draining
// after their capture limits so a noisy child cannot deadlock on a full pipe.
package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

const (
	// Retain a bounded prefix of each diagnostic stream, including its marker.
	commandDiagnosticLimit = 64 << 10
	// The raw affected-target document includes non-tests and can be larger
	// than Orchestra's final eight-MiB artifact. Bound it independently.
	tdutilJSONLimit       = 64 << 20
	outputTruncatedMarker = "\n[... subprocess output truncated ...]\n"
)

// errCommandOutputLimit distinguishes incomplete machine-readable output from
// a child-process failure, including when the child itself exited successfully.
var errCommandOutputLimit = errors.New("subprocess output limit exceeded")

// boundedCommandOutput is a single-writer sink used by os/exec's pipe copier.
// It retains at most limit bytes, but acknowledges every input byte to keep
// draining both pipes. Read its fields only after Cmd.Run has joined copiers.
type boundedCommandOutput struct {
	limit     int
	contents  []byte
	truncated bool
}

func (output *boundedCommandOutput) Write(contents []byte) (int, error) {
	remaining := output.limit - len(output.contents)
	retained := len(contents)
	if retained > remaining {
		retained = remaining
		output.truncated = true
	}
	output.contents = append(output.contents, contents[:retained]...)
	return len(contents), nil
}

// diagnostic returns the prefix with a visible truncation marker, staying
// within the same byte limit. Machine-readable output never uses this method.
func (output *boundedCommandOutput) diagnostic() []byte {
	if !output.truncated {
		return output.contents
	}
	marker := []byte(outputTruncatedMarker)
	if len(marker) > output.limit {
		return marker[:output.limit]
	}
	prefix := output.contents[:output.limit-len(marker)]
	return append(prefix, marker...)
}

// runCapturedCommand captures a bounded stdout prefix and bounded stderr. A
// required stdout is machine-readable: exceeding its cap returns nil stdout
// and an explicit error, even if the retained prefix happens to be valid JSON.
// Diagnostic truncation alone never changes a successful execution into an
// infrastructure failure or discards Buck's separately recorded test evidence.
func runCapturedCommand(
	ctx context.Context,
	command string,
	args []string,
	directory string,
	stdoutLimit int,
	requireCompleteStdout bool,
) ([]byte, []byte, error) {
	process := exec.CommandContext(ctx, command, args...)
	// Cancel only this client, never its shared Buck daemon; inherited pipes
	// cannot keep the canceled agent waiting indefinitely for descendants.
	process.WaitDelay = time.Second
	process.Dir = directory
	stdout := boundedCommandOutput{limit: stdoutLimit}
	stderr := boundedCommandOutput{limit: commandDiagnosticLimit}
	process.Stdout = &stdout
	process.Stderr = &stderr
	err := process.Run()
	if requireCompleteStdout {
		if stdout.truncated {
			return nil, stderr.diagnostic(), errors.Join(err, fmt.Errorf(
				"%w: stdout exceeds %d bytes", errCommandOutputLimit, stdoutLimit,
			))
		}
		return stdout.contents, stderr.diagnostic(), err
	}
	return stdout.diagnostic(), stderr.diagnostic(), err
}
