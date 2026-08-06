// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
)

// commandSpec describes one subprocess invocation. Arguments are always passed
// directly to the child; tdutil never invokes a shell.
type commandSpec struct {
	path string
	args []string
	dir  string
}

// processResult separates an ordinary unsuccessful exit from an inability to
// start or wait for a process. That distinction keeps command diagnostics under
// the caller's control and makes the process layer straightforward to fake.
type processResult struct {
	stdout   []byte
	stderr   []byte
	exitCode int
	signaled bool
}

type processRunner interface {
	run(context.Context, commandSpec) (processResult, error)
}

// lineStreamRunner is an optional processRunner extension for commands whose
// stdout should be consumed one line at a time instead of accumulated. The
// callback receives each newline-terminated line without its terminator, plus
// any final unterminated line; it must not retain the slice. The returned
// processResult carries stderr and the exit status but no stdout.
type lineStreamRunner interface {
	runLines(ctx context.Context, spec commandSpec, line func([]byte)) (processResult, error)
}

// runProcessLines feeds a command's stdout through line, preferring the
// runner's incremental implementation and falling back to a buffered run.
func runProcessLines(
	ctx context.Context,
	runner processRunner,
	spec commandSpec,
	line func([]byte),
) (processResult, error) {
	if streamer, ok := runner.(lineStreamRunner); ok {
		return streamer.runLines(ctx, spec, line)
	}
	result, err := runner.run(ctx, spec)
	if err != nil {
		return result, err
	}
	feedLines(result.stdout, line)
	return result, nil
}

func feedLines(data []byte, line func([]byte)) {
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			line(data)
			return
		}
		line(data[:end])
		data = data[end+1:]
	}
}

// stderrLimit bounds what is retained from a child's stderr. `buck2 targets
// --keep-going` over a broken graph can report a diagnostic per package, and
// the whole stream is otherwise held in memory for the length of the run.
const stderrLimit = 1 << 20

// boundedBuffer retains the tail of a stream up to a fixed size. The tail is
// the useful end for these children: buck2 writes progress to stderr and
// reports the failure that actually stopped it last, so truncating from the
// front keeps the diagnostic a caller needs.
type boundedBuffer struct {
	limit  int
	data   []byte
	elided int64
}

func (buffer *boundedBuffer) Write(contents []byte) (int, error) {
	written := len(contents)
	if len(contents) > buffer.limit {
		buffer.elided += int64(len(contents) - buffer.limit)
		contents = contents[len(contents)-buffer.limit:]
	}
	if overflow := len(buffer.data) + len(contents) - buffer.limit; overflow > 0 {
		buffer.elided += int64(overflow)
		buffer.data = append(buffer.data[:0], buffer.data[overflow:]...)
	}
	buffer.data = append(buffer.data, contents...)
	return written, nil
}

func (buffer *boundedBuffer) Bytes() []byte {
	if buffer.elided == 0 {
		return buffer.data
	}
	notice := fmt.Sprintf("[%d earlier byte(s) elided]\n", buffer.elided)
	return append([]byte(notice), buffer.data...)
}

type osProcessRunner struct{}

func (osProcessRunner) run(ctx context.Context, spec commandSpec) (processResult, error) {
	if err := ctx.Err(); err != nil {
		return processResult{}, err
	}

	cmd := exec.CommandContext(ctx, spec.path, spec.args...)
	if spec.dir != "" {
		cmd.Dir = spec.dir
	}
	var stdout bytes.Buffer
	stderr := boundedBuffer{limit: stderrLimit}
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	result := processResult{
		stdout:   stdout.Bytes(),
		stderr:   stderr.Bytes(),
		exitCode: 0,
	}
	if cmd.ProcessState != nil {
		result.exitCode = cmd.ProcessState.ExitCode()
		result.signaled = result.exitCode < 0
	}
	if err == nil {
		return result, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return result, ctxErr
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return result, nil
	}
	return result, err
}

func (osProcessRunner) runLines(ctx context.Context, spec commandSpec, line func([]byte)) (processResult, error) {
	if err := ctx.Err(); err != nil {
		return processResult{}, err
	}

	cmd := exec.CommandContext(ctx, spec.path, spec.args...)
	if spec.dir != "" {
		cmd.Dir = spec.dir
	}
	stderr := boundedBuffer{limit: stderrLimit}
	cmd.Stderr = &stderr
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return processResult{}, err
	}
	if err := cmd.Start(); err != nil {
		return processResult{}, err
	}

	reader := bufio.NewReaderSize(pipe, 64*1024)
	var readErr error
	for {
		chunk, err := reader.ReadBytes('\n')
		if err == nil {
			line(bytes.TrimSuffix(chunk, []byte("\n")))
			continue
		}
		if len(chunk) > 0 {
			line(chunk)
		}
		if err != io.EOF {
			readErr = err
		}
		break
	}
	if readErr != nil {
		// Abandoning the pipe with the child still writing would fill it and
		// block Wait forever, so consume whatever remains before joining.
		_, _ = io.Copy(io.Discard, pipe)
	}

	waitErr := cmd.Wait()
	result := processResult{
		stderr:   stderr.Bytes(),
		exitCode: 0,
	}
	if cmd.ProcessState != nil {
		result.exitCode = cmd.ProcessState.ExitCode()
		result.signaled = result.exitCode < 0
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return result, ctxErr
	}
	var exitError *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exitError) {
		return result, waitErr
	}
	return result, readErr
}
