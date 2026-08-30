// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"strings"
	"testing"
)

// runCheck runs the checker over in-memory check and input text, returning
// the exit status and everything written to stderr.
func runCheck(t *testing.T, argv []string, check, input string) (int, string) {
	t.Helper()
	args, err := parseCheckArgs(argv)
	if err != nil {
		t.Fatalf("parseCheckArgs(%q): %v", argv, err)
	}
	var stdout, stderr bytes.Buffer
	inv := invocation{stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr}
	status := checkContent(inv, args, []byte(check), "check.txt", []byte(input), "<stdin>")
	return status, stderr.String()
}

type checkCase struct {
	name   string
	argv   []string
	check  string
	input  string
	status int
	// want are substrings that must appear in stderr; wantNot must not.
	want    []string
	wantNot []string
}

func runCheckCases(t *testing.T, cases []checkCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			status, out := runCheck(t, c.argv, c.check, c.input)
			if status != c.status {
				t.Errorf("status = %d, want %d\nstderr:\n%s", status, c.status, out)
			}
			for _, w := range c.want {
				if !strings.Contains(out, w) {
					t.Errorf("stderr missing %q\nstderr:\n%s", w, out)
				}
			}
			for _, w := range c.wantNot {
				if strings.Contains(out, w) {
					t.Errorf("stderr unexpectedly contains %q\nstderr:\n%s", w, out)
				}
			}
		})
	}
}

func TestPlainChecks(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "sequence", check: "CHECK: a\nCHECK: b\n", input: "a\nb\n", status: 0},
		{name: "order matters", check: "CHECK: b\nCHECK: a\n", input: "a\nb\n", status: 1,
			want: []string{"check.txt:2:8: error: CHECK: expected string not found in input", "scanning from here"}},
		{name: "substring", check: "CHECK: bar", input: "foobarbaz\n", status: 0},
		{name: "whitespace canonicalized", check: "CHECK: a   b\tc", input: "a b\t\tc\n", status: 0},
		{name: "strict whitespace", argv: []string{"--strict-whitespace"}, check: "CHECK: a  b", input: "a b\n", status: 1},
		{name: "strict whitespace ok", argv: []string{"--strict-whitespace"}, check: "CHECK: a  b", input: "a  b\n", status: 0},
		{name: "crlf input", check: "CHECK: a\nCHECK-NEXT: b", input: "a\r\nb\r\n", status: 0},
		{name: "ignore case", argv: []string{"--ignore-case"}, check: "CHECK: HeLLo {{w[o]rld}}", input: "hello WORLD\n", status: 0},
		{name: "ignore case plain", argv: []string{"--ignore-case"}, check: "CHECK: HeLLo", input: "say hello\n", status: 0},
		{name: "ignore case literal", argv: []string{"--ignore-case"}, check: "CHECK{LITERAL}: [[x]]", input: "[[X]]\n", status: 0},
		{name: "ignore case plain fails", argv: []string{"--ignore-case"}, check: "CHECK: hello", input: "help\n", status: 1},
		{name: "match full lines", argv: []string{"--match-full-lines"}, check: "CHECK: bar", input: "foobar\nbar\n", status: 0},
		{name: "match full lines fails", argv: []string{"--match-full-lines"}, check: "CHECK: bar", input: "foobar\n", status: 1},
		{name: "regex", check: "CHECK: x = {{[0-9]+}}{{$}}", input: "x = 42\n", status: 0},
		{name: "regex needs eol", check: "CHECK: x = {{[0-9]+}}{{$}}", input: "x = 42 y\n", status: 1},
		{name: "literal modifier", check: "CHECK{LITERAL}: [[x]] {{y}}", input: "[[x]] {{y}}\n", status: 0},
		{name: "count", check: "CHECK-COUNT-3: ab", input: "ab ab ab\n", status: 0},
		{name: "count short", check: "CHECK-COUNT-3: ab", input: "ab ab\n", status: 1,
			want: []string{"CHECK-COUNT: expected string not found in input (2 out of 3)"}},
		{name: "empty input", check: "CHECK: a", input: "", status: 2, want: []string{"'<stdin>' is empty"}},
		{name: "allow empty", argv: []string{"--allow-empty"}, check: "CHECK-NOT: a", input: "", status: 0},
		{name: "comment prefix", check: "COM: CHECK: nope\nRUN: x | FileCheck CHECK: nope\nCHECK: yes", input: "yes\n", status: 0},
		{name: "prefix boundary", check: "XCHECK: nope\nCHECK: yes", input: "yes\n", status: 0},
		{name: "custom prefix", argv: []string{"--check-prefix=FOO"}, check: "CHECK: nope\nFOO: yes", input: "yes\n", status: 0},
		{name: "multiple prefixes", argv: []string{"--check-prefixes=A,B"}, check: "A: one\nB: two", input: "one two\n", status: 0},
		{name: "unused prefix", argv: []string{"--check-prefixes=A,B"}, check: "A: one", input: "one\n", status: 2,
			want: []string{"no check strings found with prefix 'B:'"}},
		{name: "unused prefix allowed", argv: []string{"--check-prefixes=A,B", "--allow-unused-prefixes"}, check: "A: one", input: "one\n", status: 0},
		{name: "no checks", check: "nothing here", input: "one\n", status: 2, want: []string{"no check strings found with prefix 'CHECK:'"}},
		{name: "empty check", check: "CHECK:   ", input: "one\n", status: 2, want: []string{"found empty check string with prefix 'CHECK:'"}},
		{name: "fuzzy note", check: "CHECK: hello world", input: "hallo world\n", status: 1, want: []string{"possible intended match here"}},
		{name: "longest prefix wins", argv: []string{"--check-prefixes=CHECK,CHECK-A"}, check: "CHECK: a\nCHECK-A: b", input: "a\nb\n", status: 0},
	})
}

