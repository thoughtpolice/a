// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"testing"
)

func TestWithCommas(t *testing.T) {
	cases := map[int64]string{
		0:        "0",
		7:        "7",
		999:      "999",
		1000:     "1,000",
		45210:    "45,210",
		1234567:  "1,234,567",
		-1234567: "-1,234,567",
	}
	for value, want := range cases {
		if got := withCommas(value); got != want {
			t.Errorf("withCommas(%d) = %q, want %q", value, got, want)
		}
	}
}

func TestStripConfigurationHashes(t *testing.T) {
	cases := map[string]string{
		"cfg:<empty>#1a608cc1468ec806":                      "cfg:<empty>",
		"depot//probe:fails (cfg:<empty>#1a608cc1468ec806)": "depot//probe:fails (cfg:<empty>)",
		"no hashes here":                                    "no hashes here",
		"issue #42 stays":                                   "issue #42 stays",
	}
	for value, want := range cases {
		if got := stripConfigurationHashes(value); got != want {
			t.Errorf("stripConfigurationHashes(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestShortenTarget(t *testing.T) {
	if got := shortenTarget("depot//short:name", 76); got != "depot//short:name" {
		t.Errorf("short labels must pass through, got %q", got)
	}
	long := "depot//very/deep/package/path/that/goes/on/and/on/for/quite/a/while/longer:target-name"
	got := shortenTarget(long, 40)
	if len(got) > 40 {
		t.Errorf("shortened to %d chars: %q", len(got), got)
	}
	if got[:7] != "depot//" {
		t.Errorf("cell prefix lost: %q", got)
	}
	if got[len(got)-len("target-name"):] != "target-name" {
		t.Errorf("target name lost: %q", got)
	}
}

func TestLineHelpers(t *testing.T) {
	if got := firstLine("one\ntwo\nthree"); got != "one" {
		t.Errorf("firstLine = %q", got)
	}
	if got := splitTrimmedLines(""); got != nil {
		t.Errorf("splitTrimmedLines(empty) = %#v", got)
	}
	lines := splitTrimmedLines("a\nb\nc\nd\n")
	if !reflect.DeepEqual(lines, []string{"a", "b", "c", "d"}) {
		t.Errorf("splitTrimmedLines = %#v", lines)
	}
	head, dropped := headLines(lines, 2)
	if !reflect.DeepEqual(head, []string{"a", "b"}) || dropped != 2 {
		t.Errorf("headLines = %#v, %d", head, dropped)
	}
	tail, dropped := tailLines(lines, 3)
	if !reflect.DeepEqual(tail, []string{"b", "c", "d"}) || dropped != 1 {
		t.Errorf("tailLines = %#v, %d", tail, dropped)
	}
	all, dropped := tailLines(lines, 0)
	if len(all) != 4 || dropped != 0 {
		t.Errorf("tailLines with no limit = %#v, %d", all, dropped)
	}
}
