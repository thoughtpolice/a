// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"fmt"
	"strings"
)

// This converts a blob into the bytes git checks out for it, following
// git's convert.c with no configuration: core.autocrlf and core.eol unset,
// no filter drivers, on a system whose native line ending is LF. Filter
// attributes therefore do nothing, as in git without the drivers
// installed. The working-tree-encoding attribute needs iconv, which this
// does not have, so a file that asks for an encoding other than UTF-8 is
// an error rather than a silent difference from git.

type crlfAction int

const (
	crlfUndefined crlfAction = iota
	crlfBinary
	crlfText
	crlfTextInput
	crlfTextCRLF
	crlfAuto
	crlfAutoInput
	crlfAutoCRLF
)

func convertToWorktree(path string, attrs map[string]attrAssign, blob oid, format *objectFormat, data []byte) ([]byte, error) {
	action := checkoutCRLFAction(attrs)
	if attrs["ident"].state == attrSet {
		// git checks a file out through its streaming filters unless
		// text=auto needs to see the whole file first, and the streaming
		// ident filter differs from the in-memory one.
		if action == crlfAutoInput || action == crlfAutoCRLF {
			data = identToWorktree(data, format.hex(blob))
		} else {
			data = identToWorktreeStreaming(data, format.hex(blob))
		}
	}
	data = crlfToWorktree(data, action)
	if enc := attrs["working-tree-encoding"]; enc.state == attrSet || enc.state == attrUnset {
		return nil, fmt.Errorf("%s: true/false are no valid working-tree-encodings", path)
	} else if enc.state == attrValue && enc.value != "" && !isUTF8(enc.value) {
		return nil, fmt.Errorf("%s: working-tree-encoding=%s is not supported", path, enc.value)
	}
	return data, nil
}

func isUTF8(name string) bool {
	return strings.EqualFold(name, "utf-8") || strings.EqualFold(name, "utf8")
}

func attrCRLF(a attrAssign) crlfAction {
	switch {
	case a.state == attrSet:
		return crlfText
	case a.state == attrUnset:
		return crlfBinary
	case a.state == attrValue && a.value == "input":
		return crlfTextInput
	case a.state == attrValue && a.value == "auto":
		return crlfAuto
	}
	return crlfUndefined
}

// checkoutCRLFAction decides from the text, crlf and eol attributes what
// happens to line endings, as git's convert_attrs does.
func checkoutCRLFAction(attrs map[string]attrAssign) crlfAction {
	action := attrCRLF(attrs["text"])
	if action == crlfUndefined {
		action = attrCRLF(attrs["crlf"])
	}
	if action != crlfBinary {
		eol := attrs["eol"]
		lf := eol.state == attrValue && eol.value == "lf"
		crlf := eol.state == attrValue && eol.value == "crlf"
		switch {
		case action == crlfAuto && lf:
			action = crlfAutoInput
		case action == crlfAuto && crlf:
			action = crlfAutoCRLF
		case lf:
			action = crlfTextInput
		case crlf:
			action = crlfTextCRLF
		}
	}
	// With core.autocrlf false and a native LF ending, text means LF.
	switch action {
	case crlfText:
		action = crlfTextInput
	case crlfUndefined:
		action = crlfBinary
	case crlfAuto:
		action = crlfAutoInput
	}
	return action
}

type textStats struct {
	nul, loneCR, loneLF, crlf, printable, nonPrintable int
}

func gatherStats(data []byte) textStats {
	var s textStats
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case c == '\r':
			if i+1 < len(data) && data[i+1] == '\n' {
				s.crlf++
				i++
			} else {
				s.loneCR++
			}
		case c == '\n':
			s.loneLF++
		case c == 0x7f:
			s.nonPrintable++
		case c < 0x20:
			switch c {
			case '\b', '\t', 0x1b, '\f':
				s.printable++
			case 0:
				s.nul++
				s.nonPrintable++
			default:
				s.nonPrintable++
			}
		default:
			s.printable++
		}
	}
	// A trailing ^Z, the DOS end-of-file mark, is not held against it.
	if len(data) > 0 && data[len(data)-1] == 0x1a {
		s.nonPrintable--
	}
	return s
}

func (s textStats) isBinary() bool {
	return s.loneCR > 0 || s.nul > 0 || s.printable>>7 < s.nonPrintable
}

