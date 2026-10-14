// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

// TestAttributeMatchesGit runs the .gitattributes lines in cases_test.go
// against paths, with the answers `git check-attr` gave for them.
func TestAttributeMatchesGit(t *testing.T) {
	for _, set := range []struct {
		dir   string
		paths []string
		cases []struct{ line, matches string }
	}{
		{"", attrMatchPaths, attrMatchCases},
		{"sub", subAttrMatchPaths, subAttrMatchCases},
	} {
		for _, tc := range set.cases {
			attrs := newAttributes()
			attrs.addFile(set.dir, []byte(tc.line+" x\n"))
			for i, path := range set.paths {
				got := attrs.lookup(path)["x"].state == attrSet
				if want := tc.matches[i] == '1'; got != want {
					t.Errorf("%q in %s/.gitattributes matches %q: %v, want %v", tc.line, set.dir, path, got, want)
				}
			}
		}
	}
}

func TestWildmatch(t *testing.T) {
	tests := []struct {
		pattern, text string
		flags         int
		want          bool
	}{
		{"*", "a/b", 0, true},
		{"*", "a/b", wmPathname, false},
		{"a/**/b", "a/b", wmPathname, true},
		{"a/**/b", "a/x/y/b", wmPathname, true},
		{"a/**/b", "a/xb", wmPathname, false},
		{"**/b", "b", wmPathname, true},
		{"a**", "a/b", wmPathname, false},
		{"a**", "abc", wmPathname, true},
		{"[!a]", "b", 0, true},
		{"[^a]", "a", 0, false},
		{"[[:digit:][:upper:]]", "Q", 0, true},
		{"[a-c]x", "bx", 0, true},
		{`\*`, "*", 0, true},
		{`\*`, "a", 0, false},
		{"a?c", "a/c", wmPathname, false},
		{"a?c", "a/c", 0, true},
		{"[a/]", "/", wmPathname, false},
	}
	for _, tt := range tests {
		if got := wildmatch(tt.pattern, tt.text, tt.flags); got != tt.want {
			t.Errorf("wildmatch(%q, %q, %d) = %v, want %v", tt.pattern, tt.text, tt.flags, got, tt.want)
		}
	}
}

func TestParseAttrLine(t *testing.T) {
	rule, macro, ok := parseAttrLine(`  "a b"	text -diff !eol x=y`)
	if !ok || macro != "" || rule.pattern != "a b" || !rule.noDir {
		t.Fatalf("got %+v, %q, %v", rule, macro, ok)
	}
	want := []attrAssign{
		{"text", attrSet, ""},
		{"diff", attrUnset, ""},
		{"eol", attrUnspecified, ""},
		{"x", attrValue, "y"},
	}
	if len(rule.assigns) != len(want) {
		t.Fatalf("got %+v", rule.assigns)
	}
	for i := range want {
		if rule.assigns[i] != want[i] {
			t.Errorf("assignment %d: got %+v, want %+v", i, rule.assigns[i], want[i])
		}
	}
	if _, macro, ok := parseAttrLine("[attr]mine text eol=crlf"); !ok || macro != "mine" {
		t.Errorf("macro: got %q, %v", macro, ok)
	}
	if rule, _, ok := parseAttrLine("dir/ text"); !ok || !rule.mustBeDir || rule.pattern != "dir" {
		t.Errorf("directory pattern: got %+v, %v", rule, ok)
	}
}
