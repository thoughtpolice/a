// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These tests pin the tdutil-to-Orchestra adapter independently of celld. The
// fake command runner verifies the exact subprocess protocol while returning
// representative target-selection provenance from the repository tool.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTDUtilPlannerNormalizesAffectedTests(t *testing.T) {
	t.Parallel()
	base := "base-change"
	wantArgs := []string{
		"--format", "json",
		"--ignore-working-copy",
		"--from", base,
		"--to", "head-change",
		"--buck", "/tools/buck2",
		"--universe", "depot-tilde//aseipp/orchestra/...",
	}
	workspace := &fakeRevisionWorkspace{directory: "/cache/workspaces/head/checkout"}
	provider := &fakeWorkspaceProvider{workspace: workspace}
	planner := tdutilManifestPlanner{
		command:     "/tools/tdutil",
		buckCommand: "/tools/buck2",
		universes:   []string{"depot-tilde//aseipp/orchestra/..."},
		platform:    "linux-x86_64",
		initialBase: "root()",
		workspaces:  provider,
		timeout:     time.Minute,
		runCommand: func(_ context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
			if command != "/tools/tdutil" {
				t.Fatalf("command = %q", command)
			}
			if directory != workspace.directory {
				t.Fatalf("directory = %q", directory)
			}
			if !reflect.DeepEqual(args, wantArgs) {
				t.Fatalf("args = %#v, want %#v", args, wantArgs)
			}
			return []byte(`{
  "base": "base-change",
  "head": "head-change",
  "base_commit": "aaaaaaaa",
  "head_commit": "bbbbbbbb",
  "universe": ["depot-tilde//aseipp/orchestra/..."],
  "count": 4,
  "targets": [
    {
      "target": "depot-tilde//aseipp/orchestra:orchestra-test",
      "rule_type": "root//buck/shims:go_test_internal",
      "depth": 1,
      "reason": "input main.go changed",
      "affected_dep": "depot-tilde//aseipp/orchestra:orchestra"
    },
    {
      "target": "depot-tilde//aseipp/orchestra:orchestra",
      "rule_type": "prelude//go:go_binary",
      "depth": 0,
      "reason": "input main.go changed",
      "affected_dep": null
    },
    {
      "target": "depot-tilde//aseipp/orchestra:e2e-test",
      "rule_type": "depot-tilde//aseipp/orchestra/defs.bzl:_celld_e2e_test",
      "depth": 0,
      "reason": "target definition changed",
      "affected_dep": null
    },
    {
      "target": "depot-tilde//aseipp/orchestra:tests",
      "rule_type": "prelude//test:test_suite",
      "depth": 1,
      "reason": "input main.go changed",
      "affected_dep": "depot-tilde//aseipp/orchestra:orchestra-test"
    }
  ]
}`), nil, nil
		},
	}

	manifest, err := planner.Plan(context.Background(), &base, "head-change")
	if err != nil {
		t.Fatal(err)
	}
	if provider.revision != "head-change" || workspace.closeCalls != 1 {
		t.Fatalf("provider revision=%q close calls=%d", provider.revision, workspace.closeCalls)
	}
	if manifest.Version != targetManifestVersion || manifest.BaseCommit != "aaaaaaaa" || manifest.RevisionCommit != "bbbbbbbb" {
		t.Fatalf("manifest metadata = %+v", manifest)
	}
	if len(manifest.Tests) != 2 {
		t.Fatalf("tests = %+v", manifest.Tests)
	}
	first, second := manifest.Tests[0], manifest.Tests[1]
	if first.Label != "depot-tilde//aseipp/orchestra:e2e-test" || first.Changed == nil || !*first.Changed || first.SelectionDepth != 0 || first.AffectedDependency != nil {
		t.Fatalf("first test = %+v", first)
	}
	if second.Label != "depot-tilde//aseipp/orchestra:orchestra-test" || second.Changed == nil || *second.Changed || second.SelectionDepth != 1 {
		t.Fatalf("second test = %+v", second)
	}
	if second.AffectedDependency == nil || *second.AffectedDependency != "depot-tilde//aseipp/orchestra:orchestra" {
		t.Fatalf("second affected dependency = %#v", second.AffectedDependency)
	}
	if first.TestKey == second.TestKey || !strings.HasPrefix(first.TestKey, "buck-test:v1:sha256:") {
		t.Fatalf("test keys = %q, %q", first.TestKey, second.TestKey)
	}
	if !strings.HasPrefix(manifest.Digest, "sha256:") {
		t.Fatalf("digest = %q", manifest.Digest)
	}
}

