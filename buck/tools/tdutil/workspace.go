// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

var workspaceSequence atomic.Uint64

const buckLocalConfigName = ".buckconfig.local"

// buckLocalConfig is an immutable snapshot shared by both endpoint
// workspaces. Reading it once guarantees that the two Buck graphs use exactly
// the same repository-local configuration even if the source file changes
// while tdutil is running.
type buckLocalConfig struct {
	source   string
	contents []byte
}

type workspaceLocation struct {
	root     string
	checkout string
}

// cleanupState tracks workspace registration and directory ownership
// independently. A success in either step is remembered even if its peer fails.
type cleanupState struct {
	forgetPending bool
	removePending bool
}

func pendingCleanup() cleanupState {
	return cleanupState{forgetPending: true, removePending: true}
}

func (state *cleanupState) suppress() {
	state.forgetPending = false
	state.removePending = false
}

func (state *cleanupState) run(forget, remove func() error) error {
	var forgetErr error
	if state.forgetPending {
		forgetErr = forget()
		if forgetErr == nil {
			state.forgetPending = false
		}
	}
	var removeErr error
	if state.removePending {
		removeErr = remove()
		if removeErr == nil {
			state.removePending = false
		}
	}
	return joinAdditionalErrors(forgetErr, removeErr)
}

type workspace struct {
	jj       *jjClient
	name     string
	root     string
	checkout string
	cleanup  cleanupState
}

func createWorkspace(
	ctx context.Context,
	jj *jjClient,
	revision, tempBase, currentDir string,
	localConfig *buckLocalConfig,
) (*workspace, error) {
	name := uniqueWorkspaceName()
	location, err := allocateWorkspaceLocation(jj.repository, tempBase, currentDir)
	if err != nil {
		return nil, err
	}
	result := &workspace{
		jj:       jj,
		name:     name,
		root:     location.root,
		checkout: location.checkout,
		cleanup:  pendingCleanup(),
	}

	commandResult, runErr := jj.runner.run(ctx, commandSpec{
		path: jj.executable,
		args: []string{
			"--no-pager",
			"--color=never",
			"-R",
			jj.repository,
			"workspace",
			"add",
			"--sparse-patterns",
			"full",
			"--revision",
			revision,
			"--name",
			name,
			location.checkout,
		},
		dir: jj.repository,
	})
	if runErr != nil {
		err = fmt.Errorf("creating temporary jj workspace %s: %w", name, runErr)
	} else {
		err = ensureJJProcessSuccess("jj workspace add", commandResult)
	}
	if err == nil {
		err = localConfig.install(result.checkout)
	}
	if err != nil {
		// Workspace add may have registered or materialized part of the checkout.
		// Try both cleanup obligations while preserving the creation error, as the
		// Rust guard's destructor does.
		_ = result.close(context.WithoutCancel(ctx))
		return nil, err
	}
	return result, nil
}

// snapshotBuckLocalConfig reads the invoking workspace's local configuration
// once. A missing file is the normal case and needs no representation in the
// historical workspaces.
func snapshotBuckLocalConfig(repository string) (*buckLocalConfig, error) {
	source := filepath.Join(repository, buckLocalConfigName)
	info, err := os.Stat(source)
	switch {
	case os.IsNotExist(err):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("checking repository-local Buck config %s: %w", source, err)
	case !info.Mode().IsRegular():
		return nil, fmt.Errorf("repository-local Buck config %s is not a regular file", source)
	}
	contents, err := os.ReadFile(source)
	if err != nil {
		return nil, fmt.Errorf("reading repository-local Buck config %s: %w", source, err)
	}
	return &buckLocalConfig{source: source, contents: contents}, nil
}

// install places the snapshot where Buck's client and daemon can both see it
// before daemon startup. Command-line --config-file overrides are applied too
// late to select startup services such as the file watcher.
func (config *buckLocalConfig) install(checkout string) error {
	if config == nil {
		return nil
	}
	destination := filepath.Join(checkout, buckLocalConfigName)
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("installing repository-local Buck config in temporary workspace %s: %w", destination, err)
	}
	succeeded := false
	defer func() {
		_ = output.Close()
		if !succeeded {
			_ = os.Remove(destination)
		}
	}()

	written, err := output.Write(config.contents)
	if err != nil {
		return fmt.Errorf("writing repository-local Buck config snapshot from %s to %s: %w", config.source, destination, err)
	}
	if written != len(config.contents) {
		return fmt.Errorf("writing repository-local Buck config snapshot from %s to %s: %w", config.source, destination, io.ErrShortWrite)
	}
	if runtime.GOOS != "windows" {
		if err := output.Chmod(0o600); err != nil {
			return fmt.Errorf("setting private permissions on repository-local Buck config %s: %w", destination, err)
		}
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("closing repository-local Buck config %s: %w", destination, err)
	}
	succeeded = true
	return nil
}

