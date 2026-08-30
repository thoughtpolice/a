// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseCheckArgs(t *testing.T) {
	a, err := parseCheckArgs([]string{"--check-prefix=A", "-check-prefix", "B", "--input-file", "in", "-DX=1", "-D", "Y=2", "-vv", "--match-full-lines=false", "--dump-input-context=3", "check"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a.opts.checkPrefixes, []string{"A", "B"}) {
		t.Errorf("prefixes = %v", a.opts.checkPrefixes)
	}
	if a.inputFile != "in" || !reflect.DeepEqual(a.defines, []string{"X=1", "Y=2"}) || a.verbose != 2 || a.opts.matchFullLines || a.dumpContext != 3 {
		t.Errorf("unexpected args: %+v", a)
	}
	if !reflect.DeepEqual(a.positional, []string{"check"}) {
		t.Errorf("positional = %v", a.positional)
	}
	if a.opts.defaultPrefix {
		t.Errorf("explicit prefixes should clear defaultPrefix")
	}

	a, err = parseCheckArgs([]string{"--check-prefixes=X,Y", "c"})
	if err != nil || !reflect.DeepEqual(a.opts.checkPrefixes, []string{"X", "Y"}) {
		t.Errorf("--check-prefixes: %v %v", a.opts.checkPrefixes, err)
	}

	// A bare "--" only ends option parsing.
	a, err = parseCheckArgs([]string{"-v", "--", "-check.txt", "--extra"})
	if err != nil || a.verbose != 1 || !reflect.DeepEqual(a.positional, []string{"-check.txt", "--extra"}) {
		t.Errorf("-- handling: %v %v", a, err)
	}

	for _, bad := range [][]string{
		{"--bogus"},
		{"--dump-input=sometimes"},
		{"--dump-input-filter=none"},
		{"--dump-input-context=-1"},
		{"--dump-input-context=many"},
		{"--check-prefix"},
		{"-D"},
		{"--match-full-lines=maybe"},
		{"--color=sometimes"},
	} {
		if _, err := parseCheckArgs(bad); err == nil {
			t.Errorf("parseCheckArgs(%q) accepted", bad)
		}
	}
	if _, err := parseCheckArgs([]string{"--check-prefix"}); err == nil || !strings.Contains(err.Error(), "requires a value") {
		t.Errorf("missing value: %v", err)
	}
}

func TestSplitEnvOpts(t *testing.T) {
	got := splitEnvOpts(`-v --dump-input=fail  "-D X=a b" 'q'`)
	want := []string{"-v", "--dump-input=fail", "-D X=a b", "q"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitEnvOpts = %q, want %q", got, want)
	}
}

// parseExec parses an exec command line the way runExec does.
func parseExec(argv []string) (*execArgs, *checkArgs, []string, error) {
	e := &execArgs{capture: "stdout"}
	args, command, err := parseCheckArgsWith(argv, e.option)
	return e, args, command, err
}

func TestParseExecArgs(t *testing.T) {
	e, args, command, err := parseExec([]string{"--capture", "both", "--expect-exit=3", "--check-prefix", "X", "--env", "K=V", "check.txt", "--any-exit", "--", "tool", "-x", "--capture"})
	if err != nil {
		t.Fatal(err)
	}
	if e.capture != "both" || e.expect != 3 || !e.anyExit || !reflect.DeepEqual(e.env, []string{"K=V"}) {
		t.Errorf("exec args: %+v", e)
	}
	if !reflect.DeepEqual(args.opts.checkPrefixes, []string{"X"}) || !reflect.DeepEqual(args.positional, []string{"check.txt"}) {
		t.Errorf("check args: prefixes %v, positional %v", args.opts.checkPrefixes, args.positional)
	}
	if !reflect.DeepEqual(command, []string{"tool", "-x", "--capture"}) {
		t.Errorf("command = %v", command)
	}
	if e, _, _, err := parseExec([]string{"--help"}); err != nil || !e.showHelp {
		t.Errorf("--help: %+v %v", e, err)
	}
	for _, bad := range [][]string{
		{"--capture"},
		{"--capture=file", "c"},
		{"--expect-exit=zero", "c"},
		{"--env", "novalue", "c"},
		{"--bogus", "c"},
	} {
		if _, _, _, err := parseExec(bad); err == nil {
			t.Errorf("parseExec(%q) accepted", bad)
		}
	}
}
