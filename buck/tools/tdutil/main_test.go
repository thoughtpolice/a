// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Port of main.rs::cleanup_failures_do_not_hide_the_primary_error.
func TestMainCleanupFailuresDoNotHidePrimaryError(t *testing.T) {
	cleanup := joinAdditionalErrors(errors.New("base cleanup failed"), errors.New("head cleanup failed"))
	combined := combineCleanupError(errors.New("graph failed"), cleanup)
	message := combined.Error()
	if !strings.HasPrefix(message, "graph failed; additionally") {
		t.Fatalf("error = %q", message)
	}
	if !strings.Contains(message, "base cleanup failed") || !strings.Contains(message, "head cleanup failed") {
		t.Fatalf("error = %q", message)
	}
}

// Port of main.rs::cleanup_failure_becomes_error_after_success.
func TestMainCleanupFailureBecomesErrorAfterSuccess(t *testing.T) {
	err := combineCleanupError(nil, errors.New("cleanup failed"))
	if err == nil || err.Error() != "cleanup failed" {
		t.Fatalf("error = %v, want cleanup failed", err)
	}
}

const pipelineTargetJSON = `{"name":"lib","buck.package":"depot//src","buck.type":"depot//rules.bzl:go_library","buck.deps":[],"buck.inputs":["depot//src/lib.go"],"buck.target_hash":"same"}
`

type pipelineRunner struct {
	repository string
	diff       []byte

	mu                 sync.Mutex
	commands           []commandSpec
	workspaceAdds      int
	workspaceForgets   int
	workspaceRoots     []string
	auditCalls         int
	targetCalls        int
	cleanupWasCanceled bool

	parallelAudits             chan struct{}
	parallelTargets            chan struct{}
	failHeadAdd                bool
	failBuck                   bool
	expectLocalBuckConfig      bool
	expectedLocalBuckConfig    []byte
	localBuckConfigCollisionAt int
	cancelOnTargets            func()
	cancelOnce                 sync.Once
}

// squashHistoryRunner models the same final tree before and after the working
// copy is squashed into the first commit after its fork from trunk. The former
// default revset resolves to that first commit, whose tree becomes identical
// to the new empty working-copy commit after a squash. The fork point itself is
// stable in both histories.
type squashHistoryRunner struct {
	*pipelineRunner
	squashed bool
}

func (runner *squashHistoryRunner) run(ctx context.Context, spec commandSpec) (processResult, error) {
	forkCommit := strings.Repeat("a", 40)
	branchRootCommit := strings.Repeat("b", 40)
	headCommit := strings.Repeat("c", 40)
	if runner.squashed {
		branchRootCommit = strings.Repeat("d", 40)
		headCommit = strings.Repeat("e", 40)
	}

	switch {
	case hasArgument(spec.args, "log"):
		revset := spec.args[len(spec.args)-1]
		commit := headCommit
		switch revset {
		case "fork_point(trunk() | @)":
			commit = forkCommit
		case "fork_point(trunk() | @)+ & ::@":
			commit = branchRootCommit
		}
		return processResult{stdout: []byte(commit + "\n")}, nil
	case hasArgument(spec.args, "diff"):
		var from, to string
		for index, argument := range spec.args {
			if index+1 >= len(spec.args) {
				continue
			}
			switch argument {
			case "--from":
				from = spec.args[index+1]
			case "--to":
				to = spec.args[index+1]
			}
		}
		sameTree := from == to || (runner.squashed && from == branchRootCommit && to == headCommit)
		if from != "" && sameTree {
			return processResult{}, nil
		}
	}

	return runner.pipelineRunner.run(ctx, spec)
}

func newPipelineRunner(repository string) *pipelineRunner {
	return &pipelineRunner{
		repository: repository,
		diff: []byte(`{"status":"modified","source":"src/lib.go","target":"src/lib.go"}
`),
	}
}

func (runner *pipelineRunner) requireParallelCollection() {
	runner.parallelAudits = make(chan struct{})
	runner.parallelTargets = make(chan struct{})
}