func TestNextSameEmpty(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "next ok", check: "CHECK: a\nCHECK-NEXT: b", input: "a\nb\n", status: 0},
		{name: "next skips line", check: "CHECK: a\nCHECK-NEXT: c", input: "a\nb\nc\n", status: 1,
			want: []string{"CHECK-NEXT: is not on the line after the previous match", "non-matching line after previous match is here"}},
		{name: "next same line", check: "CHECK: a\nCHECK-NEXT: b", input: "a b\n", status: 1,
			want: []string{"CHECK-NEXT: is on the same line as previous match"}},
		{name: "same ok", check: "CHECK: a\nCHECK-SAME: b", input: "a b\n", status: 0},
		{name: "same fails", check: "CHECK: a\nCHECK-SAME: b", input: "a\nb\n", status: 1,
			want: []string{"CHECK-SAME: is not on the same line as the previous match"}},
		{name: "empty ok", check: "CHECK: a\nCHECK-EMPTY:\nCHECK-NEXT: b", input: "a\n\nb\n", status: 0},
		{name: "empty fails", check: "CHECK: a\nCHECK-EMPTY:", input: "a\nb\n\n", status: 1,
			want: []string{"CHECK-EMPTY: is not on the line after the previous match"}},
		{name: "empty non-empty pattern", check: "CHECK: a\nCHECK-EMPTY: x", input: "a\n", status: 2,
			want: []string{"found non-empty check string for empty check with prefix 'CHECK-EMPTY:'"}},
		{name: "next without check", check: "CHECK-NEXT: a", input: "a\n", status: 2,
			want: []string{"found 'CHECK-NEXT:' without previous 'CHECK: line"}},
		{name: "same without check", check: "CHECK-SAME: a", input: "a\n", status: 2},
		{name: "bad not combo", check: "CHECK-NOT-NEXT: a", input: "a\n", status: 2, want: []string{"unsupported -NOT combo"}},
		{name: "bad count", check: "CHECK-COUNT-0: a", input: "a\n", status: 2, want: []string{"invalid count in -COUNT specification"}},
	})
}