// crlfToWorktree turns LF into CRLF where the action calls for it. For
// text=auto, git leaves alone anything that looks binary or already has
// a CR in it.
func crlfToWorktree(data []byte, action crlfAction) []byte {
	if len(data) == 0 || (action != crlfTextCRLF && action != crlfAutoCRLF) {
		return data
	}
	s := gatherStats(data)
	if s.loneLF == 0 {
		return data
	}
	if action == crlfAutoCRLF && (s.loneCR > 0 || s.crlf > 0 || s.isBinary()) {
		return data
	}
	out := make([]byte, 0, len(data)+s.loneLF)
	for {
		nl := bytes.IndexByte(data, '\n')
		if nl < 0 {
			break
		}
		if nl > 0 && data[nl-1] == '\r' {
			out = append(out, data[:nl+1]...)
		} else {
			out = append(out, data[:nl]...)
			out = append(out, '\r', '\n')
		}
		data = data[nl+1:]
	}
	return append(out, data...)
}

// identToWorktree expands "$Id$", and refreshes any "$Id: ... $", to
// "$Id: <blob id> $", as git's in-memory ident_to_worktree does.
func identToWorktree(data []byte, id string) []byte {
	if countIdent(data) == 0 {
		return data
	}
	var out bytes.Buffer
	src := data
	for {
		dollar := bytes.IndexByte(src, '$')
		if dollar < 0 {
			break
		}
		out.Write(src[:dollar+1])
		src = src[dollar+1:]
		if len(src) < 3 || !bytes.HasPrefix(src, []byte("Id")) {
			continue
		}
		switch src[2] {
		case '$':
			src = src[3:]
		case ':':
			end := bytes.IndexByte(src[3:], '$')
			if end < 0 {
				// An unterminated keyword ends the expansion.
				out.Write(src)
				return out.Bytes()
			}
			end += 3
			if bytes.IndexByte(src[3:end], '\n') >= 0 {
				continue
			}
			// Spaces anywhere but just before the closing '$' mean an
			// id from some other version control system; keep it.
			if end > 4 {
				if sp := bytes.IndexByte(src[4:end], ' '); sp >= 0 && 4+sp < end-1 {
					continue
				}
			}
			src = src[end+1:]
		default:
			continue
		}
		out.WriteString("Id: " + id + " $")
	}
	out.Write(src)
	return out.Bytes()
}

func countIdent(data []byte) int {
	n := 0
	for i := 0; i < len(data); {
		c := data[i]
		i++
		if c != '$' {
			continue
		}
		if len(data)-i < 3 {
			break
		}
		if data[i] != 'I' || data[i+1] != 'd' {
			continue
		}
		c = data[i+2]
		i += 3
		if c == '$' {
			n++
		}
		if c != ':' {
			continue
		}
		for i < len(data) {
			c = data[i]
			i++
			if c == '$' {
				n++
				break
			}
			if c == '\n' {
				break
			}
		}
	}
	return n
}

// identToWorktreeStreaming expands ids as git's streaming ident filter
// does, which git uses for every file not marked text=auto. Unlike the in-memory conversion, a character that breaks off a
// partial "$Id" is not looked at again, so "$$Id$" stays as it is; any
// whitespace not just before the closing '$' marks a foreign id; and
// pending text before an id is lost when that id is refreshed, as in
// "$Idx$Id:$". The match includes the NUL that ends git's "$Id" string.
func identToWorktreeStreaming(data []byte, id string) []byte {
	const (
		head     = "$Id\x00"
		skipping = -1
	)
	ident := ": " + id + " $"
	out := make([]byte, 0, len(data))
	var left []byte // held back until it is known whether it is an id
	state := 0      // how much of head has matched, or skipping
	drain := func() {
		out = append(out, left...)
		left = left[:0]
		state = 0
	}
	for _, c := range data {
		if state == skipping {
			// Inside "$Id:", up to a '$' or the end of the line.
			left = append(left, c)
			if c != '\n' && c != '$' {
				continue
			}
			if c == '$' && !isForeignIdent(left) {
				left = append(left[:3], ident...)
			}
			drain()
			continue
		}
		if state < len(head) && head[state] == c {
			state++
			continue
		}
		left = append(left, head[:state]...)
		if state == 3 {
			switch c {
			case ':':
				left = append(left, c)
				state = skipping
			case '$':
				left = append(left, ident...)
				drain()
			default:
				left = append(left, c)
				state = 0
			}
			continue
		}
		left = append(left, c)
		drain()
	}
	if state > 0 {
		left = append(left, head[:state]...)
	}
	drain()
	return out
}

// isForeignIdent reports whether a "$Id: ... $" holds whitespace other
// than just before its closing '$', in which case some other version
// control system wrote it.
func isForeignIdent(s []byte) bool {
	if i := bytes.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	rest, ok := bytes.CutPrefix(s, []byte("$Id: "))
	if !ok {
		return false
	}
	for i, c := range rest {
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') && (i+1 == len(rest) || rest[i+1] != '$') {
			return true
		}
	}
	return false
}
