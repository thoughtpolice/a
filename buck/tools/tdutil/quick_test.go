// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// quickAuditFor mirrors testCellMap's cell layout as a raw `buck2 audit cell`
// payload anchored at the test workspace, so targetJSON records resolve.
func quickAuditFor(t *testing.T, workspace string) []byte {
	t.Helper()
	audit, err := json.Marshal(map[string]string{
		"root":     workspace,
		"nested":   filepath.Join(workspace, "src", "nested"),
		"external": filepath.Join(filepath.Dir(workspace), "external"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return audit
}

func TestCollectQuickSnapshotRunsOneAuditAndOneDumpInWorkspace(t *testing.T) {
	workspace := t.TempDir()
	var specs []commandSpec
	runner := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		specs = append(specs, spec)
		if hasArgumentSequence(spec.args, "audit", "cell") {
			return successfulBuckResult(quickAuditFor(t, workspace)), nil
		}
		return successfulBuckResult([]byte(targetJSON("app"))), nil
	}}
	collected, err := collectQuickSnapshot(
		context.Background(),
		runner,
		workspace,
		"buck2",
		nil,
		"tdutil-isolation",
		[]string{"root//..."},
		defaultTdutilConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(specs) != 2 {
		t.Fatalf("commands = %d, want one audit and one dump", len(specs))
	}
	for _, spec := range specs {
		if spec.dir != workspace {
			t.Fatalf("command ran outside the workspace: %q in %q", spec.args, spec.dir)
		}
	}
	if !hasArgumentSequence(specs[0].args, "audit", "cell") || !hasArgument(specs[1].args, "targets") {
		t.Fatalf("command order = %#v", specs)
	}
	if _, ok := collected.targets["root//src/app:app"]; !ok {
		t.Fatalf("parsed targets = %#v", collected.targets)
	}
}

func TestCollectQuickSnapshotFailsClosedOnMissingUniverseTarget(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "src", "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	runner := buckFakeRunner{runFunc: func(_ context.Context, spec commandSpec) (processResult, error) {
		if hasArgumentSequence(spec.args, "audit", "cell") {
			return successfulBuckResult(quickAuditFor(t, workspace)), nil
		}
		return successfulBuckResult([]byte(targetJSON("app"))), nil
	}}
	_, err := collectQuickSnapshot(
		context.Background(),
		runner,
		workspace,
		"buck2",
		nil,
		"",
		[]string{"root//src/app:absent"},
		defaultTdutilConfig(),
	)
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("error = %v, want missing-target universe failure", err)
	}
}

func TestCollectQuickSnapshotRejectsEmptyPatterns(t *testing.T) {
	runner := buckFakeRunner{runFunc: func(context.Context, commandSpec) (processResult, error) {
		t.Fatal("runner called for an empty universe")
		return processResult{}, nil
	}}
	_, err := collectQuickSnapshot(context.Background(), runner, "unused", "buck2", nil, "", nil, defaultTdutilConfig())
	if err == nil || !strings.Contains(err.Error(), "at least one Buck target pattern") {
		t.Fatalf("empty-pattern error = %v", err)
	}
}
