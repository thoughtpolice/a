// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
)

// The diff builtin, for golden-output tests written as
// "RUN: %tool %s | diff %s.expected -".

type diffOp struct {
	kind byte // '=', '-', '+'
	a, b int  // line indexes into the two inputs
}

// diffLines computes an edit script from a to b with Myers' O(ND) algorithm.
func diffLines(a, b []string) []diffOp {
	// Trim the common prefix and suffix first; test outputs mostly agree.
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	var ops []diffOp
	for i := 0; i < prefix; i++ {
		ops = append(ops, diffOp{kind: '=', a: i, b: i})
	}
	for _, op := range myers(a[prefix:len(a)-suffix], b[prefix:len(b)-suffix]) {
		ops = append(ops, diffOp{kind: op.kind, a: op.a + prefix, b: op.b + prefix})
	}
	for i := 0; i < suffix; i++ {
		ops = append(ops, diffOp{kind: '=', a: len(a) - suffix + i, b: len(b) - suffix + i})
	}
	return ops
}

// diffIdentical reports whether an edit script changes nothing.
func diffIdentical(ops []diffOp) bool {
	return !slices.ContainsFunc(ops, func(op diffOp) bool { return op.kind != '=' })
}

// replaceAll is the edit script that deletes all of a and inserts all of b.
func replaceAll(a, b []string) []diffOp {
	ops := make([]diffOp, 0, len(a)+len(b))
	for i := range a {
		ops = append(ops, diffOp{kind: '-', a: i})
	}
	for j := range b {
		ops = append(ops, diffOp{kind: '+', b: j})
	}
	return ops
}

// myersLimit bounds the edit distance searched for; inputs further apart are
// too different to be worth an exact script.
const myersLimit = 4000

func myers(a, b []string) []diffOp {
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return replaceAll(a, b)
	}
	maxD := min(n+m, myersLimit)
	offset := maxD
	v := make([]int, 2*maxD+2)
	// trace[d] is v[offset-d : offset+d+2] as step d found it: the entries
	// that step reads and the backtrack revisits, indexed by k+d.
	var trace [][]int
	found := false
	for d := 0; d <= maxD && !found; d++ {
		trace = append(trace, slices.Clone(v[offset-d:offset+d+2]))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[offset+k-1] < v[offset+k+1]) {
				x = v[offset+k+1]
			} else {
				x = v[offset+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[offset+k] = x
			if x >= n && y >= m {
				found = true
				break
			}
		}
	}
	if !found {
		return replaceAll(a, b)
	}
	// Backtrack.
	var rev []diffOp
	x, y := n, m
	for d := len(trace) - 1; d >= 0; d-- {
		vd := trace[d]
		k := x - y
		var prevK int
		if k == -d || (k != d && vd[k-1+d] < vd[k+1+d]) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := vd[prevK+d]
		prevY := prevX - prevK
		for x > prevX && y > prevY {
			x--
			y--
			rev = append(rev, diffOp{kind: '=', a: x, b: y})
		}
		if d > 0 {
			if x == prevX {
				y--
				rev = append(rev, diffOp{kind: '+', b: y})
			} else {
				x--
				rev = append(rev, diffOp{kind: '-', a: x})
			}
		}
	}
	slices.Reverse(rev)
	return rev
}

// writeUnifiedDiff prints ops as a unified diff with the given context.
func writeUnifiedDiff(w io.Writer, nameA, nameB string, a, b []string, ops []diffOp, context int) {
	fmt.Fprintf(w, "--- %s\n+++ %s\n", nameA, nameB)
	writeLine := func(prefix byte, line string) {
		fmt.Fprintf(w, "%c%s", prefix, line)
		if !strings.HasSuffix(line, "\n") {
			fmt.Fprint(w, "\n\\ No newline at end of file\n")
		}
	}
	i := 0
	for i < len(ops) {
		if ops[i].kind == '=' {
			i++
			continue
		}
		// Hunk from context before this change through context after the
		// last change that is within 2*context of another.
		start := i
		for start > 0 && i-start < context && ops[start-1].kind == '=' {
			start--
		}
		end := i
		for end < len(ops) {
			// Advance over the change and trailing context, merging nearby
			// changes.
			for end < len(ops) && ops[end].kind != '=' {
				end++
			}
			eqRun := 0
			for end+eqRun < len(ops) && ops[end+eqRun].kind == '=' {
				eqRun++
			}
			if end+eqRun < len(ops) && eqRun <= 2*context {
				end += eqRun
				continue
			}
			end += min(eqRun, context)
			break
		}
		hunk := ops[start:end]
		aStart, bStart := -1, -1
		aCount, bCount := 0, 0
		for _, op := range hunk {
			if op.kind != '+' {
				if aStart < 0 {
					aStart = op.a
				}
				aCount++
			}
			if op.kind != '-' {
				if bStart < 0 {
					bStart = op.b
				}
				bCount++
			}
		}
		if aStart < 0 {
			aStart = hunkAnchor(ops, start, true)
		}
		if bStart < 0 {
			bStart = hunkAnchor(ops, start, false)
		}
		fmt.Fprintf(w, "@@ -%s +%s @@\n", hunkRange(aStart, aCount), hunkRange(bStart, bCount))
		for _, op := range hunk {
			switch op.kind {
			case '=':
				writeLine(' ', a[op.a])
			case '-':
				writeLine('-', a[op.a])
			case '+':
				writeLine('+', b[op.b])
			}
		}
		i = end
	}
}

