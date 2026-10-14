// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "strings"

// This follows git's wildmatch.c, which .gitattributes patterns go
// through, including its character classes and its treatment of "**".
// Case-folding is left out, as git uses it only when core.ignoreCase is
// set, which a fresh repository on a case-sensitive file system does not.

// wmPathname makes '*' and '?' stop at slashes, and gives "**" between
// slashes its meaning of any number of directories.
const wmPathname = 1

const (
	wmMatch           = 0
	wmNoMatch         = 1
	wmAbortAll        = -1
	wmAbortToStarStar = -2
)

func wildmatch(pattern, text string, flags int) bool {
	return dowild(pattern, text, flags) == wmMatch
}

// at reads like a C string: past the end there is a NUL. Neither paths
// nor attribute patterns contain one.
func at(s string, i int) byte {
	if i < len(s) {
		return s[i]
	}
	return 0
}

func isGlobSpecial(c byte) bool {
	return c == '*' || c == '?' || c == '[' || c == '\\'
}

func dowild(p, text string, flags int) int {
	pi, ti := 0, 0
	for ; pi < len(p); pi, ti = pi+1, ti+1 {
		pch := p[pi]
		tch := at(text, ti)
		if tch == 0 && pch != '*' {
			return wmAbortAll
		}
		switch pch {
		case '\\':
			// Literal match with the following character.
			pi++
			if tch != at(p, pi) {
				return wmNoMatch
			}
		default:
			if tch != pch {
				return wmNoMatch
			}
		case '?':
			if flags&wmPathname != 0 && tch == '/' {
				return wmNoMatch
			}
		case '*':
			var matchSlash bool
			pi++
			if at(p, pi) == '*' {
				prev := pi - 2
				for pi++; at(p, pi) == '*'; pi++ {
				}
				switch {
				case flags&wmPathname == 0:
					// Without wmPathname, "*" and "**" are the same.
					matchSlash = true
				case (prev < 0 || p[prev] == '/') &&
					(at(p, pi) == 0 || at(p, pi) == '/' || (at(p, pi) == '\\' && at(p, pi+1) == '/')):
					// Having matched "foo/" and standing at "**/",
					// first try matching nothing, so that "foo/**/bar"
					// matches "foo/bar" as well as "foo/a/bar".
					if at(p, pi) == '/' && dowild(p[pi+1:], text[ti:], flags) == wmMatch {
						return wmMatch
					}
					matchSlash = true
				default:
					matchSlash = false
				}
			} else {
				matchSlash = flags&wmPathname == 0
			}
			if pi >= len(p) {
				// A trailing "**" matches everything, and a trailing "*"
				// anything without a slash.
				if !matchSlash && strings.IndexByte(text[ti:], '/') >= 0 {
					return wmNoMatch
				}
				return wmMatch
			} else if !matchSlash && p[pi] == '/' {
				// A single "*" followed by a slash matches the rest of
				// one directory name; the loop consumes the slashes.
				slash := strings.IndexByte(text[ti:], '/')
				if slash < 0 {
					return wmNoMatch
				}
				ti += slash
				break
			}
			for tch != 0 {
				// When a literal follows the star, skip ahead to where
				// it occurs, not looking past a slash unless the star
				// may match one.
				if !isGlobSpecial(p[pi]) {
					pch = p[pi]
					for tch = at(text, ti); tch != 0 && (matchSlash || tch != '/'); tch = at(text, ti) {
						if tch == pch {
							break
						}
						ti++
					}
					if tch != pch {
						if matchSlash {
							return wmAbortAll
						}
						return wmAbortToStarStar
					}
				}
				if matched := dowild(p[pi:], text[ti:], flags); matched != wmNoMatch {
					if !matchSlash || matched != wmAbortToStarStar {
						return matched
					}
				} else if !matchSlash && tch == '/' {
					return wmAbortToStarStar
				}
				ti++
				tch = at(text, ti)
			}
			return wmAbortAll
		case '[':
			pi++
			pch = at(p, pi)
			if pch == '^' {
				pch = '!'
			}
			negated := pch == '!'
			if negated {
				pi++
				pch = at(p, pi)
			}
			var prevCh byte
			matched := false
			for {
				if pch == 0 {
					return wmAbortAll
				}
				switch {
				case pch == '\\':
					pi++
					pch = at(p, pi)
					if pch == 0 {
						return wmAbortAll
					}
					if tch == pch {
						matched = true
					}
				case pch == '-' && prevCh != 0 && at(p, pi+1) != 0 && at(p, pi+1) != ']':
					pi++
					pch = at(p, pi)
					if pch == '\\' {
						pi++
						pch = at(p, pi)
						if pch == 0 {
							return wmAbortAll
						}
					}
					if tch <= pch && tch >= prevCh {
						matched = true
					}
					pch = 0 // so that prevCh becomes 0
				case pch == '[' && at(p, pi+1) == ':':
					pi += 2
					s := pi
					for pch = at(p, pi); pch != 0 && pch != ']'; pch = at(p, pi) {
						pi++
					}
					if pch == 0 {
						return wmAbortAll
					}
					if pi-s-1 < 0 || p[pi-1] != ':' {
						// No ":]", so the '[' is an ordinary member.
						pi = s - 2
						pch = '['
						if tch == pch {
							matched = true
						}
						break
					}
					class, ok := charClass(p[s:pi-1], tch)
					if !ok {
						return wmAbortAll
					}
					if class {
						matched = true
					}
					pch = 0
				default:
					if tch == pch {
						matched = true
					}
				}
				prevCh = pch
				pi++
				pch = at(p, pi)
				if pch == ']' {
					break
				}
			}
			if matched == negated || (flags&wmPathname != 0 && tch == '/') {
				return wmNoMatch
			}
		}
	}
	if ti < len(text) {
		return wmNoMatch
	}
	return wmMatch
}

// charClass reports whether c is in the named class, with git's own
// ctype: ASCII only, and "space" without vertical tab and form feed.
func charClass(name string, c byte) (bool, bool) {
	alpha := 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
	digit := '0' <= c && c <= '9'
	switch name {
	case "alnum":
		return alpha || digit, true
	case "alpha":
		return alpha, true
	case "blank":
		return c == ' ' || c == '\t', true
	case "cntrl":
		return c < 0x20 || c == 0x7f, true
	case "digit":
		return digit, true
	case "graph":
		return 0x21 <= c && c <= 0x7e, true
	case "lower":
		return 'a' <= c && c <= 'z', true
	case "print":
		return 0x20 <= c && c <= 0x7e, true
	case "punct":
		return 0x21 <= c && c <= 0x7e && !alpha && !digit, true
	case "space":
		return c == ' ' || c == '\t' || c == '\n' || c == '\r', true
	case "upper":
		return 'A' <= c && c <= 'Z', true
	case "xdigit":
		return digit || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F', true
	}
	return false, false
}
