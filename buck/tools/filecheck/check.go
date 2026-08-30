// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

type checkType int

const (
	checkNone checkType = iota
	checkPlain
	checkNext
	checkSame
	checkNot
	checkDAG
	checkLabel
	checkEmpty
	checkComment
	checkEOF
)

// checkSuffixes names the directive types spelled with a suffix after the
// prefix, e.g. "CHECK-NEXT". CHECK-COUNT-N is parsed separately, and
// checkEOF is only ever synthesized.
var checkSuffixes = []struct {
	name string
	ty   checkType
}{
	{"NEXT", checkNext}, {"SAME", checkSame}, {"NOT", checkNot}, {"DAG", checkDAG},
	{"LABEL", checkLabel}, {"EMPTY", checkEmpty}, {"EOF", checkEOF},
}

// suffix is the directive suffix after the prefix, e.g. "-NEXT".
func (t checkType) suffix() string {
	for _, s := range checkSuffixes {
		if s.ty == t {
			return "-" + s.name
		}
	}
	return ""
}

// short is the label used in the annotated input dump.
func (t checkType) short() string {
	for _, s := range checkSuffixes {
		if s.ty == t {
			return strings.ToLower(s.name)
		}
	}
	return "check"
}

func (t checkType) isDagOrNot() bool { return t == checkDAG || t == checkNot }

// checkString is one positive directive together with the CHECK-DAG and
// CHECK-NOT directives that precede it.
type checkString struct {
	pat    *pattern
	dagNot []*pattern
}

// checkOptions are the knobs from the command line that affect reading and
// matching.
type checkOptions struct {
	checkPrefixes      []string
	commentPrefixes    []string
	matchFullLines     bool
	strictWhitespace   bool
	ignoreCase         bool
	implicitCheckNot   []string
	allowUnusedPrefix  bool
	allowDeprecatedDag bool
	enableVarScope     bool
	defaultPrefix      bool
}

func defaultCheckOptions() checkOptions {
	return checkOptions{
		checkPrefixes:   []string{"CHECK"},
		commentPrefixes: []string{"COM", "RUN"},
		defaultPrefix:   true,
	}
}

func (o *checkOptions) patternOptions() patternOptions {
	return patternOptions{
		matchFullLines: o.matchFullLines,
		strictWS:       o.strictWhitespace,
		ignoreCase:     o.ignoreCase,
	}
}

// canonicalize normalizes line endings and, unless strict whitespace is
// requested, collapses runs of blanks to a single space. Both the check file
// and the input are canonicalized identically.
func canonicalize(data []byte, strict bool) []byte {
	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		c := data[i]
		if c == '\r' && i+1 < len(data) && data[i+1] == '\n' {
			continue
		}
		if strict || (c != ' ' && c != '\t') {
			out = append(out, c)
			continue
		}
		out = append(out, ' ')
		for i+1 < len(data) && (data[i+1] == ' ' || data[i+1] == '\t') {
			i++
		}
	}
	return out
}

