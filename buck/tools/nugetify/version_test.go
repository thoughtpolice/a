// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestParseVersionNormalizes(t *testing.T) {
	for raw, want := range map[string]string{
		"5.9.0":                 "5.9.0",
		"1.0":                   "1.0.0",
		"1.0.0.0":               "1.0.0",
		"1.2.3.4":               "1.2.3.4",
		"11.0.0-rc.1.26425.128": "11.0.0-rc.1.26425.128",
		"1.0.0+build.7":         "1.0.0",
	} {
		parsed, err := parseVersion(raw)
		if err != nil {
			t.Fatalf("parseVersion(%q): %v", raw, err)
		}
		if parsed.String() != want {
			t.Fatalf("parseVersion(%q) = %q, want %q", raw, parsed.String(), want)
		}
	}
	for _, raw := range []string{"", "1.2.3.4.5", "1.a", "01.0", "1.0-", "1.0-rc..1"} {
		if _, err := parseVersion(raw); err == nil {
			t.Fatalf("parseVersion(%q) succeeded", raw)
		}
	}
}

func TestVersionCompare(t *testing.T) {
	ordered := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.0.1", "1.0.1", "1.1.0", "2.0.0-preview.1", "2.0.0"}
	for index := 1; index < len(ordered); index++ {
		lower, _ := parseVersion(ordered[index-1])
		higher, _ := parseVersion(ordered[index])
		if lower.compare(higher) >= 0 || higher.compare(lower) <= 0 {
			t.Fatalf("%s should sort before %s", ordered[index-1], ordered[index])
		}
	}
	left, _ := parseVersion("1.0.0-RC.1")
	right, _ := parseVersion("1.0.0-rc.1")
	if left.compare(right) != 0 {
		t.Fatal("prerelease labels should compare case-insensitively")
	}
}

func TestLowerBound(t *testing.T) {
	for raw, want := range map[string]string{
		"4.0.0":       "4.0.0",
		"[5.9.0]":     "5.9.0",
		"[1.0, 2.0)":  "1.0.0",
		"[1.0.0,)":    "1.0.0",
		"[1.2.3,4.0]": "1.2.3",
	} {
		bound, err := lowerBound(raw)
		if err != nil {
			t.Fatalf("lowerBound(%q): %v", raw, err)
		}
		if bound.String() != want {
			t.Fatalf("lowerBound(%q) = %s, want %s", raw, bound, want)
		}
	}
	for _, raw := range []string{"", "(1.0,2.0)", "(,2.0]", "[1.0,2.0", "[,2.0)"} {
		if _, err := lowerBound(raw); err == nil {
			t.Fatalf("lowerBound(%q) succeeded", raw)
		}
	}
}
