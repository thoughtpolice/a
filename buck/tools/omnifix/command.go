// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

type commandRunner func(ctx context.Context, name string, args []string, stdin string) (stdout, stderr string, err error)
type pathMatcher func(path string) bool
type argumentBuilder func(path string) []string

type commandFormatter struct {
	formatterName string
	command       string
	handlesPath   pathMatcher
	arguments     argumentBuilder
	run           commandRunner
}

func newCommandFormatter(
	formatterName string,
	command string,
	handlesPath pathMatcher,
	arguments argumentBuilder,
	run commandRunner,
) commandFormatter {
	if arguments == nil {
		arguments = func(string) []string { return nil }
	}
	if run == nil {
		run = runCommand
	}
	return commandFormatter{
		formatterName: formatterName,
		command:       command,
		handlesPath:   handlesPath,
		arguments:     arguments,
		run:           run,
	}
}

func (f commandFormatter) name() string {
	return f.formatterName
}

func (f commandFormatter) handles(path string) bool {
	return f.handlesPath(path)
}

func (f commandFormatter) format(ctx context.Context, path, content string) (string, error) {
	stdout, stderr, err := f.run(ctx, f.command, f.arguments(path), content)
	if err == nil {
		return stdout, nil
	}
	if detail := strings.TrimSpace(stderr); detail != "" {
		return "", fmt.Errorf("%s: %w", detail, err)
	}
	return "", err
}

func runCommand(ctx context.Context, name string, args []string, stdin string) (string, string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	return stdout.String(), stderr.String(), err
}
