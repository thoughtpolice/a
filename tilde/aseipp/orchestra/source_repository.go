// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This module owns the source checkout used by an Orchestra agent. It clones a
// remote once, refreshes that persistent JJ repository without moving its
// working copy, and lends short-lived revision workspaces to execution jobs.
// Planning runs tdutil from one such head workspace and testing runs Buck from
// another, so neither stage rewrites the anchor checkout.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	defaultSourceTimeout          = 10 * time.Minute
	sourceWorkspaceCleanupTimeout = 30 * time.Second
)

var sourceWorkspaceSequence atomic.Uint64

// sourceRepositoryOptions identify one persistent, single-remote JJ cache.
type sourceRepositoryOptions struct {
	JJPath string
	Source string
	Cache  string
	Remote string
}

// sourceCommandRunner is injectable for lifecycle tests.
type sourceCommandRunner func(context.Context, string, []string, string) ([]byte, []byte, error)

// revisionWorkspace is a temporary checkout whose tree is pinned to a job.
type revisionWorkspace interface {
	Directory() string
	Close(context.Context) error
}

// revisionWorkspaceProvider materializes an execution tree without moving the
// persistent repository's working copy.
type revisionWorkspaceProvider interface {
	OpenWorkspace(context.Context, string) (revisionWorkspace, error)
}

// jjSourceRepository is one agent-owned clone and its temporary workspace root.
type jjSourceRepository struct {
	jjCommand     string
	source        string
	cache         string
	remote        string
	repository    string
	workspaceRoot string
	runCommand    sourceCommandRunner
}

// jjRevisionWorkspace tracks the two independent cleanup obligations created
// by `jj workspace add`: the repository registration and checkout directory.
type jjRevisionWorkspace struct {
	repository *jjSourceRepository
	name       string
	root       string
	directory  string
	forget     bool
	remove     bool
}

// newJJSourceRepository validates and normalizes a managed source-cache setup.
func newJJSourceRepository(options sourceRepositoryOptions) (*jjSourceRepository, error) {
	jjCommand := strings.TrimSpace(options.JJPath)
	if jjCommand == "" {
		return nil, errors.New("--jj must name an executable")
	}
	source, err := normalizeSourceLocation(options.Source)
	if err != nil {
		return nil, err
	}
	cacheValue := strings.TrimSpace(options.Cache)
	if cacheValue == "" {
		return nil, errors.New("--source-cache is required with --source-url")
	}
	cache, err := filepath.Abs(cacheValue)
	if err != nil {
		return nil, fmt.Errorf("resolve --source-cache: %w", err)
	}
	cache = filepath.Clean(cache)
	if filepath.Dir(cache) == cache {
		return nil, errors.New("--source-cache must not be a filesystem root")
	}
	remote := strings.TrimSpace(options.Remote)
	if remote == "" || strings.ContainsAny(remote, "\r\n\t ") {
		return nil, errors.New("--source-remote must be one non-empty name")
	}
	return &jjSourceRepository{
		jjCommand:     jjCommand,
		source:        source,
		cache:         cache,
		remote:        remote,
		repository:    filepath.Join(cache, "repository"),
		workspaceRoot: filepath.Join(cache, "workspaces"),
		runCommand:    runSourceCommand,
	}, nil
}

// prepareJJSourceRepository implements the shared optional-source flag
// contract used by both the agent and standalone planning/execution harnesses.
func prepareJJSourceRepository(
	ctx context.Context,
	options sourceRepositoryOptions,
	timeout time.Duration,
) (*jjSourceRepository, bool, error) {
	if strings.TrimSpace(options.Source) == "" && strings.TrimSpace(options.Cache) == "" {
		return nil, false, nil
	}
	if timeout <= 0 {
		return nil, false, errors.New("--source-timeout must be positive")
	}
	repository, err := newJJSourceRepository(options)
	if err != nil {
		return nil, false, err
	}
	prepareContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	created, err := repository.Prepare(prepareContext)
	if err != nil {
		return nil, created, err
	}
	return repository, created, nil
}