func TestNotAndDag(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "not ok", check: "CHECK: a\nCHECK-NOT: x\nCHECK: b", input: "a\ny\nb\n", status: 0},
		{name: "not found", check: "CHECK: a\nCHECK-NOT: x\nCHECK: b", input: "a\nx\nb\n", status: 1,
			want: []string{"CHECK-NOT: excluded string found in input", "found here"}},
		{name: "not only checks region", check: "CHECK: a\nCHECK-NOT: x\nCHECK: b", input: "x\na\nb\nx\n", status: 0},
		{name: "trailing not", check: "CHECK: a\nCHECK-NOT: x", input: "a\nx\n", status: 1},
		{name: "trailing not ok", check: "CHECK: a\nCHECK-NOT: x", input: "x\na\n", status: 0},
		{name: "dag any order", check: "CHECK-DAG: b\nCHECK-DAG: a\nCHECK: c", input: "a\nb\nc\n", status: 0},
		{name: "dag no overlap", check: "CHECK-DAG: ab\nCHECK-DAG: ab", input: "ab\n", status: 1},
		{name: "dag no overlap two", check: "CHECK-DAG: ab\nCHECK-DAG: ab", input: "ab ab\n", status: 0},
		{name: "dag deprecated overlap", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-DAG: ab\nCHECK-DAG: ab", input: "ab\n", status: 0},
		{name: "not between dags", check: "CHECK-DAG: a\nCHECK-NOT: x\nCHECK-DAG: b", input: "a\nx\nb\n", status: 1,
			want: []string{"CHECK-NOT: excluded string found in input"}},
		{name: "not between dags ok", check: "CHECK-DAG: a\nCHECK-NOT: x\nCHECK-DAG: b", input: "x\na\nb\nx\n", status: 0},
		{name: "dag then check", check: "CHECK-DAG: a\nCHECK-DAG: b\nCHECK: c", input: "b\na\nc\n", status: 0},
		{name: "dag after check region", check: "CHECK: a\nCHECK-DAG: b\nCHECK-DAG: c", input: "c\na\nc\nb\n", status: 0},
		{name: "dag missing", check: "CHECK-DAG: a\nCHECK-DAG: z", input: "a\nb\n", status: 1,
			want: []string{"CHECK-DAG: expected string not found in input"}},
		{name: "implicit check not", argv: []string{"--implicit-check-not=warning"}, check: "CHECK: a\nCHECK: b", input: "a\nwarning: x\nb\n", status: 1,
			want: []string{"IMPLICIT-CHECK-NOT: excluded string found in input"}},
		{name: "implicit check not ok", argv: []string{"--implicit-check-not=warning"}, check: "CHECK: a\nCHECK: b", input: "a\nb\n", status: 0},
		{name: "implicit check not trailing", argv: []string{"--implicit-check-not=warning"}, check: "CHECK: a", input: "a\nwarning\n", status: 1},
		{name: "implicit check not without checks", argv: []string{"--implicit-check-not=warning"}, check: "no directives", input: "ok\n", status: 0},
	})
}

func TestLabels(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "partition", check: "CHECK-LABEL: f1:\nCHECK: x\nCHECK-LABEL: f2:\nCHECK: x", input: "f1:\nx\nf2:\nx\n", status: 0},
		{name: "partition blocks", check: "CHECK-LABEL: f1:\nCHECK: y\nCHECK-LABEL: f2:\nCHECK: x", input: "f1:\nx\nf2:\ny\n", status: 1,
			want: []string{"check.txt:2:8: error: CHECK: expected string not found"}},
		{name: "reports both blocks", check: "CHECK-LABEL: f1:\nCHECK: y\nCHECK-LABEL: f2:\nCHECK: y", input: "f1:\nx\nf2:\nx\n", status: 1,
			want: []string{"check.txt:2:8: error", "check.txt:4:8: error"}},
		{name: "label missing", check: "CHECK-LABEL: f3:", input: "f1:\n", status: 1,
			want: []string{"CHECK-LABEL: expected string not found in input"}},
		{name: "label with variable", check: "CHECK-LABEL: [[X:.*]]", input: "f1:\n", status: 2,
			want: []string{"found 'CHECK-LABEL:' with variable definition or use"}},
		{name: "var scope", argv: []string{"--enable-var-scope"}, check: "CHECK: [[X:a]]\nCHECK-LABEL: l\nCHECK: [[X]]", input: "a\nl\na\n", status: 1,
			want: []string{"undefined variable: X"}},
		{name: "var scope globals", argv: []string{"--enable-var-scope"}, check: "CHECK: [[$X:a]]\nCHECK-LABEL: l\nCHECK: [[$X]]", input: "a\nl\na\n", status: 0},
		{name: "no var scope", check: "CHECK: [[X:a]]\nCHECK-LABEL: l\nCHECK: [[X]]", input: "a\nl\na\n", status: 0},
	})
}

