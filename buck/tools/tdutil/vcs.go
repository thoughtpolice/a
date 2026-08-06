// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const jjDiffTemplate = `'{"status":' ++ json(status) ++ ',"source":' ++ json(source.path()) ++ ',"target":' ++ json(target.path()) ++ '}' ++ "\n"`

type resolvedRevisions struct {
	base string
	head string
}

// jjClient is an executable tied to one repository. All repository-sensitive
// commands set both -R and their working directory.
type jjClient struct {
	runner     processRunner
	executable string
	repository string
}

func discoverJJ(ctx context.Context, runner processRunner, executable, start string) (*jjClient, error) {
	result, err := runner.run(ctx, commandSpec{
		path: executable,
		args: []string{
			"--no-pager",
			"--color=never",
			"-R",
			start,
			"--ignore-working-copy",
			"workspace",
			"root",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("running `jj workspace root`: %w", err)
	}
	if err := ensureJJProcessSuccess("jj workspace root", result); err != nil {
		return nil, err
	}
	repository, err := parseWorkspaceRoot(result.stdout)
	if err != nil {
		return nil, err
	}
	return &jjClient{runner: runner, executable: executable, repository: repository}, nil
}

func (jj *jjClient) resolvePair(ctx context.Context, base, head string, ignoreWorkingCopy bool) (resolvedRevisions, error) {
	baseCommit, err := jj.resolveOne(ctx, base, ignoreWorkingCopy)
	if err != nil {
		return resolvedRevisions{}, err
	}
	headCommit, err := jj.resolveOne(ctx, head, ignoreWorkingCopy)
	if err != nil {
		return resolvedRevisions{}, err
	}
	return resolvedRevisions{base: baseCommit, head: headCommit}, nil
}

func (jj *jjClient) resolveOne(ctx context.Context, revset string, ignoreWorkingCopy bool) (string, error) {
	args := jj.commandArgs(ignoreWorkingCopy)
	args = append(args, "log", "--no-graph", "-T", "commit_id ++ \"\\n\"", "-r", revset)
	result, err := jj.runner.run(ctx, commandSpec{
		path: jj.executable,
		args: args,
		dir:  jj.repository,
	})
	if err != nil {
		return "", fmt.Errorf("running `jj log` to resolve revset %q: %w", revset, err)
	}
	if err := ensureJJProcessSuccess("jj log", result); err != nil {
		return "", err
	}
	return parseSingleRevision(result.stdout, revset)
}

func (jj *jjClient) changedPaths(ctx context.Context, from, to string, ignoreWorkingCopy bool) ([]string, error) {
	args := jj.commandArgs(ignoreWorkingCopy)
	args = append(args, "diff", "--from", from, "--to", to, "--template", jjDiffTemplate)
	result, err := jj.runner.run(ctx, commandSpec{
		path: jj.executable,
		args: args,
		dir:  jj.repository,
	})
	if err != nil {
		return nil, fmt.Errorf("running structured `jj diff`: %w", err)
	}
	if err := ensureJJProcessSuccess("jj diff", result); err != nil {
		return nil, err
	}
	return parseChangedPaths(result.stdout)
}

func (jj *jjClient) listWorkspaceNames(ctx context.Context) ([]string, error) {
	args := jj.commandArgs(true)
	args = append(args, "workspace", "list", "-T", `name ++ "\n"`)
	result, err := jj.runner.run(ctx, commandSpec{
		path: jj.executable,
		args: args,
		dir:  jj.repository,
	})
	if err != nil {
		return nil, fmt.Errorf("running `jj workspace list`: %w", err)
	}
	if err := ensureJJProcessSuccess("jj workspace list", result); err != nil {
		return nil, err
	}
	return parseWorkspaceNames(result.stdout)
}

func (jj *jjClient) forgetWorkspace(ctx context.Context, name string) error {
	args := jj.commandArgs(true)
	args = append(args, "workspace", "forget", name)
	result, err := jj.runner.run(ctx, commandSpec{
		path: jj.executable,
		args: args,
		dir:  jj.repository,
	})
	if err != nil {
		return fmt.Errorf("forgetting temporary jj workspace %s: %w", name, err)
	}
	return ensureJJProcessSuccess("jj workspace forget", result)
}

func (jj *jjClient) commandArgs(ignoreWorkingCopy bool) []string {
	args := []string{"--no-pager", "--color=never", "-R", jj.repository}
	if ignoreWorkingCopy {
		args = append(args, "--ignore-working-copy")
	}
	return args
}

func ensureJJProcessSuccess(action string, result processResult) error {
	if result.exitCode == 0 && !result.signaled {
		return nil
	}
	detail := strings.TrimSpace(strings.ToValidUTF8(string(result.stderr), "\uFFFD"))
	if detail == "" {
		detail = strings.TrimSpace(strings.ToValidUTF8(string(result.stdout), "\uFFFD"))
	}
	status := fmt.Sprintf("exit status: %d", result.exitCode)
	if result.signaled {
		status = "signal"
	}
	if detail == "" {
		return fmt.Errorf("%s failed with status %s", action, status)
	}
	return fmt.Errorf("%s failed with status %s: %s", action, status, detail)
}

func parseWorkspaceRoot(stdout []byte) (string, error) {
	if !utf8.Valid(stdout) {
		return "", fmt.Errorf("jj returned a non-UTF-8 workspace root")
	}
	root := strings.TrimRight(string(stdout), "\r\n")
	if root == "" || strings.ContainsAny(root, "\r\n") {
		return "", fmt.Errorf("jj returned a malformed workspace root")
	}
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("jj returned a non-absolute workspace root: %q", root)
	}
	return root, nil
}

func parseWorkspaceNames(stdout []byte) ([]string, error) {
	if !utf8.Valid(stdout) {
		return nil, fmt.Errorf("jj returned non-UTF-8 workspace names")
	}
	var names []string
	for _, line := range strings.Split(string(stdout), "\n") {
		name := strings.TrimSuffix(line, "\r")
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

func parseSingleRevision(stdout []byte, revset string) (string, error) {
	if !utf8.Valid(stdout) {
		return "", fmt.Errorf("jj returned non-UTF-8 output while resolving %q", revset)
	}
	output := string(stdout)
	if strings.HasSuffix(output, "\n") {
		output = strings.TrimSuffix(output, "\n")
	}
	revision := strings.TrimSuffix(output, "\r")
	if revision == "" {
		return "", fmt.Errorf("revset %q resolved to no commits", revset)
	}
	if strings.ContainsAny(revision, "\r\n") {
		return "", fmt.Errorf("revset %q resolved to multiple commits; expected exactly one", revset)
	}
	for index := 0; index < len(revision); index++ {
		char := revision[index]
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return "", fmt.Errorf("jj returned a malformed commit ID for revset %q: %q", revset, revision)
		}
	}
	return revision, nil
}

func parseChangedPaths(stdout []byte) ([]string, error) {
	if !utf8.Valid(stdout) {
		return nil, fmt.Errorf("jj diff returned non-UTF-8 output")
	}
	if len(stdout) == 0 {
		return []string{}, nil
	}

	lines := strings.Split(string(stdout), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	paths := make(map[string]struct{})
	for index, rawLine := range lines {
		line := strings.TrimSuffix(rawLine, "\r")
		value, err := decodeSingleJSONValue(line)
		if err != nil {
			return nil, fmt.Errorf("malformed jj diff JSON on line %d: %w", index+1, err)
		}
		object, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("jj diff line %d is not an object", index+1)
		}
		field := func(name string) (string, error) {
			raw, ok := object[name]
			if !ok {
				return "", fmt.Errorf("jj diff line %d has no string `%s` field", index+1, name)
			}
			text, ok := raw.(string)
			if !ok {
				return "", fmt.Errorf("jj diff line %d has no string `%s` field", index+1, name)
			}
			return text, nil
		}
		status, err := field("status")
		if err != nil {
			return nil, err
		}
		source, err := field("source")
		if err != nil {
			return nil, err
		}
		target, err := field("target")
		if err != nil {
			return nil, err
		}

		var endpoints []string
		switch status {
		case "modified", "added", "copied":
			endpoints = []string{target}
		case "removed":
			endpoints = []string{source}
		case "renamed":
			endpoints = []string{source, target}
		default:
			return nil, fmt.Errorf("jj diff line %d has unknown status `%s`", index+1, status)
		}
		for _, path := range endpoints {
			if err := validateRepositoryPath(path); err != nil {
				return nil, err
			}
			paths[path] = struct{}{}
		}
	}

	result := make([]string, 0, len(paths))
	for path := range paths {
		result = append(result, path)
	}
	sort.Strings(result)
	return result, nil
}

func decodeSingleJSONValue(line string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(line))
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("trailing JSON value")
		}
		return nil, err
	}
	return value, nil
}

func validateRepositoryPath(path string) error {
	if path == "" || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") || strings.Contains(path, "\\") {
		return fmt.Errorf("jj diff returned a malformed repository path: %q", path)
	}
	for _, char := range path {
		if unicode.IsControl(char) {
			return fmt.Errorf("jj diff returned a malformed repository path: %q", path)
		}
	}
	for _, component := range strings.Split(path, "/") {
		if component == "" || component == "." || component == ".." {
			return fmt.Errorf("jj diff returned a malformed repository path: %q", path)
		}
	}
	return nil
}
