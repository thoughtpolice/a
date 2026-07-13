// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
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
	var stderr bytes.Buffer
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