func TestStringVariables(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "define and use", check: "CHECK: v = [[V:[0-9]+]]\nCHECK: w = [[V]]", input: "v = 12\nw = 12\n", status: 0},
		{name: "use mismatch", check: "CHECK: v = [[V:[0-9]+]]\nCHECK: w = [[V]]", input: "v = 12\nw = 13\n", status: 1,
			want: []string{`with "[[V]]" equal to "12"`}},
		{name: "value is literal", check: "CHECK: [[V:.*]]\nCHECK: [[V]]", input: "a.b\naxb\n", status: 1},
		{name: "same line backreference", check: "CHECK: [[R:%[a-z]+]] = add [[R]], 1", input: "%x = add %y, 1\n%z = add %z, 1\n", status: 0},
		{name: "same line backreference fails", check: "CHECK: [[R:%[a-z]+]] = add [[R]], 1", input: "%x = add %y, 1\n", status: 1},
		{name: "same line backreference greedy", check: "CHECK: [[R:.*]] = add [[R]], 1", input: "%x = add %y, 1\n%z = add %z, 1\n", status: 0},
		{name: "undefined", check: "CHECK: [[V]]", input: "x\n", status: 1, want: []string{"undefined variable: V"}},
		{name: "cmdline define", argv: []string{"-DV=hello", "-D", "W=world"}, check: "CHECK: [[V]] [[W]]", input: "hello world\n", status: 0},
		{name: "cmdline define literal", argv: []string{"-DV=a.b"}, check: "CHECK: [[V]]", input: "axb\n", status: 1},
		{name: "invalid name", check: "CHECK: [[1V:a]]", input: "a\n", status: 2, want: []string{"invalid variable name"}},
		{name: "invalid use", check: "CHECK: [[V-1]]", input: "a\n", status: 2, want: []string{"invalid name in string variable use"}},
		{name: "unterminated", check: "CHECK: [[V:a", input: "a\n", status: 2, want: []string{"no end ']]'"}},
		{name: "unterminated regex", check: "CHECK: {{a", input: "a\n", status: 2, want: []string{"no end '}}'"}},
		{name: "bad regex", check: "CHECK: {{a(}}", input: "a\n", status: 2, want: []string{"invalid regex"}},
		{name: "triple bracket literal", check: "CHECK: [[[V:x]]]", input: "[x]\n", status: 0},
		{name: "empty regex definition", check: "CHECK: a[[V:]]b\nCHECK: [[V]]c", input: "ab\nc\n", status: 0},
		{name: "nested brackets", check: "CHECK: [[V:[[:alpha:]]+]] [[V]]", input: "abc abc\n", status: 0},
		{name: "not with variable", check: "CHECK: [[V:x]]\nCHECK-NOT: [[V]]\nCHECK: end", input: "x\ny\nend\n", status: 0},
		{name: "not with variable found", check: "CHECK: [[V:x]]\nCHECK-NOT: [[V]]\nCHECK: end", input: "x\nx\nend\n", status: 1},
	})
}

