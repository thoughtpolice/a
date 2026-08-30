// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"fmt"
	"io"
	"sort"
	"strings"
)

// sourceBuffer is a named text buffer with a line index, playing the role of
// LLVM's SourceMgr for both the check file and the checked input.
type sourceBuffer struct {
	name string
	data []byte
	// lineStarts is built on first use: a passing check never needs it.
	lineStarts []int
}

func newSourceBuffer(name string, data []byte) *sourceBuffer {
	return &sourceBuffer{name: name, data: data}
}

// lines returns the offset at which every line starts.
func (b *sourceBuffer) lines() []int {
	if b.lineStarts == nil {
		starts := []int{0}
		for off := 0; ; {
			i := bytes.IndexByte(b.data[off:], '\n')
			if i < 0 {
				break
			}
			off += i + 1
			starts = append(starts, off)
		}
		b.lineStarts = starts
	}
	return b.lineStarts
}

// lineCount reports the number of lines, where a trailing newline does not
// start an additional empty line.
func (b *sourceBuffer) lineCount() int {
	starts := b.lines()
	n := len(starts)
	if n > 1 && starts[n-1] == len(b.data) {
		return n - 1
	}
	return n
}

// lineOf returns the 1-based line containing byte offset off.
func (b *sourceBuffer) lineOf(off int) int {
	if off < 0 {
		off = 0
	}
	if off > len(b.data) {
		off = len(b.data)
	}
	starts := b.lines()
	return sort.Search(len(starts), func(i int) bool { return starts[i] > off })
}

// lineCol returns the 1-based line and column of byte offset off.
func (b *sourceBuffer) lineCol(off int) (int, int) {
	line := b.lineOf(off)
	return line, off - b.lines()[line-1] + 1
}

// lineLen returns the length of a 1-based line without its terminator.
func (b *sourceBuffer) lineLen(line int) int {
	starts := b.lines()
	if line < 1 || line > len(starts) {
		return 0
	}
	end := len(b.data)
	if line < len(starts) {
		end = starts[line] - 1
	}
	return max(end-starts[line-1], 0)
}

// lineText returns the text of a 1-based line without its terminator.
func (b *sourceBuffer) lineText(line int) string {
	start := b.lineStart(line)
	return string(b.data[start : start+b.lineLen(line)])
}

func (b *sourceBuffer) lineStart(line int) int {
	starts := b.lines()
	if line < 1 {
		return 0
	}
	if line > len(starts) {
		return len(b.data)
	}
	return starts[line-1]
}

type diagKind int

const (
	diagError diagKind = iota
	diagWarning
	diagNote
	diagRemark
)

func (k diagKind) String() string {
	switch k {
	case diagError:
		return "error"
	case diagWarning:
		return "warning"
	case diagNote:
		return "note"
	default:
		return "remark"
	}
}

// diagPrinter formats SourceMgr-style diagnostics:
//
//	file:line:col: kind: message
//	<source line>
//	      ^~~~~
type diagPrinter struct {
	w     io.Writer
	color bool
}

func (p *diagPrinter) colorize(kind diagKind, s string) string {
	if !p.color {
		return s
	}
	code := "1;31"
	switch kind {
	case diagWarning:
		code = "1;35"
	case diagNote:
		code = "1;30"
	case diagRemark:
		code = "1;34"
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

// message prints a diagnostic anchored at buf[off:off+length]. A negative
// offset prints the message without a location.
func (p *diagPrinter) message(buf *sourceBuffer, off, length int, kind diagKind, msg string) {
	if buf == nil || off < 0 {
		fmt.Fprintf(p.w, "%s: %s\n", p.colorize(kind, kind.String()), msg)
		return
	}
	line, col := buf.lineCol(off)
	fmt.Fprintf(p.w, "%s:%d:%d: %s: %s\n", buf.name, line, col, p.colorize(kind, kind.String()), msg)
	text := buf.lineText(line)
	fmt.Fprintln(p.w, strings.ReplaceAll(text, "\t", " "))
	// The tilde range never extends past the anchored line.
	lineEnd := buf.lineStart(line) + len(text)
	tildes := max(0, min(off+length, lineEnd)-(off+1))
	fmt.Fprintln(p.w, p.colorize(diagRemark, strings.Repeat(" ", col-1)+"^"+strings.Repeat("~", tildes)))
}
