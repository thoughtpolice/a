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