// normalizeSourceLocation makes relative local paths stable across restarts;
// URL and scp-style Git locations retain their transport spelling.
func normalizeSourceLocation(source string) (string, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return "", errors.New("--source-url must not be empty")
	}
	if strings.Contains(source, "://") || isSCPSource(source) || filepath.IsAbs(source) {
		return source, nil
	}
	absolute, err := filepath.Abs(source)
	if err != nil {
		return "", fmt.Errorf("resolve local --source-url: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func isSCPSource(source string) bool {
	colon := strings.IndexByte(source, ':')
	separator := strings.IndexAny(source, `/\\`)
	return colon > 0 && strings.Contains(source[:colon], "@") && (separator < 0 || colon < separator)
}

// Prepare creates the cache on first use, validates it on reuse, and fetches
// remote changes without snapshotting or updating the anchor working copy.
func (repository *jjSourceRepository) Prepare(ctx context.Context) (bool, error) {
	if err := os.MkdirAll(repository.cache, 0o700); err != nil {
		return false, fmt.Errorf("create source cache %s: %w", repository.cache, err)
	}
	if err := os.MkdirAll(repository.workspaceRoot, 0o700); err != nil {
		return false, fmt.Errorf("create source workspace root %s: %w", repository.workspaceRoot, err)
	}

	created := false
	info, err := os.Stat(repository.repository)
	switch {
	case os.IsNotExist(err):
		created = true
		if err := repository.clone(ctx); err != nil {
			return false, err
		}
	case err != nil:
		return false, fmt.Errorf("inspect source repository %s: %w", repository.repository, err)
	case !info.IsDir():
		return false, fmt.Errorf("source repository path %s is not a directory", repository.repository)
	}

	if err := repository.validate(ctx); err != nil {
		return created, err
	}
	if err := repository.fetch(ctx); err != nil {
		return created, err
	}
	return created, nil
}

// Directory returns the inert anchor checkout retained across agent restarts.
func (repository *jjSourceRepository) Directory() string {
	return repository.repository
}

func (repository *jjSourceRepository) clone(ctx context.Context) error {
	runner := repository.runner()
	_, stderr, err := runner(ctx, repository.jjCommand, []string{
		"--no-pager",
		"--color=never",
		"git", "clone",
		"--no-colocate",
		"--remote", repository.remote,
		repository.source,
		repository.repository,
	}, repository.cache)
	if err == nil {
		return nil
	}
	// Keep a partial destination for diagnosis. An operator can remove this
	// explicitly; guessing that it is still ours would make concurrent startup
	// capable of deleting a clone another process just completed.
	return sourceCommandError("clone source repository", err, stderr)
}

func (repository *jjSourceRepository) validate(ctx context.Context) error {
	runner := repository.runner()
	rootOutput, rootStderr, err := runner(ctx, repository.jjCommand, repository.jjArgs("root"), repository.repository)
	if err != nil {
		return sourceCommandError("validate source JJ repository", err, rootStderr)
	}
	root := strings.TrimSpace(string(rootOutput))
	if root == "" || !filepath.IsAbs(root) {
		return fmt.Errorf("source JJ repository returned invalid workspace root %q", root)
	}
	actualRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve source JJ workspace root %s: %w", root, err)
	}
	expectedRoot, err := filepath.EvalSymlinks(repository.repository)
	if err != nil {
		return fmt.Errorf("resolve configured source repository %s: %w", repository.repository, err)
	}
	if filepath.Clean(actualRoot) != filepath.Clean(expectedRoot) {
		return fmt.Errorf(
			"source cache %s belongs to JJ workspace %s",
			repository.repository,
			root,
		)
	}

	remoteOutput, remoteStderr, err := runner(
		ctx,
		repository.jjCommand,
		repository.jjArgs("git", "remote", "list"),
		repository.repository,
	)
	if err != nil {
		return sourceCommandError("list source repository remotes", err, remoteStderr)
	}
	remoteURL, found := parseJJRemote(remoteOutput, repository.remote)
	if !found {
		return fmt.Errorf("source repository has no remote %q", repository.remote)
	}
	if remoteURL != repository.source {
		return fmt.Errorf(
			"source cache remote %s is %q, not configured source %q",
			repository.remote,
			remoteURL,
			repository.source,
		)
	}
	return nil
}

func (repository *jjSourceRepository) fetch(ctx context.Context) error {
	_, stderr, err := repository.runner()(
		ctx,
		repository.jjCommand,
		repository.jjArgs(
			"--config", "git.abandon-unreachable-commits=false",
			"git", "fetch", "--remote", repository.remote,
		),
		repository.repository,
	)
	if err != nil {
		return sourceCommandError("fetch source repository", err, stderr)
	}
	return nil
}

