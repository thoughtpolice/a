// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The :integration target builds only these sources, so nothing here may
// borrow a fixture from the unit tests.
const integrationTestCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

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
		defaultTdutilConfig(),
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

// The cache is a chain of parts each of which is unit-tested in isolation:
// identity resolution, key derivation, document serialization, the backend,
// and the revalidation a fetched document goes through. Only running the whole
// chain proves they agree with each other — that the key a write derives is
// the key a read looks under, and that what comes back rebuilds the graph that
// went in.
//
// The directory backend keeps this hermetic: no network, no credentials, and
// the same code path an s3:// location takes right up to the blob store.
func TestRealBuck2GraphRoundTripsThroughTheCache(t *testing.T) {
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
	const isolation = "tdutil-integration-cache"
	t.Cleanup(func() {
		killCtx, killCancel := context.WithTimeout(context.Background(), time.Minute)
		defer killCancel()
		_, _ = runner.run(killCtx, commandSpec{
			path: buck,
			args: []string{"--isolation-dir", isolation, "kill"},
			dir:  project,
		})
	})

	universe := []string{"root//pkg:"}
	collected, err := collectQuickSnapshot(ctx, runner, project, buck, nil, isolation, universe, defaultTdutilConfig())
	if err != nil {
		t.Fatal(err)
	}

	// The identity comes from the real buck2, exactly as a run would build it.
	identity, err := resolveSnapshotIdentity(ctx, runner, buck, project, universe, nil, defaultTdutilConfig())
	if err != nil {
		t.Fatal(err)
	}
	if identity.buckVersion == "" {
		t.Fatal("resolved identity records no buck2 version")
	}
	store, err := newDirStore(filepath.Join(t.TempDir(), "cache"), 0)
	if err != nil {
		t.Fatal(err)
	}
	cache := &snapshotCache{
		store:    store,
		identity: identity,
		write:    true,
		timeout:  time.Minute,
		tempDir:  t.TempDir(),
	}

	args := cliArgs{buck: buck, universe: universe, cacheWrite: true}
	var stderr strings.Builder
	cache.storeSnapshot(ctx, &args, "base", integrationTestCommit, true, &collected, &stderr)
	if stderr.Len() != 0 {
		t.Fatalf("storing a real graph reported %q", stderr.String())
	}

	document, err := cache.fetch(ctx, integrationTestCommit)
	if err != nil {
		t.Fatalf("a graph stored under this identity could not be fetched back: %v", err)
	}
	restored, err := document.toSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.targets) != len(collected.targets) {
		t.Fatalf("%d targets survived the round trip, want %d", len(restored.targets), len(collected.targets))
	}
	for label, original := range collected.targets {
		round, present := restored.targets[label]
		if !present {
			t.Fatalf("target %q did not survive the round trip", label)
		}
		if round.targetHash != original.targetHash {
			t.Fatalf("target %q hash = %q, want %q", label, round.targetHash, original.targetHash)
		}
	}

	// A second run against a different buck2 must not reuse this document, and
	// that check is what stops a cache from silently answering for a graph it
	// does not describe.
	drifted := *cache
	drifted.identity.buckVersion = identity.buckVersion + " (patched)"
	if _, err := drifted.fetch(ctx, integrationTestCommit); err == nil {
		t.Fatal("a document from another buck2 was accepted")
	}
}