func (runner *pipelineRunner) run(ctx context.Context, spec commandSpec) (processResult, error) {
	recorded := commandSpec{path: spec.path, args: append([]string(nil), spec.args...), dir: spec.dir}
	runner.mu.Lock()
	runner.commands = append(runner.commands, recorded)
	runner.mu.Unlock()

	switch {
	case hasArgumentSuffix(spec.args, "workspace", "root"):
		return processResult{stdout: []byte(runner.repository + "\n")}, nil
	case hasArgument(spec.args, "log"):
		revset := spec.args[len(spec.args)-1]
		if revset == "@-" || revset == "base" {
			return processResult{stdout: []byte(strings.Repeat("a", 40) + "\n")}, nil
		}
		return processResult{stdout: []byte(strings.Repeat("b", 40) + "\n")}, nil
	case hasArgument(spec.args, "diff"):
		return processResult{stdout: append([]byte(nil), runner.diff...)}, nil
	case hasArgumentSequence(spec.args, "workspace", "add"):
		checkout := spec.args[len(spec.args)-1]
		if err := os.MkdirAll(checkout, 0o700); err != nil {
			return processResult{}, err
		}
		runner.mu.Lock()
		runner.workspaceAdds++
		addition := runner.workspaceAdds
		runner.workspaceRoots = append(runner.workspaceRoots, filepath.Dir(checkout))
		fail := runner.failHeadAdd && addition == 2
		collision := runner.localBuckConfigCollisionAt == addition
		runner.mu.Unlock()
		if collision {
			if err := os.WriteFile(filepath.Join(checkout, buckLocalConfigName), []byte("historical config\n"), 0o600); err != nil {
				return processResult{}, err
			}
		}
		if fail {
			return processResult{stderr: []byte("head add failed\n"), exitCode: 23}, nil
		}
		return processResult{}, nil
	case hasArgumentSequence(spec.args, "workspace", "forget"):
		runner.mu.Lock()
		runner.workspaceForgets++
		if ctx.Err() != nil {
			runner.cleanupWasCanceled = true
		}
		runner.mu.Unlock()
		return processResult{}, nil
	case hasArgumentSequence(spec.args, "audit", "cell"):
		if runner.expectLocalBuckConfig {
			got, err := os.ReadFile(filepath.Join(spec.dir, buckLocalConfigName))
			if err != nil {
				return processResult{}, fmt.Errorf("reading staged local Buck config: %w", err)
			}
			if !bytes.Equal(got, runner.expectedLocalBuckConfig) {
				return processResult{}, fmt.Errorf("staged local Buck config = %q, want %q", got, runner.expectedLocalBuckConfig)
			}
		}
		if err := runner.arriveAtAuditBarrier(ctx); err != nil {
			return processResult{}, err
		}
		return processResult{stdout: []byte(`{"depot":"."}`)}, nil
	case hasArgument(spec.args, "targets"):
		if err := runner.arriveAtTargetBarrier(ctx); err != nil {
			return processResult{}, err
		}
		if runner.cancelOnTargets != nil {
			runner.cancelOnce.Do(runner.cancelOnTargets)
			<-ctx.Done()
			return processResult{}, ctx.Err()
		}
		if runner.failBuck {
			return processResult{stderr: []byte("query failed\n"), exitCode: 7}, nil
		}
		return processResult{stdout: []byte(pipelineTargetJSON)}, nil
	default:
		return processResult{}, fmt.Errorf("unexpected command: %s %q", spec.path, spec.args)
	}
}