func (workspace *workspace) keep() string {
	workspace.cleanup.suppress()
	return workspace.checkout
}

func (workspace *workspace) close(ctx context.Context) error {
	return workspace.cleanup.run(
		func() error { return workspace.forget(ctx) },
		func() error { return removeWorkspaceDirectory(workspace.root) },
	)
}

func (workspace *workspace) forget(ctx context.Context) error {
	args := workspace.jj.commandArgs(true)
	args = append(args, "workspace", "forget", workspace.name)
	result, err := workspace.jj.runner.run(ctx, commandSpec{
		path: workspace.jj.executable,
		args: args,
		dir:  workspace.jj.repository,
	})
	if err != nil {
		return fmt.Errorf("forgetting temporary jj workspace %s: %w", workspace.name, err)
	}
	return ensureJJProcessSuccess("jj workspace forget", result)
}

func allocateWorkspaceLocation(repository, tempBase, currentDir string) (workspaceLocation, error) {
	repositoryPath, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return workspaceLocation{}, fmt.Errorf("resolving tdutil repository root %s: %w", repository, err)
	}
	repositoryPath, err = filepath.Abs(repositoryPath)
	if err != nil {
		return workspaceLocation{}, fmt.Errorf("resolving tdutil repository root %s: %w", repository, err)
	}

	tempPath := tempBase
	if !filepath.IsAbs(tempPath) {
		tempPath = filepath.Join(currentDir, tempPath)
	}
	tempPath, err = filepath.EvalSymlinks(tempPath)
	if err != nil {
		return workspaceLocation{}, fmt.Errorf("resolving tdutil temporary workspace base %s: %w", tempPath, err)
	}
	tempPath, err = filepath.Abs(tempPath)
	if err != nil {
		return workspaceLocation{}, fmt.Errorf("resolving tdutil temporary workspace base %s: %w", tempPath, err)
	}

	insideRepository, err := filesystemPathIsWithin(repositoryPath, tempPath)
	if err != nil {
		return workspaceLocation{}, fmt.Errorf("comparing tdutil repository and temporary workspace paths: %w", err)
	}
	if insideRepository {
		return workspaceLocation{}, fmt.Errorf(
			"tdutil temporary workspace base %s must be outside repository %s",
			tempPath,
			repositoryPath,
		)
	}

	root, err := os.MkdirTemp(tempPath, "tdutil-")
	if err != nil {
		return workspaceLocation{}, fmt.Errorf("creating private tdutil workspace container in %s: %w", tempPath, err)
	}
	failed := true
	defer func() {
		if failed {
			_ = removeWorkspaceDirectory(root)
		}
	}()
	if runtime.GOOS != "windows" {
		if err := os.Chmod(root, 0o700); err != nil {
			return workspaceLocation{}, fmt.Errorf("setting private permissions on tdutil workspace container %s: %w", root, err)
		}
	}

	checkout := filepath.Join(root, "checkout")
	_, err = os.Lstat(checkout)
	switch {
	case err == nil:
		return workspaceLocation{}, fmt.Errorf("tdutil workspace checkout path unexpectedly exists: %s", checkout)
	case !os.IsNotExist(err):
		return workspaceLocation{}, fmt.Errorf("checking tdutil workspace checkout path %s: %w", checkout, err)
	}
	failed = false
	return workspaceLocation{root: root, checkout: checkout}, nil
}

func filesystemPathIsWithin(parent, candidate string) (bool, error) {
	relative, err := filepath.Rel(parent, candidate)
	if err != nil {
		return false, err
	}
	if relative == "." {
		return true, nil
	}
	if filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false, nil
	}
	return true, nil
}

func removeWorkspaceDirectory(path string) error {
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("removing temporary workspace %s: %w", path, err)
	}
	return nil
}

func uniqueWorkspaceName() string {
	sequence := workspaceSequence.Add(1) - 1
	return fmt.Sprintf("tdutil-%x-%x-%x", os.Getpid(), time.Now().UnixNano(), sequence)
}

func joinAdditionalErrors(first, second error) error {
	switch {
	case first == nil:
		return second
	case second == nil:
		return first
	default:
		return fmt.Errorf("%v; additionally, %w", first, second)
	}
}
