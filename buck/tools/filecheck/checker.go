// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"slices"
)

// Ported from LLVM's FileCheckString::Check, CheckDag, CheckNot, CheckNext,
// CheckSame and FileCheck::checkInput, so directive interplay (CHECK-NOT
// between CHECK-DAGs, CHECK-LABEL partitioning, CHECK-COUNT) behaves as it
// does upstream.

type matchKind int

const (
	matchFoundExpected matchKind = iota
	matchFoundExcluded
	matchFoundWrongLine
	matchFoundDiscarded
	matchNoneExpected
	matchNoneExcluded
	matchNoneInvalidPattern
	matchFuzzy
)

func (k matchKind) isError() bool {
	switch k {
	case matchFoundExcluded, matchFoundWrongLine, matchNoneExpected, matchNoneInvalidPattern:
		return true
	}
	return false
}

// inputDiag is one annotation on the checked input, feeding --dump-input.
type inputDiag struct {
	ty        checkType
	checkLine int
	kind      matchKind
	start     int
	end       int
	note      string
}

type checker struct {
	cf      *checkFile
	input   *sourceBuffer
	verbose int
	out     *diagPrinter
	diags   []inputDiag
}

func (c *checker) addDiag(pat *pattern, kind matchKind, start, end int, note string) {
	c.diags = append(c.diags, inputDiag{ty: pat.ty, checkLine: pat.lineNo, kind: kind, start: start, end: end, note: note})
}

// description names a directive for diagnostics: "CHECK-NOT", "CHECK-COUNT",
// "implicit EOF".
func (p *pattern) description() string {
	switch {
	case p.ty == checkEOF:
		return "implicit EOF"
	case p.ty == checkPlain && p.count > 1:
		return p.prefix + "-COUNT"
	}
	return p.prefix + p.ty.suffix()
}

// matchMessage words the outcome of searching for pat, e.g. "CHECK-NOT:
// excluded string found in input (2 out of 3)".
func matchMessage(pat *pattern, expected, found bool, matchedCount int) string {
	msg := pat.description() + ": "
	if expected {
		msg += "expected"
	} else {
		msg += "excluded"
	}
	if found {
		msg += " string found in input"
	} else {
		msg += " string not found in input"
	}
	if pat.count > 1 {
		msg += fmt.Sprintf(" (%d out of %d)", matchedCount, pat.count)
	}
	return msg
}

func (c *checker) printMatch(expected bool, pat *pattern, matchedCount int, bufOff int, res *matchResult) {
	start := bufOff + res.pos
	end := start + res.length
	kind := matchFoundExpected
	if !expected {
		kind = matchFoundExcluded
	}
	c.addDiag(pat, kind, start, end, "")
	printDiag := c.verbose >= 1
	if !expected {
		printDiag = true
	}
	if pat.ty == checkEOF && expected {
		printDiag = false
	}
	if printDiag {
		dk := diagRemark
		if !expected {
			dk = diagError
		}
		c.out.message(c.cf.buf, pat.loc, 0, dk, matchMessage(pat, expected, true, matchedCount))
		c.out.message(c.input, start, res.length, diagNote, "found here")
	}
	c.printSubstitutions(pat, res.subs, start, printDiag, kind)
}

func (c *checker) printSubstitutions(pat *pattern, subs []substitutionValue, at int, printDiag bool, kind matchKind) {
	for _, s := range subs {
		msg := fmt.Sprintf("with %q equal to %q", s.src, s.value)
		c.addDiag(pat, kind, at, at, msg)
		if printDiag {
			c.out.message(c.input, at, 0, diagNote, msg)
		}
	}
}

func (c *checker) printNoMatch(expected bool, pat *pattern, matchedCount int, buf []byte, bufOff int, err error) {
	kind := matchNoneExpected
	if !expected {
		kind = matchNoneExcluded
	}
	printDiag := expected || c.verbose >= 2
	var subs []substitutionValue
	var me *matchError
	if err != nil {
		me, _ = err.(*matchError)
	}
	if me != nil {
		kind = matchNoneInvalidPattern
		if printDiag {
			// Report each failing substitution at its check-file location.
			for _, sub := range me.subs {
				loc := -1
				if pat.loc >= 0 {
					loc = pat.loc + sub.off
				}
				c.out.message(c.cf.buf, loc, len(sub.src), diagError, sub.err.Error())
			}
			if len(me.subs) == 0 {
				c.out.message(c.cf.buf, pat.loc, 0, diagError, me.msg)
			}
		}
	} else if printDiag {
		dk := diagError
		if !expected {
			dk = diagRemark
		}
		c.out.message(c.cf.buf, pat.loc, 0, dk, matchMessage(pat, expected, false, matchedCount))
	}
	c.addDiag(pat, kind, bufOff, bufOff+len(buf), "")
	if printDiag {
		c.out.message(c.input, bufOff, 0, diagNote, "scanning from here")
	}
	// Substitution values as of this search help explain the failure.
	if me == nil {
		_, subs, _ = pat.resolve()
	}
	c.printSubstitutions(pat, subs, bufOff, printDiag, kind)
	if expected {
		if off := pat.fuzzyMatchLine(buf); off >= 0 {
			c.addDiag(pat, matchFuzzy, bufOff+off, bufOff+off, "")
			if printDiag {
				c.out.message(c.input, bufOff+off, 0, diagNote, "possible intended match here")
			}
		}
	}
}