func TestNumericVariables(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "define use", check: "CHECK: n=[[#N:]]\nCHECK: m=[[#N+1]]", input: "n=41\nm=42\n", status: 0},
		{name: "define use mismatch", check: "CHECK: n=[[#N:]]\nCHECK: m=[[#N+1]]", input: "n=41\nm=43\n", status: 1,
			want: []string{`with "[[#N+1]]" equal to "42"`}},
		{name: "hex", check: "CHECK: [[#%x,H:]]\nCHECK: [[#%X,H]] [[#H]] [[#%u,H]]", input: "ff\nFF ff 255\n", status: 0},
		{name: "hex alternate", check: "CHECK: [[#%#x,H:]]\nCHECK: [[#H+1]] [[#%u,H+1]]", input: "0x10\n0x11 17\n", status: 0},
		{name: "signed", check: "CHECK: [[#%d,S:]]\nCHECK: [[#S+1]]", input: "-3\n-2\n", status: 0},
		{name: "unsigned rejects negative", check: "CHECK: n=[[#N:]]", input: "n=-3\n", status: 1},
		{name: "precision", check: "CHECK: [[#%.3d,P:]]\nCHECK: [[#%.4d,P+1]]", input: "007\n0008\n", status: 0},
		{name: "expression precedence", check: "CHECK: [[#N:]]\nCHECK: [[#N+1*2]]", input: "3\n8\n", status: 0},
		{name: "parens", check: "CHECK: [[#N:]]\nCHECK: [[#N+(1*2)]]", input: "3\n5\n", status: 0},
		{name: "functions", check: "CHECK: [[#N:]]\nCHECK: [[#min(N,2)]] [[#max(N,5)]] [[#add(N,1)]] [[#sub(N,1)]] [[#mul(N,2)]] [[#div(N,2)]]", input: "4\n2 5 5 3 8 2\n", status: 0},
		{name: "line", check: "CHECK: line [[#@LINE]] [[@LINE]] [[@LINE+1]] [[#@LINE-1]]", input: "line 1 1 2 0\n", status: 0},
		{name: "legacy line non literal", check: "CHECK: [[@LINE+N]]", input: "x\n", status: 2},
		{name: "same directive use", check: "CHECK: [[#N:]] [[#N]]", input: "1 1\n", status: 2,
			want: []string{"numeric variable 'N' defined earlier in the same CHECK directive"}},
		{name: "define with expression", check: "CHECK: a=[[#A:]]\nCHECK: b=[[#B: A+1]]\nCHECK: c=[[#B]]", input: "a=1\nb=2\nc=2\n", status: 0},
		{name: "define with expression mismatch", check: "CHECK: a=[[#A:]]\nCHECK: b=[[#B: A+1]]", input: "a=1\nb=3\n", status: 1},
		{name: "define with constraint", check: "CHECK: a=[[#A:]]\nCHECK: b=[[#B: == A+1]]", input: "a=1\nb=2\n", status: 0},
		{name: "cmdline numeric", argv: []string{"-D#N=5", "-D#%x,H=255"}, check: "CHECK: [[#N+1]] [[#H]]", input: "6 ff\n", status: 0},
		{name: "cmdline numeric bad", argv: []string{"-D#N=x"}, check: "CHECK: [[#N]]", input: "6\n", status: 2},
		{name: "undefined numeric", check: "CHECK: [[#N]]", input: "6\n", status: 1, want: []string{"undefined variable: N"}},
		{name: "undefined numeric reports every name", check: "CHECK: [[#A+B]]", input: "6\n", status: 1,
			want: []string{"check.txt:1:8: error: undefined variable: A", "check.txt:1:8: error: undefined variable: B"}},
		{name: "undefined string and numeric", check: "CHECK: [[S]] [[#N]]", input: "6\n", status: 1,
			want: []string{"undefined variable: S", "undefined variable: N"}},
		{name: "division by zero", check: "CHECK: [[#N:]]\nCHECK: [[#N/0]]", input: "6\n0\n", status: 1, want: []string{"division by 0"}},
		{name: "format conflict", check: "CHECK: [[#%x,A:]] [[#%d,B:]]\nCHECK: [[#A+B]]", input: "1 2\n3\n", status: 2, want: []string{"implicit format conflict"}},
		{name: "explicit format resolves conflict", check: "CHECK: [[#%x,A:]] [[#%d,B:]]\nCHECK: [[#%u,A+B]]", input: "1 2\n3\n", status: 0},
		{name: "bad format", check: "CHECK: [[#%q,A:]]", input: "1\n", status: 2, want: []string{"invalid conversion specifier"}},
		{name: "unsupported op", check: "CHECK: [[#N:]]\nCHECK: [[#N%2]]", input: "1\n1\n", status: 2, want: []string{"unsupported operation '%'"}},
		{name: "string numeric collision", check: "CHECK: [[N:a]] [[#N:]]", input: "a 1\n", status: 2, want: []string{"string variable with name 'N' already exists"}},
		{name: "numeric string collision", check: "CHECK: [[#N:]] [[N:a]]", input: "1 a\n", status: 2, want: []string{"numeric variable with name 'N' already exists"}},
		{name: "overflow", check: "CHECK: [[#N:]]\nCHECK: [[#N*2]]", input: "18446744073709551615\nx\n", status: 1, want: []string{"unsigned overflow"}},
		{name: "hex literal", check: "CHECK: [[#0x10+0b1+0o7+010]]", input: "32\n", status: 0},
		{name: "trailing garbage", check: "CHECK: [[#N:]]\nCHECK: [[#N)]]", input: "1\n1\n", status: 2, want: []string{"unexpected characters at end of expression"}},
	})
}

