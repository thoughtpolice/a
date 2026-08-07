// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type buckFakeRunner struct {
	runFunc func(context.Context, commandSpec) (processResult, error)
}

func (runner buckFakeRunner) run(ctx context.Context, spec commandSpec) (processResult, error) {
	return runner.runFunc(ctx, spec)
}

func successfulBuckResult(stdout []byte) processResult {
	return processResult{stdout: stdout, exitCode: 0}
}

func cellAuditFor(t *testing.T, workspace string) []byte {
	t.Helper()
	audit, err := json.Marshal(map[string]string{"root": workspace})
	if err != nil {
		t.Fatal(err)
	}
	return audit
}

func commandContains(spec commandSpec, argument string) bool {
	return slices.Contains(spec.args, argument)
}
func TestAuditCellsUsesExactArgumentOrder(t *testing.T) {
	workspace := t.TempDir()
	var got commandSpec
	runner := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		got = spec
		return successfulBuckResult(cellAuditFor(t, workspace)), nil
	}}
	_, err := auditCells(
		context.Background(),
		runner,
		workspace,
		"custom-buck2",
		[]string{"--config", "ci.mode=test"},
		"tdutil-isolation",
	)
	if err != nil {
		t.Fatal(err)
	}
	wantArgs := []string{
		"--isolation-dir", "tdutil-isolation",
		"audit", "cell", "--json",
		"--config", "ci.mode=test",
	}
	if got.path != "custom-buck2" || got.dir != workspace || !slices.Equal(got.args, wantArgs) {
		t.Fatalf("command = path=%q dir=%q args=%#v", got.path, got.dir, got.args)
	}
}

func TestCollectTargetsUsesExactArgumentOrder(t *testing.T) {
	workspace := t.TempDir()
	cells := testCellMap(t)
	var got commandSpec
	runner := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		got = spec
		return successfulBuckResult([]byte(targetJSON("app"))), nil
	}}
	snapshot, err := collectTargets(
		context.Background(),
		runner,
		workspace,
		"custom-buck2",
		[]string{"--config", "ci.mode=test"},
		"tdutil-isolation",
		[]string{"root//src/app:app", "root//tools/..."},
		cells,

		defaultTdutilConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	wantArgs := []string{
		"--isolation-dir", "tdutil-isolation",
		"targets",
		"--config", "ci.mode=test",
		"--streaming",
		"--no-cache",
		"--show-unconfigured-target-hash",
		"--json-lines",
		"--imports",
		"--output-attribute=" + targetAttributesFor(defaultTdutilConfig()),
		"root//src/app:app",
		"root//tools/...",
	}
	if got.path != "custom-buck2" || got.dir != workspace || !slices.Equal(got.args, wantArgs) {
		t.Fatalf("command = path=%q dir=%q args=%#v", got.path, got.dir, got.args)
	}
	if _, ok := snapshot.targets["root//src/app:app"]; !ok {
		t.Fatalf("parsed targets = %#v", snapshot.targets)
	}
}

func TestCollectTargetsSkipsCommandForAbsentEndpoint(t *testing.T) {
	cells := singleCellMap(t, t.TempDir())
	runner := buckFakeRunner{runFunc: func(context.Context, commandSpec) (processResult, error) {
		t.Fatal("runner called for endpoint without patterns")
		return processResult{}, nil
	}}
	snapshot, err := collectTargets(context.Background(), runner, "unused", "buck2", nil, "", nil, cells, defaultTdutilConfig())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.targets) != 0 || len(snapshot.files) != 0 {
		t.Fatalf("empty endpoint snapshot = %#v", snapshot)
	}
}

type streamingBuckRunner struct {
	t        *testing.T
	stdout   []byte
	result   processResult
	streamed int
}

func (runner *streamingBuckRunner) run(context.Context, commandSpec) (processResult, error) {
	runner.t.Fatal("buffered run used despite streaming support")
	return processResult{}, nil
}

func (runner *streamingBuckRunner) runLines(_ context.Context, _ commandSpec, line func([]byte)) (processResult, error) {
	runner.streamed++
	feedLines(runner.stdout, line)
	return runner.result, nil
}

