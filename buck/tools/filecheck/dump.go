// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// The annotated input dump, in the format of LLVM's --dump-input.

const dumpInputHelp = `The following description was requested by -dump-input=help to
explain the input dump printed by FileCheck.

Related command-line options:

  - -dump-input=<value> selects when to dump input:
    - help: print this help and exit
    - always: always dump input
    - fail: dump input on failure (default)
    - never: never dump input
  - -dump-input-filter=<value> selects which input lines to dump:
    - all: all input lines
    - annotation-full: input lines with annotations
    - annotation: input lines with starting points of annotations
    - error: input lines with starting points of error annotations (default)
  - -dump-input-context=<N> adds N lines of context before and after every
    selected input line (default: 5)
  - -v and -vv add annotations for successful matches and for CHECK-DAG
    matches discarded due to overlap

Input dump annotation format:

  - "L:" labels line L of the input file
  - "T:L" labels the only match result for either (1) a pattern of type T from
    line L of the check file if L is an integer or (2) the I-th implicit
    pattern if L is "imp" followed by an integer I
  - "T:L'N" labels the Nth match result for such a pattern
  - "^~~" marks good match (reported if -v)
  - "!~~" marks bad match, such as:
    - CHECK-NEXT on same line as previous match (error)
    - CHECK-NOT found (error)
    - CHECK-DAG overlapping match (discarded, reported if -vv)
  - "X~~" marks search range when no match is found, such as:
    - CHECK-NEXT not found (error)
    - CHECK-NOT not found (success, reported if -vv)
    - CHECK-DAG not found after discarded matches (error)
  - "?"   marks fuzzy match when no match is found
  - "^"   with no "~" after it marks the position of a note
  - colon marks a line that is part of a multi-line annotation
  - "..." elides input lines not selected for the dump

`

type dumpOptions struct {
	filter  string // all, annotation-full, annotation, error
	context int
}

type lineAnnotation struct {
	label string
	col   int // 0-based start column
	// length is the extent marked on this line, drawn as the kind's marker
	// followed by tildes on the first line of a range and as tildes after.
	length  int
	kind    matchKind
	isStart bool
	note    string
}

// marker draws the annotation's range, e.g. "^~~~", "X~~", "?".
func (a lineAnnotation) marker() string {
	if !a.isStart {
		return strings.Repeat("~", max(a.length, 1))
	}
	return string(markerLead(a.kind)) + strings.Repeat("~", max(a.length-1, 0))
}

// filtersAsError reports whether the default dump filter shows the
// annotation: errors and the fuzzy-match hint that accompanies them.
func (a lineAnnotation) filtersAsError() bool {
	return a.kind.isError() || a.kind == matchFuzzy
}

func markerLead(kind matchKind) byte {
	switch kind {
	case matchFoundExpected:
		return '^'
	case matchFoundExcluded, matchFoundWrongLine, matchFoundDiscarded:
		return '!'
	case matchNoneExpected, matchNoneExcluded, matchNoneInvalidPattern:
		return 'X'
	case matchFuzzy:
		return '?'
	}
	return '^'
}

func markerNote(kind matchKind) string {
	switch kind {
	case matchFoundExcluded:
		return "error: no match expected"
	case matchFoundWrongLine:
		return "error: match on wrong line"
	case matchFoundDiscarded:
		return "discard: overlaps earlier match"
	case matchNoneExpected:
		return "error: no match found"
	case matchNoneInvalidPattern:
		return "error: match failed for invalid pattern"
	case matchFuzzy:
		return "possible intended match"
	}
	return ""
}