func hunkAnchor(ops []diffOp, start int, sideA bool) int {
	for k := start - 1; k >= 0; k-- {
		if sideA && ops[k].kind != '+' {
			return ops[k].a + 1
		}
		if !sideA && ops[k].kind != '-' {
			return ops[k].b + 1
		}
	}
	return 0
}

func hunkRange(start, count int) string {
	if count == 0 {
		return strconv.Itoa(start) + ",0"
	}
	if count == 1 {
		return strconv.Itoa(start + 1)
	}
	return fmt.Sprintf("%d,%d", start+1, count)
}

type diffOptions struct {
	context         int
	ignoreSpace     bool // -b: runs of blanks compare equal
	ignoreAllSpace  bool // -w
	ignoreCase      bool // -i
	stripTrailingCR bool
}

func (o diffOptions) normalize(s string) string {
	if o.ignoreAllSpace {
		s = strings.Join(strings.Fields(s), "")
	} else if o.ignoreSpace {
		s = strings.Join(strings.Fields(s), " ")
	}
	if o.ignoreCase {
		s = strings.ToLower(s)
	}
	return s
}

// normalized returns the lines as they compare: the lines themselves unless
// an option folds them.
func (o diffOptions) normalized(lines []string) []string {
	if !o.ignoreSpace && !o.ignoreAllSpace && !o.ignoreCase {
		return lines
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = o.normalize(l)
	}
	return out
}

func splitDiffLines(data []byte, stripTrailingCR bool) []string {
	s := string(data)
	if s == "" {
		return nil
	}
	if stripTrailingCR {
		s = strings.ReplaceAll(s, "\r\n", "\n")
	}
	// Keep terminators so an incomplete final line compares differently and
	// the unified output can identify which file lacks its final newline.
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func (sh *shell) builtinDiff(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	opts := diffOptions{context: 3}
	var files []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-":
			files = append(files, a)
		case a == "--strip-trailing-cr":
			opts.stripTrailingCR = true
		case a == "-U" || a == "-C":
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "diff: option %s requires an argument\n", a)
				return 2
			}
			n, err := strconv.Atoi(args[i+1])
			if err != nil {
				fmt.Fprintf(stderr, "diff: invalid context '%s'\n", args[i+1])
				return 2
			}
			opts.context = n
			i++
		case strings.HasPrefix(a, "-U") || strings.HasPrefix(a, "-C"):
			n, err := strconv.Atoi(a[2:])
			if err != nil {
				fmt.Fprintf(stderr, "diff: invalid context '%s'\n", a[2:])
				return 2
			}
			opts.context = n
		case strings.HasPrefix(a, "-") && len(a) > 1 && !strings.HasPrefix(a, "--"):
			for j := 1; j < len(a); j++ {
				switch a[j] {
				case 'u', 'a', 'N':
					// Output is always unified; -a and -N are accepted for
					// compatibility.
				case 'b':
					opts.ignoreSpace = true
				case 'w':
					opts.ignoreAllSpace = true
				case 'i':
					opts.ignoreCase = true
				case 'r':
					fmt.Fprintln(stderr, "diff: recursive directory comparison (-r) is not supported")
					return 2
				default:
					if a[j] >= '0' && a[j] <= '9' {
						// -u3 style context.
						n, err := strconv.Atoi(a[j:])
						if err == nil {
							opts.context = n
							j = len(a)
							continue
						}
					}
					fmt.Fprintf(stderr, "diff: unsupported option -%c\n", a[j])
					return 2
				}
			}
		case strings.HasPrefix(a, "--"):
			fmt.Fprintf(stderr, "diff: unsupported option %s\n", a)
			return 2
		default:
			files = append(files, a)
		}
	}
	if len(files) != 2 {
		fmt.Fprintln(stderr, "diff: expected exactly two files")
		return 2
	}
	read := func(name string) ([]byte, error) {
		if name == "-" {
			return io.ReadAll(stdin)
		}
		full := sh.resolve(name)
		info, err := os.Stat(full)
		if err != nil {
			return nil, err
		}
		if info.IsDir() {
			return nil, fmt.Errorf("%s: is a directory", name)
		}
		return os.ReadFile(full)
	}
	dataA, err := read(files[0])
	if err != nil {
		fmt.Fprintf(stderr, "diff: %v\n", err)
		return 2
	}
	dataB, err := read(files[1])
	if err != nil {
		fmt.Fprintf(stderr, "diff: %v\n", err)
		return 2
	}
	linesA := splitDiffLines(dataA, opts.stripTrailingCR)
	linesB := splitDiffLines(dataB, opts.stripTrailingCR)
	ops := diffLines(opts.normalized(linesA), opts.normalized(linesB))
	if diffIdentical(ops) {
		return 0
	}
	writeUnifiedDiff(stdout, files[0], files[1], linesA, linesB, ops, opts.context)
	return 1
}