func TestDumpInput(t *testing.T) {
	status, out := runCheck(t, []string{"--dump-input=always", "-v"}, "CHECK: a\nCHECK-NEXT: b\n", "a\nb\n")
	if status != 0 {
		t.Fatalf("status = %d\n%s", status, out)
	}
	for _, w := range []string{"<<<<<<", ">>>>>>", "check:1", "^", "next:2", "1: a", "2: b"} {
		if !strings.Contains(out, w) {
			t.Errorf("dump missing %q:\n%s", w, out)
		}
	}
	status, out = runCheck(t, []string{"--dump-input=never"}, "CHECK: z\n", "a\n")
	if status != 1 || strings.Contains(out, "<<<<<<") {
		t.Errorf("--dump-input=never printed a dump (status %d):\n%s", status, out)
	}
	status, out = runCheck(t, []string{"--dump-input-filter=error", "--dump-input-context=0"}, "CHECK: a\nCHECK: zb\n", "a\nb\nc\n")
	if status != 1 || !strings.Contains(out, "error: no match found") {
		t.Errorf("default dump lacks the error annotation (status %d):\n%s", status, out)
	}
	// The fuzzy-match hint counts as part of the error, so its line shows.
	if !strings.Contains(out, "2: b\n") || !strings.Contains(out, "? possible intended match") {
		t.Errorf("filter=error should show the fuzzy match line:\n%s", out)
	}
	if strings.Contains(out, "3: c") {
		t.Errorf("filter=error with no context should hide unannotated lines:\n%s", out)
	}
	status, out = runCheck(t, []string{"--dump-input=always", "--dump-input-filter=all"}, "CHECK: a\n", "a\nb\nc\n")
	if status != 0 || !strings.Contains(out, "3: c") {
		t.Errorf("filter=all should show every line (status %d):\n%s", status, out)
	}
}

func TestVerboseOutput(t *testing.T) {
	_, out := runCheck(t, []string{"-v"}, "CHECK: a\nCHECK-NOT: x\n", "a\n")
	if !strings.Contains(out, "remark: CHECK: expected string found in input") {
		t.Errorf("-v should report matches:\n%s", out)
	}
	if strings.Contains(out, "excluded string not found") {
		t.Errorf("-v should not report CHECK-NOT searches:\n%s", out)
	}
	_, out = runCheck(t, []string{"-vv"}, "CHECK: a\nCHECK-NOT: x\n", "a\n")
	if !strings.Contains(out, "remark: CHECK-NOT: excluded string not found in input") {
		t.Errorf("-vv should report CHECK-NOT searches:\n%s", out)
	}
	_, out = runCheck(t, []string{"-vv"}, "CHECK-DAG: ab\nCHECK-DAG: ab\n", "ab ab\n")
	if !strings.Contains(out, "match discarded, overlaps earlier DAG match here") {
		t.Errorf("-vv should report discarded DAG matches:\n%s", out)
	}
}

func TestCanonicalize(t *testing.T) {
	got := string(canonicalize([]byte("a \t b\r\nc\td\n"), false))
	if got != "a b\nc d\n" {
		t.Errorf("canonicalize = %q", got)
	}
	got = string(canonicalize([]byte("a \t b\r\nc\n"), true))
	if got != "a \t b\nc\n" {
		t.Errorf("strict canonicalize = %q", got)
	}
}

func TestFindCheckType(t *testing.T) {
	cases := []struct {
		rest    string
		ty      checkType
		count   int
		literal bool
		// n is the length of the directive suffix through the colon.
		n int
	}{
		{":", checkPlain, 1, false, 1},
		{": text", checkPlain, 1, false, 1},
		{"-NEXT:", checkNext, 1, false, 6},
		{"-SAME:", checkSame, 1, false, 6},
		{"-NOT:", checkNot, 1, false, 5},
		{"-DAG:", checkDAG, 1, false, 5},
		{"-LABEL:", checkLabel, 1, false, 7},
		{"-EMPTY:", checkEmpty, 1, false, 7},
		{"-COUNT-12: x", checkPlain, 12, false, 10},
		{"{LITERAL}:", checkPlain, 1, true, 10},
		{"-NEXT{LITERAL}: x", checkNext, 1, true, 15},
		{"-COUNT-2{LITERAL}:", checkPlain, 2, true, 18},
		{"S: x", checkNone, 0, false, 0},
		{"-FOO:", checkNone, 0, false, 0},
		{"-EOF:", checkNone, 0, false, 0},
		{"-NEXT", checkNone, 0, false, 0},
		{"{LITERAL}-NEXT:", checkNone, 0, false, 0},
		{"", checkNone, 0, false, 0},
	}
	for _, c := range cases {
		ty, count, literal, n, err := findCheckType(c.rest, false)
		if err != nil || ty != c.ty || count != c.count || literal != c.literal || n != c.n {
			t.Errorf("findCheckType(%q) = (%v, %d, %v, %d, %v), want (%v, %d, %v, %d)", c.rest, ty, count, literal, n, err, c.ty, c.count, c.literal, c.n)
		}
	}
	for _, bad := range []string{"-NOT-NEXT:", "-NEXT-NOT:", "-DAG-NOT{LITERAL}:", "-NOT-COUNT-2:", "-COUNT-x:", "-COUNT-0:", "-COUNT-2", "-COUNT-:"} {
		if _, _, _, _, err := findCheckType(bad, false); err == nil {
			t.Errorf("findCheckType(%q) accepted", bad)
		}
	}
	if ty, _, _, n, err := findCheckType(": x", true); err != nil || ty != checkComment || n != 1 {
		t.Errorf("comment prefix: (%v, %d, %v)", ty, n, err)
	}
	if ty, _, _, _, err := findCheckType("-NOT:", true); err != nil || ty != checkNone {
		t.Errorf("comment prefix with suffix: (%v, %v)", ty, err)
	}
}

