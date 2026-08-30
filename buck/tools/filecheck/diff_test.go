// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func applyOps(a, b []string, ops []diffOp) []string {
	var out []string
	for _, op := range ops {
		switch op.kind {
		case '=':
			out = append(out, a[op.a])
		case '+':
			out = append(out, b[op.b])
		}
	}
	return out
}

func TestDiffLines(t *testing.T) {
	cases := []struct{ a, b string }{
		{"a b c", "a b c"},
		{"a b c", "a x c"},
		{"", "a b"},
		{"a b", ""},
		{"a b c d e", "b c x e f"},
		{"x y z", "a b c"},
		{"a a a a", "a a"},
	}
	for _, c := range cases {
		a := strings.Fields(c.a)
		b := strings.Fields(c.b)
		ops := diffLines(a, b)
		if got := applyOps(a, b, ops); strings.Join(got, " ") != c.b {
			t.Errorf("diff(%q, %q) does not reconstruct b: %v", c.a, c.b, got)
		}
		if same := diffIdentical(ops); same != (c.a == c.b) {
			t.Errorf("diff(%q, %q) same = %v", c.a, c.b, same)
		}
	}
}

// Edits scattered through longer inputs exercise the backtrack through many
// steps of the search, including ones where both sides changed.
func TestDiffLinesReconstructsRandomEdits(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for round := 0; round < 200; round++ {
		n := rng.IntN(60)
		a := make([]string, n)
		for i := range a {
			a[i] = string(rune('a' + rng.IntN(6)))
		}
		var b []string
		for _, line := range a {
			switch rng.IntN(6) {
			case 0: // delete
			case 1: // replace
				b = append(b, string(rune('A'+rng.IntN(6))))
			case 2: // insert before
				b = append(b, "+", line)
			default:
				b = append(b, line)
			}
		}
		ops := diffLines(a, b)
		if got := applyOps(a, b, ops); !slices.Equal(got, b) {
			t.Fatalf("round %d: diff(%q, %q) reconstructs %q", round, a, b, got)
		}
		edits := 0
		for _, op := range ops {
			if op.kind != '=' {
				edits++
			}
		}
		// The script is never longer than replacing everything.
		if edits > len(a)+len(b) || (edits == 0) != slices.Equal(a, b) {
			t.Fatalf("round %d: %d edits for %q -> %q", round, edits, a, b)
		}
	}
}

func TestUnifiedDiffOutput(t *testing.T) {
	a := splitDiffLines([]byte("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"), false)
	b := splitDiffLines([]byte("one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\neleven\n"), false)
	ops := diffLines(a, b)
	var buf bytes.Buffer
	writeUnifiedDiff(&buf, "a", "b", a, b, ops, 3)
	got := buf.String()
	// Changes closer than 2*context lines share a hunk, as in GNU diff.
	want := "--- a\n+++ b\n@@ -2,9 +2,10 @@\n two\n three\n four\n-five\n+FIVE\n six\n seven\n eight\n nine\n ten\n+eleven\n"
	if got != want {
		t.Errorf("unified diff:\n%s\nwant:\n%s", got, want)
	}
	c := splitDiffLines([]byte("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n"), false)
	d := splitDiffLines([]byte("A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n"), false)
	buf.Reset()
	writeUnifiedDiff(&buf, "c", "d", c, d, diffLines(c, d), 3)
	want = "--- c\n+++ d\n@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n@@ -9,4 +9,4 @@\n i\n j\n k\n-l\n+L\n"
	if got := buf.String(); got != want {
		t.Errorf("two hunks:\n%s\nwant:\n%s", got, want)
	}
}

