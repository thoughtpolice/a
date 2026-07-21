// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// tdutil recognizes two buck2 diagnostics by their exact text (universe.go):
// the missing-package error and the unknown-target error. A buck2 upgrade that
// rewords either fails closed — expected endpoint diagnostics become hard
// failures — which is safe but disruptive. This test runs the real buck2
// against a synthetic project through the production collection path and fails
// loudly when the wording drifts, so a buck2 upgrade and the recognizers land
// together.
func TestRealBuck2DiagnosticsAreRecognized(t *testing.T) {
	buck := os.Getenv("TDUTIL_INTEGRATION_BUCK2")
	if buck == "" {
		located, err := exec.LookPath("buck2")
		if err != nil {
			t.Skip("buck2 is not on PATH; set TDUTIL_INTEGRATION_BUCK2 to run this test")
		}
		buck = located
	}

	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, ".buckconfig"), []byte("[cells]\nroot = .\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(project, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "pkg", "BUCK"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("HOME") == "" {
		home := filepath.Join(project, "home")
		if err := os.Mkdir(home, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("HOME", home)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	runner := osProcessRunner{}
	const isolation = "tdutil-integration"
	t.Cleanup(func() {
		killCtx, killCancel := context.WithTimeout(context.Background(), time.Minute)
		defer killCancel()
		_, _ = runner.run(killCtx, commandSpec{
			path: buck,
			args: []string{"--isolation-dir", isolation, "kill"},
			dir:  project,
		})
	})

	cells, err := auditCells(ctx, runner, project, buck, nil, isolation)
	if err != nil {
		t.Fatal(err)
	}
	collected, err := collectTargets(
		ctx,
		runner,
		project,
		buck,
		nil,
		isolation,
		[]string{"root//pkg:missing", "root//absent:"},
		cells,
	)
	if err != nil {
		t.Fatal(err)
	}

	absent := collected.errors["root//absent"]
	if len(absent) != 1 || !isMissingPackageError("root//absent", absent[0]) {
		t.Errorf(
			"buck2's missing-package diagnostic is no longer recognized; update isMissingPackageError for %#v",
			absent,
		)
	}
	unknown := collected.errors["root//pkg"]
	var names []string
	recognized := false
	if len(unknown) == 1 {
		names, recognized = parseUnknownTargetDiagnostic("root//pkg", unknown[0])
	}
	if !recognized || len(names) != 1 || names[0] != "missing" {
		t.Errorf(
			"buck2's unknown-target diagnostic is no longer recognized; update parseUnknownTargetDiagnostic for %#v",
			unknown,
		)
	}
}