func TestRegexFragmentAlternation(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "first alternative", check: "CHECK: before{{left|right}}after", input: "beforeleftafter\n", status: 0},
		{name: "second alternative", check: "CHECK: before{{left|right}}after", input: "beforerightafter\n", status: 0},
		{name: "suffix required", check: "CHECK: before{{left|right}}after", input: "beforeleft\n", status: 1},
		{name: "prefix required", check: "CHECK: before{{left|right}}after", input: "rightafter\n", status: 1},
		{name: "capture numbering", check: "CHECK: {{(left|right)}} [[S:[a-z]+]] [[#N:]] [[S]]\nCHECK: [[S]] [[#N+1]]", input: "right value 41 value\nvalue 42\n", status: 0},
		{name: "full line anchors", argv: []string{"--match-full-lines"}, check: "CHECK: {{left|right}}", input: "leftover\n", status: 1},
	})
}

func TestFullLinesNegativeChecks(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "explicit substring", argv: []string{"--match-full-lines"}, check: "CHECK: ok\nCHECK-NOT: bad", input: "ok\nvery bad thing\n", status: 1,
			want: []string{"CHECK-NOT: excluded string found in input"}},
		{name: "explicit regex substring", argv: []string{"--match-full-lines"}, check: "CHECK: ok\nCHECK-NOT: b{{a}}d", input: "ok\nvery bad thing\n", status: 1},
		{name: "implicit substring", argv: []string{"--match-full-lines", "--implicit-check-not=bad"}, check: "CHECK: ok", input: "ok\nvery bad thing\n", status: 1},
		{name: "negative absent", argv: []string{"--match-full-lines"}, check: "CHECK: ok\nCHECK-NOT: bad", input: "ok\nvery good thing\n", status: 0},
		{name: "strict negative substring", argv: []string{"--match-full-lines", "--strict-whitespace"}, check: "CHECK:ok\nCHECK-NOT:bad", input: "ok\nvery bad thing\n", status: 1},
		{name: "explicit anchors preserved", argv: []string{"--match-full-lines"}, check: "CHECK: ok\nCHECK-NOT: {{^bad$}}", input: "ok\nvery bad thing\n", status: 0},
	})
}

func TestFullLinesWhitespace(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "leading blanks", argv: []string{"--match-full-lines"}, check: "CHECK: ok", input: " \t ok\n", status: 0},
		{name: "trailing blanks", argv: []string{"--match-full-lines"}, check: "CHECK: ok", input: "ok \t \n", status: 0},
		{name: "both sides with capture", argv: []string{"--match-full-lines"}, check: "CHECK: [[S:ok]]\nCHECK: [[S]]", input: "  ok  \n\tok\t\n", status: 0},
		{name: "nonblank prefix rejected", argv: []string{"--match-full-lines"}, check: "CHECK: ok", input: "x ok\n", status: 1},
		{name: "nonblank suffix rejected", argv: []string{"--match-full-lines"}, check: "CHECK: ok", input: "ok x\n", status: 1},
		{name: "strict leading blanks rejected", argv: []string{"--match-full-lines", "--strict-whitespace"}, check: "CHECK:ok", input: " ok\n", status: 1},
		{name: "strict trailing blanks rejected", argv: []string{"--match-full-lines", "--strict-whitespace"}, check: "CHECK:ok", input: "ok \n", status: 1},
		{name: "strict exact whitespace", argv: []string{"--match-full-lines", "--strict-whitespace"}, check: "CHECK: ok ", input: " ok \n", status: 0},
		{name: "literal shortcut preserved", argv: []string{"--match-full-lines"}, check: "CHECK{LITERAL}: ok", input: "prefix ok suffix\n", status: 0},
	})
}