// OpenWorkspace resolves one immutable job revision and materializes its tree
// in a private workspace. `workspace add -r` creates an empty working-copy
// commit whose tree is exactly the requested commit's tree.
func (repository *jjSourceRepository) OpenWorkspace(ctx context.Context, revision string) (revisionWorkspace, error) {
	commit, err := repository.resolveRevision(ctx, revision)
	if err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp(repository.workspaceRoot, "job-")
	if err != nil {
		return nil, fmt.Errorf("allocate source workspace: %w", err)
	}
	directory := filepath.Join(root, "checkout")
	sequence := sourceWorkspaceSequence.Add(1)
	name := "orchestra-" + strconv.Itoa(os.Getpid()) + "-" +
		strconv.FormatInt(time.Now().UnixNano(), 16) + "-" + strconv.FormatUint(sequence, 16)
	workspace := &jjRevisionWorkspace{
		repository: repository,
		name:       name,
		root:       root,
		directory:  directory,
		forget:     true,
		remove:     true,
	}
	_, stderr, runErr := repository.runner()(
		ctx,
		repository.jjCommand,
		repository.jjArgs(
			"workspace", "add",
			"--sparse-patterns", "full",
			"--revision", commit,
			"--name", name,
			directory,
		),
		repository.repository,
	)
	if runErr == nil {
		_, updateStderr, updateErr := repository.runner()(
			ctx,
			repository.jjCommand,
			[]string{
				"--no-pager",
				"--color=never",
				"-R", directory,
				"workspace", "update-stale",
			},
			directory,
		)
		if updateErr == nil {
			return workspace, nil
		}
		runErr = updateErr
		stderr = updateStderr
	}
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), sourceWorkspaceCleanupTimeout)
	defer cancel()
	cleanupErr := workspace.Close(cleanupContext)
	commandErr := sourceCommandError("materialize source revision workspace", runErr, stderr)
	if cleanupErr != nil {
		return nil, fmt.Errorf("%v; additionally clean failed workspace: %w", commandErr, cleanupErr)
	}
	return nil, commandErr
}

func (repository *jjSourceRepository) resolveRevision(ctx context.Context, revision string) (string, error) {
	if strings.TrimSpace(revision) == "" {
		return "", errors.New("source workspace revision must not be empty")
	}
	stdout, stderr, err := repository.runner()(
		ctx,
		repository.jjCommand,
		repository.jjArgs("log", "--no-graph", "--revisions", revision, "--template", `commit_id ++ "\n"`),
		repository.repository,
	)
	if err != nil {
		return "", sourceCommandError(fmt.Sprintf("resolve source revision %q", revision), err, stderr)
	}
	fields := strings.Fields(string(stdout))
	if len(fields) != 1 {
		return "", fmt.Errorf("source revision %q resolved to %d commits", revision, len(fields))
	}
	if !isHexCommit(fields[0]) {
		return "", fmt.Errorf("source revision %q resolved to malformed commit ID %q", revision, fields[0])
	}
	return fields[0], nil
}

func (repository *jjSourceRepository) jjArgs(command ...string) []string {
	args := []string{
		"--no-pager",
		"--color=never",
		"-R", repository.repository,
		"--ignore-working-copy",
	}
	return append(args, command...)
}

func (repository *jjSourceRepository) runner() sourceCommandRunner {
	if repository.runCommand != nil {
		return repository.runCommand
	}
	return runSourceCommand
}

// Directory implements revisionWorkspace.
func (workspace *jjRevisionWorkspace) Directory() string {
	return workspace.directory
}

// Close forgets the JJ registration and removes only the private directory
// allocated by OpenWorkspace. Both steps are attempted even if one fails.
func (workspace *jjRevisionWorkspace) Close(ctx context.Context) error {
	var forgetErr error
	if workspace.forget {
		_, stderr, err := workspace.repository.runner()(
			ctx,
			workspace.repository.jjCommand,
			workspace.repository.jjArgs("workspace", "forget", workspace.name),
			workspace.repository.repository,
		)
		if err != nil {
			forgetErr = sourceCommandError("forget source revision workspace", err, stderr)
		} else {
			workspace.forget = false
		}
	}
	var removeErr error
	if workspace.remove {
		removeErr = os.RemoveAll(workspace.root)
		if removeErr != nil {
			removeErr = fmt.Errorf("remove source revision workspace %s: %w", workspace.root, removeErr)
		} else {
			workspace.remove = false
		}
	}
	return errors.Join(forgetErr, removeErr)
}

func parseJJRemote(output []byte, name string) (string, bool) {
	for _, rawLine := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == name {
			return strings.TrimSpace(line[len(fields[0]):]), true
		}
	}
	return "", false
}

func isHexCommit(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func sourceCommandError(action string, err error, stderr []byte) error {
	diagnostic := boundedDiagnostic(stderr, 4<<10)
	if diagnostic == "" {
		return fmt.Errorf("%s: %w", action, err)
	}
	return fmt.Errorf("%s: %w: %s", action, err, diagnostic)
}

func runSourceCommand(
	ctx context.Context,
	command string,
	args []string,
	directory string,
) ([]byte, []byte, error) {
	process := exec.CommandContext(ctx, command, args...)
	process.WaitDelay = time.Second
	process.Dir = directory
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	process.Stdout = &stdout
	process.Stderr = &stderr
	err := process.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}