func (runner *pipelineRunner) arriveAtAuditBarrier(ctx context.Context) error {
	runner.mu.Lock()
	runner.auditCalls++
	count := runner.auditCalls
	barrier := runner.parallelAudits
	if barrier != nil && count == 2 {
		close(barrier)
	}
	runner.mu.Unlock()
	if barrier == nil {
		return nil
	}
	select {
	case <-barrier:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (runner *pipelineRunner) arriveAtTargetBarrier(ctx context.Context) error {
	runner.mu.Lock()
	runner.targetCalls++
	count := runner.targetCalls
	barrier := runner.parallelTargets
	if barrier != nil && count == 2 {
		close(barrier)
	}
	runner.mu.Unlock()
	if barrier == nil {
		return nil
	}
	select {
	case <-barrier:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (runner *pipelineRunner) snapshot() (commands []commandSpec, roots []string, adds, forgets, audits, targets int, cleanupCanceled bool) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	commands = append([]commandSpec(nil), runner.commands...)
	roots = append([]string(nil), runner.workspaceRoots...)
	return commands, roots, runner.workspaceAdds, runner.workspaceForgets, runner.auditCalls, runner.targetCalls, runner.cleanupWasCanceled
}

func hasArgument(arguments []string, wanted string) bool {
	for _, argument := range arguments {
		if argument == wanted {
			return true
		}
	}
	return false
}

func hasArgumentSuffix(arguments []string, suffix ...string) bool {
	return len(arguments) >= len(suffix) && hasArgumentSequence(arguments[len(arguments)-len(suffix):], suffix...)
}

func hasArgumentSequence(arguments []string, sequence ...string) bool {
	for start := 0; start+len(sequence) <= len(arguments); start++ {
		matched := true
		for offset, wanted := range sequence {
			if arguments[start+offset] != wanted {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func pipelineApplicationFixture(t *testing.T) (application, *pipelineRunner, string) {
	t.Helper()
	sandbox := t.TempDir()
	repository := filepath.Join(sandbox, "repository")
	temporary := filepath.Join(sandbox, "temporary")
	if err := os.Mkdir(repository, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(temporary, 0o755); err != nil {
		t.Fatal(err)
	}
	runner := newPipelineRunner(repository)
	app := application{
		runner: runner,
		getwd:  func() (string, error) { return repository, nil },
		tempDir: func() string {
			return temporary
		},
	}
	return app, runner, repository
}

func TestApplicationEqualTreeFastPathSkipsWorkspacesAndBuck(t *testing.T) {
	app, runner, _ := pipelineApplicationFixture(t)
	runner.diff = nil
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if err := runApplication(context.Background(), app, nil, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("stdout/stderr = %q / %q", stdout.String(), stderr.String())
	}
	commands, _, adds, forgets, audits, targets, _ := runner.snapshot()
	if adds != 0 || forgets != 0 || audits != 0 || targets != 0 {
		t.Fatalf("work after no-op: adds=%d forgets=%d audits=%d targets=%d", adds, forgets, audits, targets)
	}
	if len(commands) != 4 {
		t.Fatalf("commands = %d, want discovery, two resolutions, and diff", len(commands))
	}
}

func TestApplicationDefaultRangeIsStableAcrossSquash(t *testing.T) {
	for _, test := range []struct {
		name     string
		squashed bool
	}{
		{name: "before_squash"},
		{name: "after_squash", squashed: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app, pipeline, _ := pipelineApplicationFixture(t)
			app.runner = &squashHistoryRunner{pipelineRunner: pipeline, squashed: test.squashed}
			var stdout bytes.Buffer
			if err := runApplication(context.Background(), app, nil, &stdout, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			if got, want := stdout.String(), "depot//src:lib\n"; got != want {
				t.Fatalf("stdout = %q, want %q", got, want)
			}
		})
	}
}

func TestApplicationSuccessfulParallelSnapshotPathAndCleanup(t *testing.T) {
	app, runner, _ := pipelineApplicationFixture(t)
	runner.requireParallelCollection()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if err := runApplication(ctx, app, []string{"--ignore-working-copy"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if got, want := stdout.String(), "depot//src:lib\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
	_, roots, adds, forgets, audits, targets, cleanupCanceled := runner.snapshot()
	if adds != 2 || forgets != 2 || audits != 2 || targets != 2 {
		t.Fatalf("lifecycle = adds %d, forgets %d, audits %d, targets %d", adds, forgets, audits, targets)
	}
	if cleanupCanceled {
		t.Fatal("cleanup received a canceled context")
	}
	for _, root := range roots {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatalf("workspace root retained: %s (err=%v)", root, err)
		}
	}
}

func TestApplicationHeadWorkspaceCreationFailureCleansBothEndpoints(t *testing.T) {
	app, runner, _ := pipelineApplicationFixture(t)
	runner.failHeadAdd = true
	var stdout bytes.Buffer
	err := runApplication(context.Background(), app, nil, &stdout, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "jj workspace add failed") {
		t.Fatalf("error = %v", err)
	}
	_, roots, adds, forgets, audits, targets, _ := runner.snapshot()
	if adds != 2 || forgets != 2 || audits != 0 || targets != 0 {
		t.Fatalf("lifecycle = adds %d, forgets %d, audits %d, targets %d", adds, forgets, audits, targets)
	}
	for _, root := range roots {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatalf("workspace root retained: %s (err=%v)", root, err)
		}
	}
}

func TestApplicationBuckFailureStillCleansWorkspaces(t *testing.T) {
	app, runner, _ := pipelineApplicationFixture(t)
	runner.failBuck = true
	var stdout bytes.Buffer
	err := runApplication(context.Background(), app, nil, &stdout, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "buck2 targets failed") {
		t.Fatalf("error = %v", err)
	}
	_, roots, adds, forgets, audits, targets, _ := runner.snapshot()
	if adds != 2 || forgets != 2 || audits != 2 || targets != 2 {
		t.Fatalf("lifecycle = adds %d, forgets %d, audits %d, targets %d", adds, forgets, audits, targets)
	}
	for _, root := range roots {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatalf("workspace root retained: %s (err=%v)", root, err)
		}
	}
}

func TestApplicationKeepWorkspacesRetainsBoth(t *testing.T) {
	app, runner, _ := pipelineApplicationFixture(t)
	var stderr bytes.Buffer
	if err := runApplication(context.Background(), app, []string{"--keep-workspaces"}, &bytes.Buffer{}, &stderr); err != nil {
		t.Fatal(err)
	}
	_, roots, adds, forgets, _, _, _ := runner.snapshot()
	if adds != 2 || forgets != 0 || len(roots) != 2 {
		t.Fatalf("lifecycle = adds %d, forgets %d, roots %d", adds, forgets, len(roots))
	}
	if !strings.Contains(stderr.String(), "tdutil: retained workspaces") {
		t.Fatalf("stderr = %q", stderr.String())
	}
	for _, root := range roots {
		if _, err := os.Stat(root); err != nil {
			t.Fatalf("retained root %s: %v", root, err)
		}
		if err := os.RemoveAll(root); err != nil {
			t.Fatal(err)
		}
	}
}

func TestApplicationInstallsLocalBuckConfigBeforeBuckQueries(t *testing.T) {
	app, runner, repository := pipelineApplicationFixture(t)
	contents := []byte("[buck2]\nfile_watcher = fs_hash_crawler\n")
	if err := os.WriteFile(filepath.Join(repository, buckLocalConfigName), contents, 0o600); err != nil {
		t.Fatal(err)
	}
	runner.expectLocalBuckConfig = true
	runner.expectedLocalBuckConfig = contents
	if err := runApplication(
		context.Background(),
		app,
		[]string{"--config", "ci.enabled=true"},
		&bytes.Buffer{},
		&bytes.Buffer{},
	); err != nil {
		t.Fatal(err)
	}
	commands, _, _, _, audits, targets, _ := runner.snapshot()
	if audits != 2 || targets != 2 {
		t.Fatalf("queries = audits %d, targets %d", audits, targets)
	}
	for _, command := range commands {
		if !hasArgumentSequence(command.args, "audit", "cell") && !hasArgument(command.args, "targets") {
			continue
		}
		if hasArgument(command.args, "--config-file") {
			t.Fatalf("local config was also forwarded as a command argument: %q", command.args)
		}
		if !hasArgumentSequence(command.args, "-c", "ci.enabled=true") {
			t.Fatalf("explicit Buck config missing from command: %q", command.args)
		}
	}
}

func TestApplicationLocalBuckConfigCollisionCleansBothWorkspaces(t *testing.T) {
	app, runner, repository := pipelineApplicationFixture(t)
	if err := os.WriteFile(
		filepath.Join(repository, buckLocalConfigName),
		[]byte("[buck2]\nfile_watcher = fs_hash_crawler\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	runner.localBuckConfigCollisionAt = 2
	err := runApplication(context.Background(), app, nil, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !errors.Is(err, os.ErrExist) {
		t.Fatalf("collision error = %v, want os.ErrExist", err)
	}
	_, roots, adds, forgets, audits, targets, _ := runner.snapshot()
	if adds != 2 || forgets != 2 || audits != 0 || targets != 0 {
		t.Fatalf("lifecycle = adds %d, forgets %d, audits %d, targets %d", adds, forgets, audits, targets)
	}
	for _, root := range roots {
		if _, statErr := os.Stat(root); !os.IsNotExist(statErr) {
			t.Fatalf("workspace root retained: %s (err=%v)", root, statErr)
		}
	}
}

func TestApplicationCancellationStillUsesLiveCleanupContext(t *testing.T) {
	app, runner, _ := pipelineApplicationFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	runner.cancelOnTargets = cancel
	var stdout bytes.Buffer
	err := runApplication(ctx, app, nil, &stdout, &bytes.Buffer{})
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context canceled", err)
	}
	_, roots, adds, forgets, audits, targets, cleanupCanceled := runner.snapshot()
	if adds != 2 || forgets != 2 || audits != 2 || targets != 2 {
		t.Fatalf("lifecycle = adds %d, forgets %d, audits %d, targets %d", adds, forgets, audits, targets)
	}
	if cleanupCanceled {
		t.Fatal("workspace forget received canceled context")
	}
	for _, root := range roots {
		if _, statErr := os.Stat(root); !os.IsNotExist(statErr) {
			t.Fatalf("workspace root retained: %s (err=%v)", root, statErr)
		}
	}
}