func TestAnonymousNumericWildcards(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "default unsigned", check: "CHECK: value=[[#]];", input: "value=42;\n", status: 0},
		{name: "explicit unsigned", check: "CHECK: value=[[#%u,]];", input: "value=42;\n", status: 0},
		{name: "signed", check: "CHECK: value=[[#%d,]];", input: "value=-42;\n", status: 0},
		{name: "lowercase hex", check: "CHECK: value=[[#%x,]];", input: "value=af;\n", status: 0},
		{name: "uppercase hex", check: "CHECK: value=[[#%X,]];", input: "value=AF;\n", status: 0},
		{name: "alternate hex", check: "CHECK: value=[[#%#x,]];", input: "value=0xaf;\n", status: 0},
		{name: "precision capture numbering", check: "CHECK: [[#%.3u,]] [[S:[a-z]+]] [[#N:]] [[S]]\nCHECK: [[S]] [[#N+1]]", input: "007 value 41 value\nvalue 42\n", status: 0},
		{name: "label without variables", check: "CHECK-LABEL: function [[#]]:\nCHECK: body", input: "function 42:\nbody\n", status: 0},
		{name: "not wildcard", check: "CHECK-NOT: value=[[#]];", input: "value=42;\n", status: 1},
		{name: "unsigned rejects minus", check: "CHECK: value=[[#]];", input: "value=-42;\n", status: 1},
		{name: "digits required", check: "CHECK: value=[[#]];", input: "value=;\n", status: 1},
		{name: "text rejected", check: "CHECK: value=[[#]];", input: "value=words;\n", status: 1},
		{name: "precision enforced", check: "CHECK: value=[[#%.3u,]];", input: "value=07;\n", status: 1},
		{name: "missing format separator", check: "CHECK: [[#%u]]", input: "42\n", status: 2},
		{name: "empty definition name", check: "CHECK: [[#:]]", input: "42\n", status: 2},
		{name: "incomplete expression", check: "CHECK: [[#1+]]", input: "42\n", status: 2},
	})
}

func TestDeprecatedDagGroupBounds(t *testing.T) {
	runCheckCases(t, []checkCase{
		{name: "following check after whole group", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-DAG: b\nCHECK-DAG: a\nCHECK: c", input: "a\nc\nb\n", status: 1},
		{name: "following check succeeds", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-DAG: b\nCHECK-DAG: a\nCHECK: c", input: "a\nb\nc\n", status: 0},
		{name: "preceding not stops before whole group", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-NOT: a\nCHECK-DAG: b\nCHECK-DAG: a", input: "a\nb\n", status: 0},
		{name: "preceding not still checked", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-NOT: x\nCHECK-DAG: b\nCHECK-DAG: a", input: "x\na\nb\n", status: 1},
		{name: "following not starts after whole group", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-DAG: b\nCHECK-DAG: a\nCHECK-NOT: b", input: "a\nb\n", status: 0},
		{name: "nested overlapping match keeps maximum end", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-DAG: abc\nCHECK-DAG: b\nCHECK: c", input: "abc\n", status: 1},
		{name: "overlapping matches remain allowed", argv: []string{"--allow-deprecated-dag-overlap"}, check: "CHECK-DAG: abc\nCHECK-DAG: b\nCHECK: d", input: "abcd\n", status: 0},
	})
}

func TestInvalidNotCombinations(t *testing.T) {
	for _, suffix := range []string{"NEXT", "SAME", "EMPTY", "DAG"} {
		for _, order := range []string{suffix + "-NOT", "NOT-" + suffix} {
			for _, modifier := range []string{"", "{LITERAL}"} {
				t.Run(order+modifier, func(t *testing.T) {
					status, out := runCheck(t, nil, "CHECK: a\nCHECK-"+order+modifier+": b", "a\nb\n")
					if status != 2 || !strings.Contains(out, "unsupported -NOT combo") {
						t.Errorf("invalid directive: status = %d, want 2 with unsupported -NOT combo\n%s", status, out)
					}
				})
			}
		}
	}
	runCheckCases(t, []checkCase{
		{name: "longer explicit prefix", argv: []string{"--check-prefixes=CHECK,CHECK-DAG-NOT"}, check: "CHECK: a\nCHECK-DAG-NOT: b", input: "a\nb\n", status: 0},
		{name: "unknown suffix ignored", check: "CHECK: a\nCHECK-DAG-NOT-OTHER: b", input: "a\n", status: 0},
	})
}