// dumpAnnotatedInput writes the input with its annotations to w.
func dumpAnnotatedInput(w io.Writer, input *sourceBuffer, checkName string, diags []inputDiag, verbose int, opts dumpOptions) {
	// Label each diagnostic; when a check line has several results they
	// are distinguished by 'N suffixes.
	type key struct {
		ty   checkType
		line int
	}
	counts := map[key]int{}
	for _, d := range diags {
		counts[key{d.ty, d.checkLine}]++
	}
	seen := map[key]int{}

	perLine := map[int][]lineAnnotation{}
	for _, d := range diags {
		switch d.kind {
		case matchFoundExpected:
			if verbose < 1 && d.note == "" {
				continue
			}
		case matchFoundDiscarded, matchNoneExcluded:
			if verbose < 2 {
				continue
			}
		}
		k := key{d.ty, d.checkLine}
		label := d.ty.short() + ":" + strconv.Itoa(d.checkLine)
		if d.checkLine <= 0 {
			label = d.ty.short() + ":imp"
		}
		if counts[k] > 1 {
			label += "'" + strconv.Itoa(seen[k])
		}
		seen[k]++

		startLine := input.lineOf(d.start)
		endLine := input.lineOf(d.end)
		if d.end > d.start && d.end == input.lineStart(endLine) {
			// A range ending exactly at a line start ends on the prior line.
			endLine--
		}
		note := d.note
		if note == "" {
			note = markerNote(d.kind)
		}
		for line := startLine; line <= endLine; line++ {
			ls := input.lineStart(line)
			col := 0
			if line == startLine {
				col = d.start - ls
			}
			endCol := input.lineLen(line)
			if line == endLine {
				endCol = d.end - ls
			}
			a := lineAnnotation{label: label, col: col, length: endCol - col, kind: d.kind, isStart: line == startLine}
			if line == startLine {
				a.note = note
			}
			perLine[line] = append(perLine[line], a)
		}
	}

	total := input.lineCount()
	if total == 0 {
		total = 1
	}
	selected := make([]bool, total+2)
	anySelected := false
	for line, anns := range perLine {
		for _, a := range anns {
			show := false
			switch opts.filter {
			case "annotation-full":
				show = true
			case "annotation":
				show = a.isStart
			case "error":
				show = a.isStart && a.filtersAsError()
			}
			if show && line >= 1 && line <= total {
				selected[line] = true
				anySelected = true
			}
		}
	}
	if opts.filter == "all" || !anySelected {
		for line := 1; line <= total; line++ {
			selected[line] = true
		}
	} else if opts.context > 0 {
		expanded := make([]bool, len(selected))
		copy(expanded, selected)
		for line := 1; line <= total; line++ {
			if !selected[line] {
				continue
			}
			for d := 1; d <= opts.context; d++ {
				if line-d >= 1 {
					expanded[line-d] = true
				}
				if line+d <= total {
					expanded[line+d] = true
				}
			}
		}
		selected = expanded
	}

	labelWidth := len(strconv.Itoa(total))
	for _, anns := range perLine {
		for _, a := range anns {
			labelWidth = max(labelWidth, len(a.label))
		}
	}

	fmt.Fprintf(w, "\nInput file: %s\nCheck file: %s\n\n", input.name, checkName)
	fmt.Fprintf(w, "-dump-input=help explains the following input dump.\n\nInput was:\n<<<<<<\n")
	elided := false
	for line := 1; line <= total; line++ {
		if !selected[line] {
			if !elided {
				pad := strings.Repeat(" ", labelWidth)
				for i := 0; i < 3; i++ {
					fmt.Fprintf(w, "%s .\n", pad)
				}
				elided = true
			}
			continue
		}
		elided = false
		text := escapeForDump(input.lineText(line))
		fmt.Fprintf(w, "%*d: %s\n", labelWidth, line, text)
		anns := perLine[line]
		sort.SliceStable(anns, func(i, j int) bool { return anns[i].col < anns[j].col })
		for _, a := range anns {
			fmt.Fprintf(w, "%-*s  %s%s", labelWidth, a.label, strings.Repeat(" ", a.col), a.marker())
			if a.note != "" {
				fmt.Fprintf(w, " %s", a.note)
			}
			fmt.Fprintln(w)
		}
	}
	fmt.Fprintln(w, ">>>>>>")
}

// escapeForDump makes control characters visible in dumped input lines.
func escapeForDump(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, "\\x%02x", r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
