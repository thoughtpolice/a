// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func mustCompileGlob(t *testing.T, pattern string) *globPattern {
	t.Helper()
	compiled, err := compileGlob(pattern)
	if err != nil {
		t.Fatalf("compileGlob(%q): %v", pattern, err)
	}
	return compiled
}

func mustCompileGlobList(t *testing.T, patterns []string) globList {
	t.Helper()
	compiled, err := compileGlobList(patterns, "root//pkg:target", "ci_srcs")
	if err != nil {
		t.Fatal(err)
	}
	return compiled
}

func TestGlobSemanticsRespectDirectoryBoundaries(t *testing.T) {
	patterns := mustCompileGlobList(t, []string{"src/**", "!src/generated/**"})
	if !patterns.matches("src/lib.rs") || !patterns.matches("src/nested/lib.rs") {
		t.Fatal("recursive wildcard did not match source paths")
	}
	if patterns.matches("src/generated/lib.rs") {
		t.Fatal("excluded generated path matched")
	}

	shallow := mustCompileGlobList(t, []string{"src/*.rs"})
	if !shallow.matches("src/lib.rs") {
		t.Fatal("single wildcard did not match within directory")
	}
	if shallow.matches("src/nested/lib.rs") {
		t.Fatal("single wildcard crossed directory boundary")
	}
}

func TestGlobSemanticsCoverUnicodeClassesAndHiddenFiles(t *testing.T) {
	patterns := mustCompileGlobList(t, []string{
		"src/[a-z]?.rs",
		"unicode/?.txt",
		"src/.*.rs",
	})
	if !patterns.matches("src/ab.rs") {
		t.Fatal("character range and wildcard did not match")
	}
	if patterns.matches("src/1b.rs") {
		t.Fatal("character outside range matched")
	}
	if !patterns.matches("unicode/é.txt") {
		t.Fatal("question mark did not match one Unicode scalar")
	}
	if !patterns.matches("src/.hidden.rs") {
		t.Fatal("literal leading dot did not match hidden file")
	}

	wildcard := mustCompileGlobList(t, []string{"src/**"})
	if wildcard.matches("src/.hidden.rs") || wildcard.matches("src/nested/.hidden.rs") {
		t.Fatal("wildcard matched a hidden path component")
	}
}

func TestGlobExclusionsAreOrderIndependent(t *testing.T) {
	for _, raw := range [][]string{
		{"src/**", "!src/generated/**"},
		{"!src/generated/**", "src/**"},
	} {
		patterns := mustCompileGlobList(t, raw)
		if !patterns.matches("src/lib.rs") {
			t.Errorf("patterns %#v did not match included path", raw)
		}
		if patterns.matches("src/generated/lib.rs") {
			t.Errorf("patterns %#v matched excluded path", raw)
		}
	}
}

func TestGlobRecursiveWildcardMatchesZeroOrMoreDirectories(t *testing.T) {
	pattern := mustCompileGlob(t, "some/**/needle.txt")
	for _, path := range []string{
		"some/needle.txt",
		"some/one/needle.txt",
		"some/one/two/needle.txt",
	} {
		if !pattern.matches(path) {
			t.Errorf("recursive wildcard did not match %q", path)
		}
	}
	if pattern.matches("some/other/notthis.txt") {
		t.Fatal("recursive wildcard ignored literal suffix")
	}

	leading := mustCompileGlob(t, "**/test")
	for _, path := range []string{"test", "one/test", "one/two/test"} {
		if !leading.matches(path) {
			t.Errorf("leading recursive wildcard did not match %q", path)
		}
	}

	collapsed := mustCompileGlob(t, "some/**/**/needle.txt")
	for _, path := range []string{"some/needle.txt", "some/one/two/needle.txt"} {
		if !collapsed.matches(path) {
			t.Errorf("consecutive recursive wildcards did not match %q", path)
		}
	}
}

func TestGlobRejectsMalformedWildcardsAndClasses(t *testing.T) {
	for _, pattern := range []string{
		"a/**b",
		"a/bc**",
		"a/*****",
		"a/b**c**d",
		"a**b",
		"***",
		"abc[def",
		"abc[!def",
		"abc[",
		"abc[!",
		"abc[]",
		"abc[!]",
	} {
		if _, err := compileGlob(pattern); err == nil {
			t.Errorf("malformed glob %q was accepted", pattern)
		}
	}
}

func TestGlobCharacterRangesAndLiteralHyphens(t *testing.T) {
	digits := mustCompileGlob(t, "a[0-9]b")
	for digit := '0'; digit <= '9'; digit++ {
		if !digits.matches("a" + string(digit) + "b") {
			t.Errorf("digit range did not match %q", digit)
		}
	}
	if digits.matches("a_b") {
		t.Fatal("digit range matched underscore")
	}

	notDigits := mustCompileGlob(t, "a[!0-9]b")
	if !notDigits.matches("a_b") || notDigits.matches("a1b") {
		t.Fatal("negated character range behaved incorrectly")
	}
	for _, raw := range []string{"[abc-]", "[-abc]", "[a-c-]", "[-]"} {
		if !mustCompileGlob(t, raw).matches("-") {
			t.Errorf("literal hyphen did not match pattern %q", raw)
		}
	}
	if mustCompileGlob(t, "[!-]").matches("-") {
		t.Fatal("negated literal hyphen matched hyphen")
	}
	if !mustCompileGlob(t, "unicode/[α-ω].txt").matches("unicode/λ.txt") {
		t.Fatal("Unicode range did not match")
	}
}

func TestGlobMatchingBacktracksAcrossRepeatedWildcards(t *testing.T) {
	tests := []struct {
		pattern string
		path    string
		want    bool
	}{
		{"a*b*c", "abc", true},
		{"a*b*c", "a___b___c", true},
		{"a*b*c", "abcd", false},
		{"abc*abc*abc", "abcabcabcabcabcabcabc", true},
		{"abc*abc*abc", "abcabcabcabcabcabcabca", false},
		{"a*b[xyz]c*d", "abxcdbxcddd", true},
	}
	for _, test := range tests {
		if got := mustCompileGlob(t, test.pattern).matches(test.path); got != test.want {
			t.Errorf("%q matches %q = %v, want %v", test.pattern, test.path, got, test.want)
		}
	}
}