func isPartOfWord(c byte) bool {
	return c == '-' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func validatePrefixes(kind string, prefixes []string, seen map[string]bool) error {
	for _, p := range prefixes {
		if p == "" {
			return fmt.Errorf("supplied %s prefix must not be the empty string", kind)
		}
		for i := 0; i < len(p); i++ {
			if !isPartOfWord(p[i]) {
				return fmt.Errorf("supplied %s prefix must start with a letter and contain only alphanumeric characters, hyphens, and underscores: '%s'", kind, p)
			}
		}
		if !(p[0] >= 'a' && p[0] <= 'z' || p[0] >= 'A' && p[0] <= 'Z') {
			return fmt.Errorf("supplied %s prefix must start with a letter and contain only alphanumeric characters, hyphens, and underscores: '%s'", kind, p)
		}
		if seen[p] {
			return fmt.Errorf("supplied %s prefix must be unique among check and comment prefixes: '%s'", kind, p)
		}
		seen[p] = true
	}
	return nil
}

// checkFile is a parsed check file.
type checkFile struct {
	buf     *sourceBuffer
	strings []checkString
	ctx     *varContext
	opts    checkOptions
	// prefixes are the check and comment prefixes, longest first so
	// "CHECK-A" beats "CHECK" wherever both apply; comments marks the
	// comment ones.
	prefixes []string
	comments map[string]bool
}

// prefixMatch is the result of locating a directive in the check file.
type prefixMatch struct {
	prefix  string
	ty      checkType
	loc     int // offset of the prefix
	after   int // offset just past the colon
	count   int
	literal bool
}

var (
	errBadNotCombo = errors.New("unsupported -NOT combo")
	errBadCount    = errors.New("invalid count in -COUNT specification")
)

// findCheckType classifies the text following a prefix. It returns the type,
// the count for -COUNT-N, whether {LITERAL} was given, and the length of the
// suffix through the colon. checkNone means the prefix starts no directive;
// an error means it starts a malformed one.
func findCheckType(rest string, isComment bool) (ty checkType, count int, literal bool, n int, err error) {
	if isComment {
		if strings.HasPrefix(rest, ":") {
			return checkComment, 0, false, 1, nil
		}
		return checkNone, 0, false, 0, nil
	}
	// directive accepts the optional {LITERAL} modifier and the colon that
	// end a directive of type ty.
	directive := func(ty checkType, count int, tail string) (checkType, int, bool, int, error) {
		tail, literal := strings.CutPrefix(tail, "{LITERAL}")
		if !strings.HasPrefix(tail, ":") {
			return checkNone, 0, false, 0, nil
		}
		return ty, count, literal, len(rest) - len(tail) + 1, nil
	}
	if !strings.HasPrefix(rest, "-") {
		return directive(checkPlain, 1, rest)
	}
	body := rest[1:]
	for _, s := range checkSuffixes {
		if s.ty == checkEOF || !strings.HasPrefix(body, s.name) {
			continue
		}
		tail := body[len(s.name):]
		if s.ty != checkNot && s.ty != checkLabel &&
			(strings.HasPrefix(tail, "-NOT:") || strings.HasPrefix(tail, "-NOT{LITERAL}:")) {
			return checkNone, 0, false, 0, errBadNotCombo
		}
		if s.ty == checkNot && strings.HasPrefix(tail, "-") {
			// CHECK-NOT-NEXT and the like are rejected rather than silently
			// treated as unknown prefixes.
			for _, other := range checkSuffixes {
				if other.ty != checkEOF && strings.HasPrefix(tail[1:], other.name) {
					return checkNone, 0, false, 0, errBadNotCombo
				}
			}
			if strings.HasPrefix(tail[1:], "COUNT") {
				return checkNone, 0, false, 0, errBadNotCombo
			}
		}
		return directive(s.ty, 1, tail)
	}
	if digits, ok := strings.CutPrefix(body, "COUNT-"); ok {
		i := 0
		for i < len(digits) && digits[i] >= '0' && digits[i] <= '9' {
			i++
		}
		c, err := strconv.Atoi(digits[:i])
		if i == 0 || err != nil || c <= 0 {
			return checkNone, 0, false, 0, errBadCount
		}
		if ty, count, literal, n, _ := directive(checkPlain, c, digits[i:]); ty != checkNone {
			return ty, count, literal, n, nil
		}
		return checkNone, 0, false, 0, errBadCount
	}
	return checkNone, 0, false, 0, nil
}

// findFirstMatchingPrefix scans forward from off for the next occurrence of a
// check or comment prefix that starts a directive. The returned bool is false
// when nothing further can be found.
func (f *checkFile) findFirstMatchingPrefix(off int) (prefixMatch, bool, error) {
	data := f.buf.data
	for pos := off; pos < len(data); pos++ {
		if pos > 0 && isPartOfWord(data[pos-1]) {
			continue
		}
		for _, p := range f.prefixes {
			after := pos + len(p)
			if after > len(data) || string(data[pos:after]) != p {
				continue
			}
			// A directive's suffix and colon follow on the prefix's line.
			eol := len(data)
			if i := bytes.IndexByte(data[after:], '\n'); i >= 0 {
				eol = after + i
			}
			ty, count, literal, n, err := findCheckType(string(data[after:eol]), f.comments[p])
			if err != nil {
				return prefixMatch{}, false, &checkFileError{off: pos, msg: err.Error() + " on prefix '" + p + "'"}
			}
			if ty == checkNone {
				// Not a directive; keep scanning after this prefix.
				continue
			}
			return prefixMatch{prefix: p, ty: ty, loc: pos, after: after + n, count: count, literal: literal}, true, nil
		}
	}
	return prefixMatch{}, false, nil
}

type checkFileError struct {
	off int
	msg string
}

func (e *checkFileError) Error() string { return e.msg }

// readCheckFile parses the (already canonicalized) check file.
func readCheckFile(buf *sourceBuffer, opts checkOptions, ctx *varContext) (*checkFile, error) {
	f := &checkFile{buf: buf, ctx: ctx, opts: opts, comments: map[string]bool{}}
	seen := map[string]bool{}
	if err := validatePrefixes("check", opts.checkPrefixes, seen); err != nil {
		return nil, err
	}
	if err := validatePrefixes("comment", opts.commentPrefixes, seen); err != nil {
		return nil, err
	}
	f.prefixes = slices.Concat(opts.checkPrefixes, opts.commentPrefixes)
	slices.SortStableFunc(f.prefixes, func(a, b string) int { return len(b) - len(a) })
	for _, c := range opts.commentPrefixes {
		f.comments[c] = true
	}

	// --implicit-check-not patterns precede every positive check.
	var implicit []*pattern
	for _, text := range opts.implicitCheckNot {
		p := newPattern(checkNot, "IMPLICIT-CHECK", ctx, opts.patternOptions(), -1, 0)
		if err := p.parse(text, false); err != nil {
			return nil, fmt.Errorf("invalid --implicit-check-not pattern '%s': %v", text, err)
		}
		implicit = append(implicit, p)
	}
	dagNot := slices.Clone(implicit)

	used := map[string]bool{}
	off := 0
	for {
		m, ok, err := f.findFirstMatchingPrefix(off)
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
		off = m.after
		if m.ty == checkComment {
			// Skip the rest of the line.
			for off < len(buf.data) && buf.data[off] != '\n' {
				off++
			}
			continue
		}
		used[m.prefix] = true

		// Pattern text runs to the end of the line, without leading blanks.
		if !(opts.strictWhitespace && opts.matchFullLines) {
			for off < len(buf.data) && (buf.data[off] == ' ' || buf.data[off] == '\t') {
				off++
			}
		}
		eol := off
		for eol < len(buf.data) && buf.data[eol] != '\n' {
			eol++
		}
		text := string(buf.data[off:eol])
		lineNo := buf.lineOf(m.loc)

		if (m.ty == checkNext || m.ty == checkSame || m.ty == checkEmpty) && len(f.strings) == 0 {
			return nil, &checkFileError{off: m.loc, msg: fmt.Sprintf("found '%s%s:' without previous '%s: line", m.prefix, m.ty.suffix(), m.prefix)}
		}

		p := newPattern(m.ty, m.prefix, ctx, opts.patternOptions(), off, lineNo)
		p.count = m.count
		if err := p.parse(text, m.literal); err != nil {
			var pe *parseError
			if errors.As(err, &pe) && pe.off >= 0 {
				return nil, &checkFileError{off: off + pe.off, msg: pe.msg}
			}
			return nil, &checkFileError{off: off, msg: err.Error()}
		}
		if m.ty == checkLabel && p.hasVariable {
			return nil, &checkFileError{off: m.loc, msg: "found '" + m.prefix + "-LABEL:' with variable definition or use"}
		}
		if m.ty.isDagOrNot() {
			dagNot = append(dagNot, p)
			off = eol
			continue
		}
		f.strings = append(f.strings, checkString{pat: p, dagNot: dagNot})
		dagNot = slices.Clone(implicit)
		off = eol
	}

	// Trailing CHECK-DAG/CHECK-NOT directives, and any implicit ones, are
	// checked against the rest of the input via an EOF pattern.
	if len(dagNot) > 0 {
		p := newPattern(checkEOF, opts.checkPrefixes[0], ctx, opts.patternOptions(), len(buf.data), buf.lineCount()+1)
		f.strings = append(f.strings, checkString{pat: p, dagNot: dagNot})
	}

	var notFound []string
	for _, p := range opts.checkPrefixes {
		if !used[p] {
			notFound = append(notFound, p)
		}
	}
	noneFound := len(notFound) == len(opts.checkPrefixes)
	someUnused := !opts.allowUnusedPrefix && len(notFound) > 0
	if (noneFound || someUnused) && !(opts.defaultPrefix && len(implicit) > 0) {
		quoted := make([]string, len(notFound))
		for i, p := range notFound {
			quoted[i] = "'" + p + ":'"
		}
		plural := ""
		if len(notFound) > 1 {
			plural = "es"
		}
		return nil, fmt.Errorf("no check strings found with prefix%s %s", plural, strings.Join(quoted, ", "))
	}
	return f, nil
}