func TestTDUtilPlannerUsesInitialBaseForFirstEpoch(t *testing.T) {
	t.Parallel()
	planner := tdutilManifestPlanner{
		command:     "tdutil",
		universes:   []string{"root//..."},
		platform:    "linux-x86_64",
		initialBase: "root()",
		timeout:     time.Minute,
		runCommand: func(_ context.Context, _ string, args []string, _ string) ([]byte, []byte, error) {
			joined := strings.Join(args, " ")
			if !strings.Contains(joined, "--from root() --to first-change") {
				t.Fatalf("args = %q", joined)
			}
			return []byte(`{
  "base": "root()",
  "head": "first-change",
  "base_commit": "root-commit",
  "head_commit": "first-commit",
  "universe": ["root//..."],
  "count": 0,
  "targets": []
}`), nil, nil
		},
	}

	manifest, err := planner.Plan(context.Background(), nil, "first-change")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.BaseRevision != nil || len(manifest.Tests) != 0 {
		t.Fatalf("manifest = %+v", manifest)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Tests json.RawMessage `json:"tests"`
	}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if string(wire.Tests) != "[]" {
		t.Fatalf("empty plan must use JSON arrays, got %s", encoded)
	}
	// The digest must describe the same [] bytes sent to the server, not null.
	withoutDigest := strings.Replace(string(encoded), fmt.Sprintf(`"digest":%q,`, manifest.Digest), "", 1)
	if want := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(withoutDigest))); manifest.Digest != want {
		t.Fatalf("digest=%s, want %s for %s", manifest.Digest, want, withoutDigest)
	}
}

func TestTDUtilPlannerUsesAffectedOutputWithoutWholeRepositoryInventory(t *testing.T) {
	t.Parallel()
	var digest string
	// No whole-repository inventory is required or interpreted. Unknown tdutil
	// fields must not change the affected-only manifest or its content identity.
	for _, extra := range []string{
		``,
		`,"head_targets":null`,
		`,"head_targets":[{"target":"root//unaffected:test","rule_type":"go_test"}]`,
		`,"head_targets":false`,
	} {
		planner := tdutilManifestPlanner{
			command: "tdutil", platform: "linux-x86_64", initialBase: "base", timeout: time.Minute,
			runCommand: func(context.Context, string, []string, string) ([]byte, []byte, error) {
				return []byte(`{"base":"base","head":"head","base_commit":"base","head_commit":"head","universe":["root//..."],"count":0,"targets":[]` + extra + `}`), nil, nil
			},
		}
		manifest, err := planner.Plan(context.Background(), nil, "head")
		if err != nil {
			t.Fatalf("affected-only output %s: %v", extra, err)
		}
		if len(manifest.Tests) != 0 {
			t.Fatalf("unknown field affected test selection: %+v", manifest.Tests)
		}
		encoded, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		if _, present := fields["inventory"]; present {
			t.Fatalf("manifest emitted a whole-repository inventory: %s", encoded)
		}
		if digest != "" && digest != manifest.Digest {
			t.Fatalf("unrelated tdutil fields changed digest: %s != %s", manifest.Digest, digest)
		}
		digest = manifest.Digest
	}
}

func TestTDUtilPlannerReportsBoundedStderr(t *testing.T) {
	t.Parallel()
	planner := tdutilManifestPlanner{
		command:     "tdutil",
		universes:   []string{"root//..."},
		platform:    "linux-x86_64",
		initialBase: "root()",
		timeout:     time.Minute,
		runCommand: func(context.Context, string, []string, string) ([]byte, []byte, error) {
			return nil, []byte("specific tdutil failure\n"), errors.New("exit status 1")
		},
	}

	_, err := planner.Plan(context.Background(), nil, "head")
	if err == nil || !strings.Contains(err.Error(), "specific tdutil failure") {
		t.Fatalf("error = %v", err)
	}
}

func TestStableTestIdentityIncludesPlatform(t *testing.T) {
	t.Parallel()
	firstID, firstKey := stableTestIdentity("linux-x86_64", "root//lib:test")
	secondID, secondKey := stableTestIdentity("macos-aarch64", "root//lib:test")
	if firstID == secondID || firstKey == secondKey {
		t.Fatalf("platform did not affect identity: %q/%q and %q/%q", firstID, firstKey, secondID, secondKey)
	}
}
