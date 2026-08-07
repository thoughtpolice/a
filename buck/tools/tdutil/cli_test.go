// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
	"time"
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

func TestCLIGraphErrorPolicyParsesAndDefaultsToFail(t *testing.T) {
	if args := mustRunArgs(t); args.onGraphError != graphErrorFail {
		t.Fatalf("default policy = %v, want fail", args.onGraphError)
	}
	if args := mustRunArgs(t, "--on-graph-error", "select-all"); args.onGraphError != graphErrorSelectAll {
		t.Fatalf("policy = %v, want select-all", args.onGraphError)
	}
	if args := mustRunArgs(t, "--on-graph-error=fail"); args.onGraphError != graphErrorFail {
		t.Fatalf("policy = %v, want fail", args.onGraphError)
	}
	_, err := parseCLI([]string{"--on-graph-error", "select-everything"})
	if err == nil || !strings.Contains(err.Error(), "unknown --on-graph-error policy") {
		t.Fatalf("error = %v, want an unknown-policy rejection", err)
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

func TestCLIParsesCacheFlags(t *testing.T) {
	args := mustRunArgs(t, "--cache", "s3://bucket/prefix", "--cache-write",
		"--cache-timeout", "5m", "--cache-max-age", "3d")
	if args.cache == nil || *args.cache != "s3://bucket/prefix" {
		t.Fatalf("cache = %v", args.cache)
	}
	if !args.cacheWrite {
		t.Error("--cache-write did not enable writing")
	}
	if args.cacheTimeout != 5*time.Minute {
		t.Errorf("cache timeout = %s, want 5m", args.cacheTimeout)
	}
	if args.cacheMaxAge != 72*time.Hour {
		t.Errorf("cache max age = %s, want 72h", args.cacheMaxAge)
	}

	// Reads are automatic and writes are opt-in, so the defaults are a
	// read-only cache with bounds that need no thought.
	args = mustRunArgs(t, "--cache", "/tmp/cache")
	if args.cacheWrite {
		t.Error("writing was enabled without --cache-write")
	}
	if args.cacheTimeout != defaultCacheTimeout || args.cacheMaxAge != defaultCacheMaxAge {
		t.Errorf("defaults = %s, %s", args.cacheTimeout, args.cacheMaxAge)
	}
}

// cli.go rejects combinations that would do nothing rather than accepting and
// ignoring them, so a flag that had no effect is never silent.
func TestCLIRejectsMeaninglessCacheCombinations(t *testing.T) {
	for name, argv := range map[string][]string{
		"write with nowhere to write": {"--cache-write"},
		"quick reads no base graph":   {"--quick", "--cache", "/tmp/cache"},
		"capture reads no base graph": {"--snapshot-to", "/tmp/s.json", "--cache", "/tmp/cache"},
		"bad timeout":                 {"--cache", "/tmp/c", "--cache-timeout", "soon"},
		"bad max age":                 {"--cache", "/tmp/c", "--cache-max-age", "-3d"},
	} {
		if _, err := parseCLI(argv); err == nil {
			t.Errorf("%s: %q was accepted", name, argv)
		}
	}

	// Quick mode and a standalone capture can still produce something worth
	// storing, so both combine with a cache they may write to.
	for name, argv := range map[string][]string{
		"quick may write":   {"--quick", "--cache", "/tmp/cache", "--cache-write"},
		"capture may write": {"--snapshot-to", "/tmp/s.json", "--cache", "/tmp/cache", "--cache-write"},
	} {
		if _, err := parseCLI(argv); err != nil {
			t.Errorf("%s: %q was rejected: %v", name, argv, err)
		}
	}
}

// A retention spelled `336h` is arithmetic the reader has to do, so days are
// accepted even though Go's own duration parser does not take them.
func TestCLIParsesDaySuffixedDurations(t *testing.T) {
	for raw, want := range map[string]time.Duration{
		"90s":  90 * time.Second,
		"10m":  10 * time.Minute,
		"1d":   24 * time.Hour,
		"14d":  14 * 24 * time.Hour,
		"0.5d": 12 * time.Hour,
		"0":    0,
	} {
		got, err := parseDurationFlag("--cache-max-age", raw)
		if err != nil {
			t.Errorf("parseDurationFlag(%q): %v", raw, err)
			continue
		}
		if got != want {
			t.Errorf("parseDurationFlag(%q) = %s, want %s", raw, got, want)
		}
	}
	for _, raw := range []string{"", "soon", "d", "-1h", "14 d", "14days"} {
		if _, err := parseDurationFlag("--cache-max-age", raw); err == nil {
			t.Errorf("parseDurationFlag(%q) was accepted", raw)
		}
	}
}
