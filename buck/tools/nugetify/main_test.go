// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const exampleManifest = `[framework]
package = "Microsoft.NETCore.App.Ref"
version = "11.0.0-rc.1"

[packages]
"Top.CSharp" = "5.9.0"
`

func TestBuckifyThenCheck(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, manifestName), []byte(exampleManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	source := exampleGraph(t)
	refPack(t, source)

	var stdout bytes.Buffer
	if err := buckify(context.Background(), dir, source, false, &stdout); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "Resolved 4 packages for net11.0.") {
		t.Fatalf("unexpected output:\n%s", stdout.String())
	}
	build, err := os.ReadFile(filepath.Join(dir, buildName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(build), "name = \"Top.CSharp\"") || !strings.Contains(string(build), "nuget.check(") {
		t.Fatalf("BUILD:\n%s", build)
	}
	if err := check(filepath.Join(dir, manifestName), filepath.Join(dir, lockName), filepath.Join(dir, buildName)); err != nil {
		t.Fatal(err)
	}

	// A second run resolves nothing: the lock already answers the manifest.
	fetchedBefore := len(source.fetched)
	stdout.Reset()
	if err := buckify(context.Background(), dir, source, false, &stdout); err != nil {
		t.Fatal(err)
	}
	if len(source.fetched) != fetchedBefore || !strings.Contains(stdout.String(), "not resolving again") {
		t.Fatalf("the lock was not reused:\n%s", stdout.String())
	}

	// A hand edit to BUILD or a new pin in the manifest fails the check.
	if err := os.WriteFile(filepath.Join(dir, buildName), append(build, "# edited\n"...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := check(filepath.Join(dir, manifestName), filepath.Join(dir, lockName), filepath.Join(dir, buildName)); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatalf("an edited BUILD passed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, buildName), build, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, manifestName), []byte(exampleManifest+"\"Leaf.Cecil\" = \"0.11.6\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := check(filepath.Join(dir, manifestName), filepath.Join(dir, lockName), filepath.Join(dir, buildName)); err == nil || !strings.Contains(err.Error(), "was not resolved from") {
		t.Fatalf("a changed manifest passed: %v", err)
	}

	// buckify picks the change up and resolves again.
	stdout.Reset()
	if err := buckify(context.Background(), dir, source, false, &stdout); err != nil {
		t.Fatal(err)
	}
	lock, err := loadLock(filepath.Join(dir, lockName))
	if err != nil {
		t.Fatal(err)
	}
	if cecil := lock.find("Leaf.Cecil"); cecil == nil || !cecil.Direct || cecil.Version != "0.11.6" {
		t.Fatalf("Leaf.Cecil = %+v", cecil)
	}
}

func TestRealMainUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := realMain(context.Background(), nil, &stdout, &stderr); code != 2 {
		t.Fatalf("no arguments: exit %d", code)
	}
	if code := realMain(context.Background(), []string{"frobnicate"}, &stdout, &stderr); code != 2 {
		t.Fatalf("unknown command: exit %d", code)
	}
	if code := realMain(context.Background(), []string{"-h"}, &stdout, &stderr); code != 0 {
		t.Fatalf("-h: exit %d", code)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, manifestName), []byte(exampleManifest), 0o644)
	stderr.Reset()
	if code := realMain(context.Background(), []string{"-third-party-dir", dir, "check"}, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), lockName) {
		t.Fatalf("check without a lock: exit %d, stderr %s", code, stderr.String())
	}
}
