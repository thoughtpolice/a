// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
)

func mustRunArgs(t *testing.T, argv ...string) cliArgs {
	t.Helper()
	action, err := parseCLI(argv)
	if err != nil {
		t.Fatalf("parseCLI(%q): %v", argv, err)
	}
	if action.kind != actionRun {
		t.Fatalf("parseCLI(%q) action = %v, want run", argv, action.kind)
	}
	return action.args
}

// Port of cli.rs::no_args_are_automatic.
func TestCLINoArgsAreAutomatic(t *testing.T) {
	args := mustRunArgs(t)
	if args.base != "fork_point(trunk() | @)" || args.head != "@" {
		t.Fatalf("revisions = %q .. %q, want fork point .. @", args.base, args.head)
	}
	if !reflect.DeepEqual(args.universe, []string{"depot//..."}) {
		t.Fatalf("universe = %q, want depot//...", args.universe)
	}
}

// Port of cli.rs::positional_compatibility.
func TestCLIPositionalCompatibility(t *testing.T) {
	args := mustRunArgs(t, "trunk()", "@", "depot//src/...")
	if args.base != "trunk()" || args.head != "@" {
		t.Fatalf("revisions = %q .. %q", args.base, args.head)
	}
	if !reflect.DeepEqual(args.universe, []string{"depot//src/..."}) {
		t.Fatalf("universe = %q", args.universe)
	}
}

// Port of cli.rs::patterns_only_keep_default_revisions.
func TestCLIPatternsOnlyKeepDefaultRevisions(t *testing.T) {
	args := mustRunArgs(t, "depot//src/...", "root//buck/...")
	if args.base != "fork_point(trunk() | @)" || args.head != "@" {
		t.Fatalf("revisions = %q .. %q", args.base, args.head)
	}
	want := []string{"depot//src/...", "root//buck/..."}
	if !reflect.DeepEqual(args.universe, want) {
		t.Fatalf("universe = %q, want %q", args.universe, want)
	}
}

func TestCLIQuickFlagParsesAndRejectsConflicts(t *testing.T) {
	if mustRunArgs(t).quick {
		t.Fatal("quick should default off")
	}
	if !mustRunArgs(t, "--quick").quick {
		t.Fatal("--quick was not recorded")
	}
	if _, err := parseCLI([]string{"--quick", "--no-head-in-place"}); err == nil {
		t.Fatal("conflicting in-place flags were accepted")
	}
}

func TestCLISnapshotFlagsParseAndRejectConflicts(t *testing.T) {
	args := mustRunArgs(t, "--snapshot-to", "/tmp/x")
	if args.snapshotTo == nil || *args.snapshotTo != "/tmp/x" {
		t.Fatalf("snapshotTo = %v", args.snapshotTo)
	}
	args = mustRunArgs(t, "--base-snapshot=/tmp/y")
	if args.baseSnapshot == nil || *args.baseSnapshot != "/tmp/y" {
		t.Fatalf("baseSnapshot = %v", args.baseSnapshot)
	}
	for _, argv := range [][]string{
		{"--quick", "--base-snapshot", "x"},
		{"--snapshot-to", "x", "--quick"},
		{"--snapshot-to", "x", "--base-snapshot", "y"},
		{"--snapshot-to", "x", "--from", "base"},
		{"--snapshot-to", "x", "--output", "o"},
	} {
		if _, err := parseCLI(argv); err == nil {
			t.Errorf("parseCLI(%q) accepted conflicting flags", argv)
		}
	}
}

func TestCLIHeadInPlaceIsDefaultWithOptOut(t *testing.T) {
	if mustRunArgs(t).noHeadInPlace {
		t.Fatal("in-place head should be allowed by default")
	}
	if !mustRunArgs(t, "--no-head-in-place").noHeadInPlace {
		t.Fatal("--no-head-in-place was not recorded")
	}
}

// Port of cli.rs::named_revisions_make_positionals_patterns.
func TestCLINamedRevisionsMakePositionalsPatterns(t *testing.T) {
	args := mustRunArgs(t, "--from=abc", "--to", "def", "depot//...")
	if args.base != "abc" || args.head != "def" {
		t.Fatalf("revisions = %q .. %q", args.base, args.head)
	}
	if !reflect.DeepEqual(args.universe, []string{"depot//..."}) {
		t.Fatalf("universe = %q", args.universe)
	}
}