// checkNot fails if any of the CHECK-NOT patterns matches buf.
func (c *checker) checkNot(buf []byte, bufOff int, nots []*pattern) bool {
	for _, pat := range nots {
		res, err := pat.match(buf)
		if err != nil {
			// A CHECK-NOT with an undefined variable cannot match anything;
			// LLVM treats this as an error against the pattern.
			c.printNoMatch(false, pat, 0, buf, bufOff, err)
			return true
		}
		if res == nil {
			c.printNoMatch(false, pat, 0, buf, bufOff, nil)
			continue
		}
		c.printMatch(false, pat, 1, bufOff, res)
		return true
	}
	return false
}

// countNewlinesBetween counts line terminators in buf and returns the offset
// just past the first one.
func countNewlinesBetween(buf []byte) (count int, firstNewline int) {
	firstNewline = -1
	for i := 0; i < len(buf); i++ {
		if buf[i] != '\n' && buf[i] != '\r' {
			continue
		}
		count++
		if i+1 < len(buf) && (buf[i+1] == '\n' || buf[i+1] == '\r') && buf[i+1] != buf[i] {
			i++
		}
		if count == 1 {
			firstNewline = i + 1
		}
	}
	return count, firstNewline
}

// noteMatchBounds points at this match and the end of the previous one
// after an adjacency error over the region skipped between them.
func (c *checker) noteMatchBounds(skipped []byte, skippedOff int) {
	c.out.message(c.input, skippedOff+len(skipped), 0, diagNote, "'next' match was here")
	c.out.message(c.input, skippedOff, 0, diagNote, "previous match ended here")
}

// checkNext enforces CHECK-NEXT/CHECK-EMPTY adjacency over the region between
// the previous match and this one.
func (c *checker) checkNext(pat *pattern, skipped []byte, skippedOff int) bool {
	if pat.ty != checkNext && pat.ty != checkEmpty {
		return false
	}
	n, first := countNewlinesBetween(skipped)
	if n == 0 {
		c.out.message(c.cf.buf, pat.loc, 0, diagError, pat.checkName()+": is on the same line as previous match")
		c.noteMatchBounds(skipped, skippedOff)
		return true
	}
	if n != 1 {
		c.out.message(c.cf.buf, pat.loc, 0, diagError, pat.checkName()+": is not on the line after the previous match")
		c.noteMatchBounds(skipped, skippedOff)
		c.out.message(c.input, skippedOff+first, 0, diagNote, "non-matching line after previous match is here")
		return true
	}
	return false
}

func (c *checker) checkSame(pat *pattern, skipped []byte, skippedOff int) bool {
	if pat.ty != checkSame {
		return false
	}
	n, _ := countNewlinesBetween(skipped)
	if n != 0 {
		c.out.message(c.cf.buf, pat.loc, 0, diagError, pat.checkName()+": is not on the same line as the previous match")
		c.noteMatchBounds(skipped, skippedOff)
		return true
	}
	return false
}

// markWrongLine downgrades the annotation of the last expected match to a
// wrong-line error, after checkNext/checkSame reject it.
func (c *checker) markWrongLine() {
	for i := len(c.diags) - 1; i >= 0; i-- {
		if c.diags[i].kind == matchFoundExpected {
			c.diags[i].kind = matchFoundWrongLine
			return
		}
	}
}

type matchRange struct{ pos, end int }

