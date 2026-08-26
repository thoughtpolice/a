// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These tests pin the managed source lifecycle: clone once, fetch on every
// agent start, never update the anchor working copy, and cleanly lend a
// revision-specific workspace to Buck.
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJJSourceRepositoryClonesOnceAndFetchesWarmCache(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	cache := filepath.Join(root, "cache")
	repository, err := newJJSourceRepository(sourceRepositoryOptions{
		JJPath: "/tools/jj",
		Source: source,
		Cache:  cache,
		Remote: "upstream",
	})
	if err != nil {
		t.Fatal(err)
	}
	cloneCalls := 0
	fetchCalls := 0
	repository.runCommand = func(_ context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
		if command != "/tools/jj" {
			t.Fatalf("command = %q", command)
		}
		switch {
		case hasArgumentSequence(args, "git", "clone"):
			cloneCalls++
			if directory != cache || !containsAdjacent(args, "--remote", "upstream") || !containsArgument(args, "--no-colocate") {
				t.Fatalf("clone args = %#v in %q", args, directory)
			}
			if err := os.MkdirAll(repository.repository, 0o700); err != nil {
				t.Fatal(err)
			}
			return nil, nil, nil
		case containsArgument(args, "root"):
			return []byte(repository.repository + "\n"), nil, nil
		case hasArgumentSequence(args, "git", "remote", "list"):
			return []byte("upstream " + source + "\n"), nil, nil
		case hasArgumentSequence(args, "git", "fetch"):
			fetchCalls++
			if !containsArgument(args, "--ignore-working-copy") ||
				!containsAdjacent(args, "--remote", "upstream") ||
				!containsAdjacent(args, "--config", "git.abandon-unreachable-commits=false") {
				t.Fatalf("fetch args = %#v", args)
			}
			return nil, nil, nil
		default:
			t.Fatalf("unexpected args = %#v", args)
			return nil, nil, nil
		}
	}

	created, err := repository.Prepare(context.Background())
	if err != nil || !created {
		t.Fatalf("first prepare: created=%t error=%v", created, err)
	}
	created, err = repository.Prepare(context.Background())
	if err != nil || created {
		t.Fatalf("second prepare: created=%t error=%v", created, err)
	}
	if cloneCalls != 1 || fetchCalls != 2 {
		t.Fatalf("clone calls=%d fetch calls=%d", cloneCalls, fetchCalls)
	}
}

func TestJJSourceRepositoryProvidesPinnedWorkspace(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	repository, err := newJJSourceRepository(sourceRepositoryOptions{
		JJPath: "jj",
		Source: "ssh://example.invalid/repository",
		Cache:  filepath.Join(root, "cache"),
		Remote: "origin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(repository.workspaceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	forgetCalls := 0
	updateCalls := 0
	repository.runCommand = func(_ context.Context, _ string, args []string, directory string) ([]byte, []byte, error) {
		switch {
		case containsArgument(args, "log"):
			if directory != repository.repository || !containsArgument(args, "--ignore-working-copy") {
				t.Fatalf("resolve args = %#v in %q", args, directory)
			}
			return []byte("0123456789abcdef\n"), nil, nil
		case hasArgumentSequence(args, "workspace", "add"):
			if !containsAdjacent(args, "--revision", "0123456789abcdef") || !containsArgument(args, "--ignore-working-copy") {
				t.Fatalf("workspace args = %#v", args)
			}
			checkout := args[len(args)-1]
			if err := os.MkdirAll(checkout, 0o700); err != nil {
				t.Fatal(err)
			}
			return nil, nil, nil
		case hasArgumentSequence(args, "workspace", "update-stale"):
			updateCalls++
			if containsArgument(args, "--ignore-working-copy") || directory == repository.repository {
				t.Fatalf("update args = %#v in %q", args, directory)
			}
			return nil, nil, nil
		case hasArgumentSequence(args, "workspace", "forget"):
			forgetCalls++
			return nil, nil, nil
		default:
			t.Fatalf("unexpected args = %#v", args)
			return nil, nil, nil
		}
	}

	workspace, err := repository.OpenWorkspace(context.Background(), "queued-revision")
	if err != nil {
		t.Fatal(err)
	}
	directory := workspace.Directory()
	if info, err := os.Stat(directory); err != nil || !info.IsDir() {
		t.Fatalf("workspace directory %q: %v", directory, err)
	}
	if err := workspace.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if updateCalls != 1 || forgetCalls != 1 {
		t.Fatalf("update calls=%d forget calls=%d", updateCalls, forgetCalls)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("workspace remained at %q: %v", directory, err)
	}
	if err := workspace.Close(context.Background()); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
}

func TestJJSourceRepositoryRejectsDifferentRemote(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	repository, err := newJJSourceRepository(sourceRepositoryOptions{
		JJPath: "jj",
		Source: "ssh://example.invalid/wanted",
		Cache:  filepath.Join(root, "cache"),
		Remote: "origin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(repository.repository, 0o700); err != nil {
		t.Fatal(err)
	}
	repository.runCommand = func(_ context.Context, _ string, args []string, _ string) ([]byte, []byte, error) {
		switch {
		case containsArgument(args, "root"):
			return []byte(repository.repository + "\n"), nil, nil
		case hasArgumentSequence(args, "git", "remote", "list"):
			return []byte("origin ssh://example.invalid/different\n"), nil, nil
		default:
			return nil, nil, errors.New("unexpected command")
		}
	}
	_, err = repository.Prepare(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not configured source") {
		t.Fatalf("error = %v", err)
	}
}

func TestJJRevisionWorkspaceRetriesFailedForget(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	repository := &jjSourceRepository{
		jjCommand:  "jj",
		repository: filepath.Join(root, "repository"),
	}
	forgetCalls := 0
	repository.runCommand = func(_ context.Context, _ string, args []string, _ string) ([]byte, []byte, error) {
		if !hasArgumentSequence(args, "workspace", "forget") {
			t.Fatalf("args = %#v", args)
		}
		forgetCalls++
		if forgetCalls == 1 {
			return nil, []byte("repository busy"), errors.New("exit status 1")
		}
		return nil, nil, nil
	}
	workspaceRoot := filepath.Join(root, "workspace")
	if err := os.MkdirAll(workspaceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	workspace := &jjRevisionWorkspace{
		repository: repository,
		name:       "orchestra-test",
		root:       workspaceRoot,
		directory:  filepath.Join(workspaceRoot, "checkout"),
		forget:     true,
		remove:     true,
	}
	if err := workspace.Close(context.Background()); err == nil || !strings.Contains(err.Error(), "repository busy") {
		t.Fatalf("first close error = %v", err)
	}
	if _, err := os.Stat(workspaceRoot); !os.IsNotExist(err) {
		t.Fatalf("workspace root remained: %v", err)
	}
	if err := workspace.Close(context.Background()); err != nil {
		t.Fatalf("retry close: %v", err)
	}
	if forgetCalls != 2 {
		t.Fatalf("forget calls = %d", forgetCalls)
	}
}

func hasArgumentSequence(args []string, sequence ...string) bool {
	if len(sequence) == 0 {
		return true
	}
	for index := 0; index+len(sequence) <= len(args); index++ {
		matches := true
		for offset := range sequence {
			if args[index+offset] != sequence[offset] {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}