func TestDiffBuiltin(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x\ny\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("x\nY \n"), 0o644)
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("x\r\ny\r\n"), 0o644)
	sh := newShell(dir, nil)
	status, out, _ := runShell(t, sh, "diff a.txt b.txt")
	if status != 1 || !strings.Contains(out, "-y\n+Y \n") {
		t.Errorf("diff: %d %q", status, out)
	}
	status, _, _ = runShell(t, sh, "diff -b -i a.txt b.txt")
	if status != 0 {
		t.Errorf("diff -b -i: %d", status)
	}
	status, _, _ = runShell(t, sh, "diff --strip-trailing-cr a.txt c.txt")
	if status != 0 {
		t.Errorf("diff --strip-trailing-cr: %d", status)
	}
	status, _, _ = runShell(t, sh, "diff a.txt c.txt")
	if status != 1 {
		t.Errorf("diff with CR: %d", status)
	}
	status, _, _ = runShell(t, sh, "cat a.txt | diff a.txt -")
	if status != 0 {
		t.Errorf("diff against stdin: %d", status)
	}
	status, _, errOut := runShell(t, sh, "diff a.txt missing.txt")
	if status != 2 || !strings.Contains(errOut, "diff:") {
		t.Errorf("diff missing file: %d %q", status, errOut)
	}
}

func TestDiffFinalNewline(t *testing.T) {
	const missing = "\\ No newline at end of file\n"
	cases := []struct {
		name, a, b string
		flags      []string
		status     int
		body       string
	}{
		{
			name: "missing from actual", a: "hello\n", b: "hello", status: 1,
			body: "@@ -1 +1 @@\n-hello\n+hello\n" + missing,
		},
		{
			name: "missing from expected", a: "hello", b: "hello\n", status: 1,
			body: "@@ -1 +1 @@\n-hello\n" + missing + "+hello\n",
		},
		{
			name: "different incomplete lines", a: "hello", b: "goodbye", status: 1,
			body: "@@ -1 +1 @@\n-hello\n" + missing + "+goodbye\n" + missing,
		},
		{
			name: "incomplete context", a: "old\nlast", b: "new\nlast", status: 1,
			body: "@@ -1,2 +1,2 @@\n-old\n+new\n last\n" + missing,
		},
		{name: "equal incomplete lines", a: "hello", b: "hello"},
		{name: "equal complete lines", a: "hello\n", b: "hello\n"},
		{name: "empty files"},
		{
			name: "empty versus blank line", b: "\n", status: 1,
			body: "@@ -0,0 +1 @@\n+\n",
		},
		{
			name: "blank line versus empty", a: "\n", status: 1,
			body: "@@ -1 +0,0 @@\n-\n",
		},
		{
			name: "ignore case preserves terminator", a: "HELLO\n", b: "hello",
			flags: []string{"-i"}, status: 1,
			body: "@@ -1 +1 @@\n-HELLO\n+hello\n" + missing,
		},
		{
			name: "strip CR preserves terminator", a: "hello\r\n", b: "hello",
			flags: []string{"--strip-trailing-cr"}, status: 1,
			body: "@@ -1 +1 @@\n-hello\n+hello\n" + missing,
		},
		{
			name: "strip CR preserves unterminated CR", a: "hello\r", b: "hello",
			flags: []string{"--strip-trailing-cr"}, status: 1,
			body: "@@ -1 +1 @@\n-hello\r\n" + missing + "+hello\n" + missing,
		},
		{
			name: "strip CR matches complete lines", a: "hello\r\n", b: "hello\n",
			flags: []string{"--strip-trailing-cr"},
		},
		{
			name: "ignore space change", a: "hello\n", b: "hello",
			flags: []string{"-b"},
		},
		{
			name: "ignore all space", a: "h e llo\n", b: "hello",
			flags: []string{"-w"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, data := range map[string]string{"a.txt": c.a, "b.txt": c.b} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			for _, input := range []string{"files", "expected on stdin", "actual on stdin"} {
				t.Run(input, func(t *testing.T) {
					files := []string{"a.txt", "b.txt"}
					var stdin string
					switch input {
					case "expected on stdin":
						files[0], stdin = "-", c.a
					case "actual on stdin":
						files[1], stdin = "-", c.b
					}
					args := append(append([]string{}, c.flags...), files...)
					var out, errOut bytes.Buffer
					status := newShell(dir, nil).builtinDiff(args, strings.NewReader(stdin), &out, &errOut)
					want := ""
					if c.body != "" {
						want = "--- " + files[0] + "\n+++ " + files[1] + "\n" + c.body
					}
					if status != c.status || out.String() != want || errOut.Len() != 0 {
						t.Errorf("diff %v: status %d, stdout %q, stderr %q; want status %d, stdout %q",
							args, status, out.String(), errOut.String(), c.status, want)
					}
				})
			}
		})
	}
}