// checkDag matches the CHECK-DAG and CHECK-NOT directives preceding a check
// string. It returns the offset after which the positive check must match,
// and leaves in nots any CHECK-NOTs that follow the last CHECK-DAG.
func (c *checker) checkDag(cs *checkString, buf []byte, bufOff int, nots *[]*pattern) (int, bool) {
	if len(cs.dagNot) == 0 {
		return 0, true
	}
	startPos := 0
	var ranges []matchRange
	for idx, pat := range cs.dagNot {
		if pat.ty == checkNot {
			*nots = append(*nots, pat)
			continue
		}
		matchPos := startPos
		var res *matchResult
		mi := 0
		for {
			var err error
			res, err = pat.match(buf[matchPos:])
			if err != nil || res == nil {
				c.printNoMatch(true, pat, 0, buf[matchPos:], bufOff+matchPos, err)
				return 0, false
			}
			matchPos += res.pos
			m := matchRange{pos: matchPos, end: matchPos + res.length}
			if c.cf.opts.allowDeprecatedDag {
				if len(ranges) == 0 {
					ranges = append(ranges, m)
				} else {
					ranges[0].pos = min(ranges[0].pos, m.pos)
					ranges[0].end = max(ranges[0].end, m.end)
				}
				break
			}
			overlap := false
			for ; mi < len(ranges); mi++ {
				if m.pos < ranges[mi].end {
					overlap = ranges[mi].pos < m.end
					break
				}
			}
			if !overlap {
				ranges = slices.Insert(ranges, mi, m)
				break
			}
			c.addDiag(pat, matchFoundDiscarded, bufOff+m.pos, bufOff+m.end, "")
			if c.verbose >= 2 {
				c.out.message(c.input, bufOff+m.pos, res.length, diagNote, "match discarded, overlaps earlier DAG match here")
			}
			matchPos = ranges[mi].end
		}
		c.printMatch(true, pat, 1, bufOff+matchPos-res.pos, res)

		// End of a CHECK-DAG group: verify pending CHECK-NOTs against the
		// region skipped before the group's first match.
		last := idx+1 == len(cs.dagNot) || cs.dagNot[idx+1].ty == checkNot
		if last {
			if len(*nots) > 0 {
				skipped := buf[startPos:ranges[0].pos]
				if c.checkNot(skipped, bufOff+startPos, *nots) {
					return 0, false
				}
				*nots = (*nots)[:0]
			}
			startPos = ranges[len(ranges)-1].end
			ranges = ranges[:0]
		}
	}
	return startPos, true
}

// check matches one check string against region. It returns the match
// position and length relative to region.
func (c *checker) check(cs *checkString, region []byte, regionOff int, labelScan bool) (int, int, bool) {
	lastPos := 0
	var nots []*pattern
	if !labelScan {
		var ok bool
		lastPos, ok = c.checkDag(cs, region, regionOff, &nots)
		if !ok {
			return 0, 0, false
		}
	}

	lastMatchEnd := lastPos
	firstMatchPos := 0
	for i := 1; i <= cs.pat.count; i++ {
		mbuf := region[lastMatchEnd:]
		res, err := cs.pat.match(mbuf)
		if err != nil || res == nil {
			c.printNoMatch(true, cs.pat, i-1, mbuf, regionOff+lastMatchEnd, err)
			return 0, 0, false
		}
		c.printMatch(true, cs.pat, i, regionOff+lastMatchEnd, res)
		if i == 1 {
			firstMatchPos = lastMatchEnd + res.pos
		}
		lastMatchEnd += res.pos + res.length
	}
	matchLen := lastMatchEnd - firstMatchPos

	if !labelScan {
		skipped := region[lastPos:firstMatchPos]
		if c.checkNext(cs.pat, skipped, regionOff+lastPos) || c.checkSame(cs.pat, skipped, regionOff+lastPos) {
			c.markWrongLine()
			return 0, 0, false
		}
		if c.checkNot(skipped, regionOff+lastPos, nots) {
			return 0, 0, false
		}
	}
	return firstMatchPos, matchLen, true
}

// checkInput runs every check string over the input, partitioned by
// CHECK-LABEL. It reports whether all checks passed.
func (c *checker) checkInput() bool {
	buffer := c.input.data
	bufferOff := 0
	failed := false
	strs := c.cf.strings
	i, j, e := 0, 0, len(strs)
	for {
		var region []byte
		regionOff := bufferOff
		if j == e {
			region = buffer
		} else {
			label := &strs[j]
			if label.pat.ty != checkLabel {
				j++
				continue
			}
			pos, n, ok := c.check(label, buffer, bufferOff, true)
			if !ok {
				return false
			}
			region = buffer[:pos+n]
			buffer = buffer[pos+n:]
			bufferOff += pos + n
			j++
		}
		if i != 0 && c.cf.opts.enableVarScope {
			c.cf.ctx.clearLocalVars()
		}
		for ; i != j; i++ {
			pos, n, ok := c.check(&strs[i], region, regionOff, false)
			if !ok {
				failed = true
				i = j
				break
			}
			region = region[pos+n:]
			regionOff += pos + n
		}
		if j == e {
			break
		}
	}
	return !failed
}