// Port of cli.rs::config_becomes_buck_arguments.
func TestCLIConfigBecomesBuckArguments(t *testing.T) {
	args := mustRunArgs(t, "-c", "ci.enabled=true", "depot//...")
	want := []string{"-c", "ci.enabled=true"}
	if !reflect.DeepEqual(args.buckArgs, want) {
		t.Fatalf("buck args = %q, want %q", args.buckArgs, want)
	}
}

// Port of cli.rs::root_depth_is_valid.
func TestCLIRootDepthIsValid(t *testing.T) {
	args := mustRunArgs(t, "--depth", "0")
	if args.depth == nil || *args.depth != 0 {
		t.Fatalf("depth = %v, want pointer to zero", args.depth)
	}
}

// A depth parsed across the full width of an int wraps negative, and a
// negative limit stops propagation at the roots — an under-selection reported
// as success. Both the wrapping value and an ordinary negative are refused.
func TestCLIRejectsOutOfRangeDepths(t *testing.T) {
	for _, raw := range []string{"18446744073709551615", "9223372036854775808", "-1", "1.5", ""} {
		if _, err := parseCLI([]string{"--depth", raw}); err == nil {
			t.Errorf("--depth %q was accepted", raw)
		}
	}
	args := mustRunArgs(t, "--depth", "9223372036854775807")
	if args.depth == nil || *args.depth != 9223372036854775807 {
		t.Fatalf("depth = %v, want the largest representable limit", args.depth)
	}
}

// The set of universe patterns decides the graph; the order they were spelled
// in does not. Normalizing lets a snapshot captured by one invocation match an
// otherwise identical one that listed the same patterns differently.
func TestCLINormalizesUniversePatternsForSnapshotIdentity(t *testing.T) {
	first := mustRunArgs(t, "-u", "depot//b/...", "-u", "depot//a/...", "-u", "depot//b/...")
	second := mustRunArgs(t, "-u", "depot//a/...", "-u", "depot//b/...")
	want := []string{"depot//a/...", "depot//b/..."}
	if !reflect.DeepEqual(first.universe, want) {
		t.Fatalf("universe = %q, want %q", first.universe, want)
	}
	if !reflect.DeepEqual(first.universe, second.universe) {
		t.Fatalf("orderings disagree: %q versus %q", first.universe, second.universe)
	}
}

// --snapshot-head-to is a modifier on an ordinary run, so unlike the
// standalone --snapshot-to it combines with everything a run already does.
func TestCLISnapshotHeadToIsAModifierNotAStandaloneCapture(t *testing.T) {
	args := mustRunArgs(t, "--snapshot-head-to", "/tmp/head.json", "--output", "o", "--base-snapshot", "b")
	if args.snapshotHeadTo == nil || *args.snapshotHeadTo != "/tmp/head.json" {
		t.Fatalf("snapshotHeadTo = %v", args.snapshotHeadTo)
	}
	if args.snapshotTo != nil {
		t.Fatalf("snapshotTo = %v, want unset", args.snapshotTo)
	}
	if _, err := parseCLI([]string{"--quick", "--snapshot-head-to", "/tmp/head.json"}); err != nil {
		t.Fatalf("quick mode rejected: %v", err)
	}
	_, err := parseCLI([]string{"--snapshot-to", "a", "--snapshot-head-to", "b"})
	if err == nil || !strings.Contains(err.Error(), "use one") {
		t.Fatalf("error = %v, want a conflict between the two spellings", err)
	}
}

// Port of cli.rs::rejects_unknown_format.
func TestCLIRejectsUnknownFormat(t *testing.T) {
	_, err := parseCLI([]string{"--format=yaml"})
	if err == nil || !strings.Contains(err.Error(), "unknown output format") {
		t.Fatalf("error = %v, want unknown output format", err)
	}
}

// Port of cli.rs::help_is_an_action.
func TestCLIHelpIsAnAction(t *testing.T) {
	action, err := parseCLI([]string{"--help"})
	if err != nil {
		t.Fatal(err)
	}
	if action.kind != actionHelp {
		t.Fatalf("action = %v, want help", action.kind)
	}
}
