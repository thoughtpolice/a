// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func workspaceAllocationFixture(t *testing.T) (sandbox, repository, tempBase string) {
	t.Helper()
	sandbox = t.TempDir()
	repository = filepath.Join(sandbox, "repository")
	tempBase = filepath.Join(sandbox, "temporary")
	if err := os.Mkdir(repository, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(tempBase, 0o755); err != nil {
		t.Fatal(err)
	}
	return sandbox, repository, tempBase
}

// Port of workspace.rs::generated_names_are_unique_and_safe.
func TestWorkspaceGeneratedNamesAreUniqueAndSafe(t *testing.T) {
	first := uniqueWorkspaceName()
	second := uniqueWorkspaceName()
	if first == second {
		t.Fatalf("generated duplicate name %q", first)
	}
	for _, name := range []string{first, second} {
		if !strings.HasPrefix(name, "tdutil-") {
			t.Fatalf("name = %q", name)
		}
		for _, char := range []byte(name) {
			if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-') {
				t.Fatalf("unsafe workspace name %q", name)
			}
		}
		if strings.ContainsAny(name, `/\`) {
			t.Fatalf("unsafe separator in %q", name)
		}
	}
}

func TestWorkspaceOwnerPidParsing(t *testing.T) {
	pid, ok := parseWorkspaceOwnerPid(uniqueWorkspaceName())
	if !ok || pid != os.Getpid() {
		t.Fatalf("own workspace name parsed to pid=%d ok=%v, want %d", pid, ok, os.Getpid())
	}
	for _, name := range []string{
		"default",
		"work",
		"tdutil-",
		"tdutil-1-2",
		"tdutil-1-2-3-4",
		"tdutil-zz-1-2",
		"tdutil-1-zz-2",
		"tdutil-1-2-zz",
		"tdutil-0-1-2",
		"tdutil--1-2",
		"tdutil-1-2-",
		"sometdutil-1-2-3",
	} {
		if pid, ok := parseWorkspaceOwnerPid(name); ok {
			t.Errorf("parsed %q to pid %d, want rejection", name, pid)
		}
	}
}

func TestProcessLivenessProbeSeesOwnProcess(t *testing.T) {
	if !processIsAlive(os.Getpid()) {
		t.Fatal("own process reported dead")
	}
}

func sweepTestClient(t *testing.T, list func() (processResult, error), forgotten *[]string) *jjClient {
	t.Helper()
	runner := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		switch {
		case hasArgumentSequence(spec.args, "workspace", "list"):
			return list()
		case hasArgumentSequence(spec.args, "workspace", "forget"):
			*forgotten = append(*forgotten, spec.args[len(spec.args)-1])
			return processResult{}, nil
		}
		t.Fatalf("unexpected command %q", spec.args)
		return processResult{}, nil
	}}
	return jjAtRepository(runner, "jj", t.TempDir())
}

func TestSweepForgetsOnlyProvablyDeadTdutilWorkspaces(t *testing.T) {
	var forgotten []string
	list := func() (processResult, error) {
		return processResult{stdout: []byte("default\ntdutil-2a-1f-0\ntdutil-3b-1f-0\ntdutil-zz-a-b\nwork\n")}, nil
	}
	var logged []string
	sweepOrphanedWorkspaces(
		context.Background(),
		sweepTestClient(t, list, &forgotten),
		func(pid int) bool { return pid != 0x2a },
		func(format string, values ...any) { logged = append(logged, fmt.Sprintf(format, values...)) },
	)
	if !slices.Equal(forgotten, []string{"tdutil-2a-1f-0"}) {
		t.Fatalf("forgotten = %#v", forgotten)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "tdutil-2a-1f-0") {
		t.Fatalf("logged = %#v", logged)
	}
}

func TestSweepToleratesListAndForgetFailures(t *testing.T) {
	var forgotten []string
	failingList := func() (processResult, error) {
		return processResult{stderr: []byte("locked\n"), exitCode: 1}, nil
	}
	var logged []string
	log := func(format string, values ...any) { logged = append(logged, fmt.Sprintf(format, values...)) }
	sweepOrphanedWorkspaces(context.Background(), sweepTestClient(t, failingList, &forgotten), func(int) bool { return false }, log)
	if len(forgotten) != 0 {
		t.Fatalf("forgotten after list failure = %#v", forgotten)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "skipping orphaned workspace sweep") {
		t.Fatalf("logged = %#v", logged)
	}

	failingForget := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		if hasArgumentSequence(spec.args, "workspace", "list") {
			return processResult{stdout: []byte("tdutil-2a-1f-0\ntdutil-3b-1f-0\n")}, nil
		}
		return processResult{stderr: []byte("stale\n"), exitCode: 1}, nil
	}}
	logged = nil
	sweepOrphanedWorkspaces(
		context.Background(),
		jjAtRepository(failingForget, "jj", t.TempDir()),
		func(int) bool { return false },
		log,
	)
	if len(logged) != 2 {
		t.Fatalf("logged = %#v", logged)
	}
	for _, entry := range logged {
		if !strings.Contains(entry, "could not forget orphaned workspace") {
			t.Fatalf("logged = %#v", logged)
		}
	}
}

// Port of workspace.rs::allocations_are_unique_outside_repository_with_absent_checkouts.
func TestWorkspaceAllocationsAreUniqueOutsideRepositoryWithAbsentCheckouts(t *testing.T) {
	_, repository, tempBase := workspaceAllocationFixture(t)
	first, err := allocateWorkspaceLocation(repository, tempBase, tempBase)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = removeWorkspaceDirectory(first.root) }()
	second, err := allocateWorkspaceLocation(repository, tempBase, tempBase)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = removeWorkspaceDirectory(second.root) }()
	if first.root == second.root {
		t.Fatalf("allocations share root %q", first.root)
	}
	canonicalTemp, err := filepath.EvalSymlinks(tempBase)
	if err != nil {
		t.Fatal(err)
	}
	for _, location := range []workspaceLocation{first, second} {
		if !filepath.IsAbs(location.root) || !strings.HasPrefix(location.root, canonicalTemp+string(filepath.Separator)) {
			t.Fatalf("root %q is not inside temp base %q", location.root, canonicalTemp)
		}
		if inside, err := filesystemPathIsWithin(repository, location.root); err != nil || inside {
			t.Fatalf("root %q inside repository %q (inside=%v, err=%v)", location.root, repository, inside, err)
		}
		if _, err := os.Stat(location.checkout); !os.IsNotExist(err) {
			t.Fatalf("checkout unexpectedly exists: %q (err=%v)", location.checkout, err)
		}
		if location.checkout != filepath.Join(location.root, "checkout") {
			t.Fatalf("checkout = %q", location.checkout)
		}
	}
}

// Port of workspace.rs::relative_temp_base_is_normalized_to_an_absolute_path.
func TestWorkspaceRelativeTempBaseIsNormalizedToAbsolutePath(t *testing.T) {
	sandbox, repository, tempBase := workspaceAllocationFixture(t)
	relativeBase, err := filepath.Rel(sandbox, tempBase)
	if err != nil {
		t.Fatal(err)
	}
	location, err := allocateWorkspaceLocation(repository, relativeBase, sandbox)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = removeWorkspaceDirectory(location.root) }()
	if !filepath.IsAbs(location.root) {
		t.Fatalf("root is relative: %q", location.root)
	}
	canonicalTemp, err := filepath.EvalSymlinks(tempBase)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(location.root, canonicalTemp+string(filepath.Separator)) {
		t.Fatalf("root %q is not under %q", location.root, canonicalTemp)
	}
}

// Port of workspace.rs::repository_local_temp_base_is_rejected.
func TestWorkspaceRepositoryLocalTempBaseIsRejected(t *testing.T) {
	_, repository, _ := workspaceAllocationFixture(t)
	repositoryWork := filepath.Join(repository, "work")
	if err := os.Mkdir(repositoryWork, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := allocateWorkspaceLocation(repository, repositoryWork, repository)
	if err == nil {
		t.Fatal("repository-local temporary base was accepted")
	}
	message := err.Error()
	if !strings.Contains(message, "temporary workspace base") || !strings.Contains(message, "must be outside repository") {
		t.Fatalf("error = %q", message)
	}
	canonicalWork, canonicalErr := filepath.EvalSymlinks(repositoryWork)
	if canonicalErr != nil {
		t.Fatal(canonicalErr)
	}
	if !strings.Contains(message, canonicalWork) {
		t.Fatalf("error %q lacks path %q", message, canonicalWork)
	}
}

// Port of workspace.rs::invalid_temp_base_has_context.
func TestWorkspaceInvalidTempBaseHasContext(t *testing.T) {
	sandbox, repository, _ := workspaceAllocationFixture(t)
	missing := filepath.Join(sandbox, "does-not-exist")
	_, err := allocateWorkspaceLocation(repository, missing, sandbox)
	if err == nil {
		t.Fatal("missing temporary base was accepted")
	}
	message := err.Error()
	if !strings.Contains(message, "resolving tdutil temporary workspace base") || !strings.Contains(message, missing) {
		t.Fatalf("error = %q", message)
	}
}

// Port of workspace.rs::container_cleanup_removes_checkout_and_is_idempotent.
func TestWorkspaceContainerCleanupRemovesCheckoutAndIsIdempotent(t *testing.T) {
	_, repository, tempBase := workspaceAllocationFixture(t)
	location, err := allocateWorkspaceLocation(repository, tempBase, tempBase)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(location.checkout, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(location.checkout, "materialized"), []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removeWorkspaceDirectory(location.root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(location.root); !os.IsNotExist(err) {
		t.Fatalf("root still exists (err=%v)", err)
	}
	if err := removeWorkspaceDirectory(location.root); err != nil {
		t.Fatal(err)
	}
}

// Port of workspace.rs::keep_retains_container_and_returns_checkout_path.
func TestWorkspaceKeepRetainsContainerAndReturnsCheckoutPath(t *testing.T) {
	_, repository, tempBase := workspaceAllocationFixture(t)
	location, err := allocateWorkspaceLocation(repository, tempBase, tempBase)
	if err != nil {
		t.Fatal(err)
	}
	workspace := &workspace{
		jj:       jjAtRepository(nil, "jj-must-not-run", repository),
		name:     "tdutil-keep-test",
		root:     location.root,
		checkout: location.checkout,
		cleanup:  pendingCleanup(),
	}
	if got := workspace.keep(); got != location.checkout {
		t.Fatalf("keep returned %q, want %q", got, location.checkout)
	}
	if _, err := os.Stat(location.root); err != nil {
		t.Fatalf("retained root: %v", err)
	}
	if err := removeWorkspaceDirectory(location.root); err != nil {
		t.Fatal(err)
	}
}

// Port of workspace.rs::container_is_owner_only_on_unix.
func TestWorkspaceContainerIsOwnerOnlyOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits are not meaningful on Windows")
	}
	_, repository, tempBase := workspaceAllocationFixture(t)
	location, err := allocateWorkspaceLocation(repository, tempBase, tempBase)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = removeWorkspaceDirectory(location.root) }()
	info, err := os.Stat(location.root)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("mode = %#o, want 0700", got)
	}
}

func TestBuckLocalConfigSnapshotMissingIsNoop(t *testing.T) {
	repository := t.TempDir()
	checkout := t.TempDir()
	config, err := snapshotBuckLocalConfig(repository)
	if err != nil {
		t.Fatal(err)
	}
	if config != nil {
		t.Fatalf("snapshot = %#v, want nil", config)
	}
	if err := config.install(checkout); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(checkout, buckLocalConfigName)); !os.IsNotExist(err) {
		t.Fatalf("missing config was installed (err=%v)", err)
	}
}

func TestBuckLocalConfigSnapshotIsStableAndPrivate(t *testing.T) {
	repository := t.TempDir()
	checkout := t.TempDir()
	source := filepath.Join(repository, buckLocalConfigName)
	original := []byte("[buck2]\nfile_watcher = fs_hash_crawler\n")
	if err := os.WriteFile(source, original, 0o644); err != nil {
		t.Fatal(err)
	}
	config, err := snapshotBuckLocalConfig(repository)
	if err != nil {
		t.Fatal(err)
	}
	if config == nil {
		t.Fatal("existing config produced a nil snapshot")
	}
	if err := os.WriteFile(source, []byte("[buck2]\nfile_watcher = watchman\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := config.install(checkout); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(checkout, buckLocalConfigName)
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(original) {
		t.Fatalf("installed config = %q, want snapshotted %q", got, original)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(destination)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("installed config mode = %#o, want 0600", got)
		}
	}
}

func TestBuckLocalConfigInstallRefusesExistingPath(t *testing.T) {
	repository := t.TempDir()
	checkout := t.TempDir()
	source := filepath.Join(repository, buckLocalConfigName)
	if err := os.WriteFile(source, []byte("new config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := snapshotBuckLocalConfig(repository)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(checkout, buckLocalConfigName)
	if err := os.WriteFile(destination, []byte("historical config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = config.install(checkout)
	if err == nil || !errors.Is(err, os.ErrExist) {
		t.Fatalf("collision error = %v, want os.ErrExist", err)
	}
	got, readErr := os.ReadFile(destination)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "historical config\n" {
		t.Fatalf("existing config was overwritten: %q", got)
	}
}

func TestBuckLocalConfigSnapshotRejectsNonRegularSource(t *testing.T) {
	repository := t.TempDir()
	source := filepath.Join(repository, buckLocalConfigName)
	if err := os.Mkdir(source, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := snapshotBuckLocalConfig(repository)
	if err == nil || !strings.Contains(err.Error(), "is not a regular file") {
		t.Fatalf("non-regular source error = %v", err)
	}
}

// Port of workspace.rs::failed_forget_remains_pending_after_directory_removal.
func TestWorkspaceFailedForgetRemainsPendingAfterDirectoryRemoval(t *testing.T) {
	state := pendingCleanup()
	forgetAttempts := 0
	removeAttempts := 0
	err := state.run(
		func() error {
			forgetAttempts++
			return errors.New("forget failed")
		},
		func() error {
			removeAttempts++
			return nil
		},
	)
	if err == nil || err.Error() != "forget failed" {
		t.Fatalf("error = %v", err)
	}
	if forgetAttempts != 1 || removeAttempts != 1 {
		t.Fatalf("attempts = forget %d, remove %d", forgetAttempts, removeAttempts)
	}
	if err := state.run(
		func() error { forgetAttempts++; return nil },
		func() error { removeAttempts++; return nil },
	); err != nil {
		t.Fatal(err)
	}
	if forgetAttempts != 2 || removeAttempts != 1 {
		t.Fatalf("attempts = forget %d, remove %d", forgetAttempts, removeAttempts)
	}
}

// Port of workspace.rs::failed_directory_removal_remains_pending_after_forget.
func TestWorkspaceFailedDirectoryRemovalRemainsPendingAfterForget(t *testing.T) {
	state := pendingCleanup()
	forgetAttempts := 0
	removeAttempts := 0
	err := state.run(
		func() error { forgetAttempts++; return nil },
		func() error { removeAttempts++; return errors.New("remove failed") },
	)
	if err == nil || err.Error() != "remove failed" {
		t.Fatalf("error = %v", err)
	}
	if err := state.run(
		func() error { forgetAttempts++; return nil },
		func() error { removeAttempts++; return nil },
	); err != nil {
		t.Fatal(err)
	}
	if forgetAttempts != 1 || removeAttempts != 2 {
		t.Fatalf("attempts = forget %d, remove %d", forgetAttempts, removeAttempts)
	}
}

// Port of workspace.rs::suppressed_cleanup_runs_no_steps.
func TestWorkspaceSuppressedCleanupRunsNoSteps(t *testing.T) {
	state := pendingCleanup()
	state.suppress()
	if err := state.run(
		func() error { t.Fatal("forget should not run"); return nil },
		func() error { t.Fatal("remove should not run"); return nil },
	); err != nil {
		t.Fatal(err)
	}
}