func TestCollectTargetsPrefersStreamingRunnerAndParsesIncrementally(t *testing.T) {
	runner := &streamingBuckRunner{t: t, stdout: []byte(targetJSON("app") + "\n")}
	snapshot, err := collectTargets(
		context.Background(),
		runner,
		t.TempDir(),
		"buck2",
		nil,
		"",
		[]string{"root//src/app:app"},
		testCellMap(t),

		defaultTdutilConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if runner.streamed != 1 {
		t.Fatalf("streamed = %d", runner.streamed)
	}
	if _, ok := snapshot.targets["root//src/app:app"]; !ok {
		t.Fatalf("parsed targets = %#v", snapshot.targets)
	}
}

func TestCollectTargetsProcessFailureOutranksStreamedParseError(t *testing.T) {
	runner := &streamingBuckRunner{
		t:      t,
		stdout: []byte("this is not JSON\n"),
		result: processResult{stderr: []byte("daemon exploded\n"), exitCode: 7},
	}
	_, err := collectTargets(
		context.Background(),
		runner,
		t.TempDir(),
		"buck2",
		nil,
		"",
		[]string{"root//src/app:app"},
		testCellMap(t),

		defaultTdutilConfig(),
	)
	if err == nil || !strings.Contains(err.Error(), "exit 7") || !strings.Contains(err.Error(), "daemon exploded") {
		t.Fatalf("error = %v, want process failure", err)
	}
}

func TestCollectTargetsStreamedParseErrorKeepsLineNumber(t *testing.T) {
	runner := &streamingBuckRunner{
		t:      t,
		stdout: []byte(targetJSON("app") + "\n\nthis is not JSON\n"),
	}
	_, err := collectTargets(
		context.Background(),
		runner,
		t.TempDir(),
		"buck2",
		nil,
		"",
		[]string{"root//src/app:app"},
		testCellMap(t),

		defaultTdutilConfig(),
	)
	if err == nil || !strings.Contains(err.Error(), "output line 3") {
		t.Fatalf("error = %v, want line 3 parse failure", err)
	}
}

func TestBuckCollectorsRejectNonUTF8Stdout(t *testing.T) {
	workspace := t.TempDir()
	cells := singleCellMap(t, workspace)
	runner := buckFakeRunner{runFunc: func(context.Context, commandSpec) (processResult, error) {
		return successfulBuckResult([]byte{0xff}), nil
	}}
	if _, err := auditCells(context.Background(), runner, workspace, "buck2", nil, ""); err == nil || !strings.Contains(err.Error(), "non-UTF-8 stdout") {
		t.Errorf("audit invalid-UTF-8 error = %v", err)
	}
	if _, err := collectTargets(context.Background(), runner, workspace, "buck2", nil, "", []string{"root//..."}, cells, defaultTdutilConfig()); err == nil || !strings.Contains(err.Error(), "non-UTF-8 stdout") {
		t.Errorf("targets invalid-UTF-8 error = %v", err)
	}
}
func TestBuckProcessFailureReportsStatusAndTrimmedStderr(t *testing.T) {
	exited := processResult{exitCode: 17, stderr: []byte("  target failed\n")}
	err := ensureBuckProcessSuccess("buck2 targets", exited)
	if err == nil || !strings.Contains(err.Error(), "exit 17") || !strings.HasSuffix(err.Error(), "target failed") {
		t.Fatalf("exit error = %v", err)
	}
	signaled := processResult{signaled: true, exitCode: -1, stderr: []byte("killed")}
	err = ensureBuckProcessSuccess("buck2 audit cell", signaled)
	if err == nil || !strings.Contains(err.Error(), "terminated by signal") {
		t.Fatalf("signal error = %v", err)
	}
	if err := ensureBuckProcessSuccess("buck2 targets", processResult{}); err != nil {
		t.Fatalf("success = %v", err)
	}
}

func TestCollectSnapshotPairRejectsEmptyPatterns(t *testing.T) {
	runner := buckFakeRunner{runFunc: func(context.Context, commandSpec) (processResult, error) {
		t.Fatal("runner called for an empty universe")
		return processResult{}, nil
	}}
	_, _, _, err := collectSnapshotPair(context.Background(), runner, "base", "head", "buck2", nil, "", nil, defaultTdutilConfig())
	if err == nil || !strings.Contains(err.Error(), "at least one Buck target pattern") {
		t.Fatalf("empty-pattern error = %v", err)
	}
}

func TestCollectSnapshotPairRunsBothEndpointStagesConcurrentlyAndPrefersBaseError(t *testing.T) {
	baseWorkspace := t.TempDir()
	headWorkspace := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var auditStarted atomic.Int32
	var targetsStarted atomic.Int32
	auditsReady := make(chan struct{})
	targetsReady := make(chan struct{})
	var closeAudits sync.Once
	var closeTargets sync.Once
	runner := buckFakeRunner{runFunc: func(ctx context.Context, spec commandSpec) (processResult, error) {
		if commandContains(spec, "audit") {
			if auditStarted.Add(1) == 2 {
				closeAudits.Do(func() { close(auditsReady) })
			}
			select {
			case <-auditsReady:
				return successfulBuckResult(cellAuditFor(t, spec.dir)), nil
			case <-ctx.Done():
				return processResult{}, ctx.Err()
			}
		}
		if commandContains(spec, "targets") {
			if targetsStarted.Add(1) == 2 {
				closeTargets.Do(func() { close(targetsReady) })
			}
			select {
			case <-targetsReady:
				if spec.dir == baseWorkspace {
					return processResult{}, errors.New("base collection failed")
				}
				return processResult{}, errors.New("head collection failed")
			case <-ctx.Done():
				return processResult{}, ctx.Err()
			}
		}
		return processResult{}, errors.New("unexpected Buck command")
	}}

	_, _, _, err := collectSnapshotPair(
		ctx,
		runner,
		baseWorkspace,
		headWorkspace,
		"buck2",
		nil,
		"",
		[]string{"root//..."},
		defaultTdutilConfig(),
	)
	if err == nil || !strings.Contains(err.Error(), "base collection failed") || strings.Contains(err.Error(), "head collection failed") {
		t.Fatalf("paired error = %v", err)
	}
	if auditStarted.Load() != 2 || targetsStarted.Load() != 2 {
		t.Fatalf("started audit=%d target=%d endpoint commands", auditStarted.Load(), targetsStarted.Load())
	}
}
