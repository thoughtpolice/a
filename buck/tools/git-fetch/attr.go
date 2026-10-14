// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"strings"
)

// This reads .gitattributes files the way git's attr.c does when checking
// out: from the tree being checked out, with no attributes from the user's
// or the system's configuration, and no $GIT_DIR/info/attributes.

type attrState uint8

const (
	attrUnknown     attrState = iota // no rule says anything
	attrSet                          // "name"
	attrUnset                        // "-name"
	attrUnspecified                  // "!name", which hides lower rules
	attrValue                        // "name=value"
)

type attrAssign struct {
	name  string
	state attrState
	value string
}

type attrRule struct {
	pattern   string // without any trailing slash
	noDir     bool   // the pattern has no slash, so it matches basenames
	mustBeDir bool   // the pattern had a trailing slash
	assigns   []attrAssign
}

type attributes struct {
	macros map[string][]attrAssign
	files  map[string][]attrRule // by the directory holding the file
}

const (
	attrBlank         = " \t\r\n"
	maxAttrLineLength = 2048
	maxAttrFileSize   = 100 << 20
	attrMacroPrefix   = "[attr]"
)

func newAttributes() *attributes {
	return &attributes{
		macros: map[string][]attrAssign{
			"binary": {{name: "diff", state: attrUnset}, {name: "merge", state: attrUnset}, {name: "text", state: attrUnset}},
		},
		files: map[string][]attrRule{},
	}
}

// addFile reads the .gitattributes file in dir ("" at the top). Only the
// top-level file may define macros.
func (a *attributes) addFile(dir string, data []byte) {
	if len(data) >= maxAttrFileSize {
		return
	}
	// git reads the file as a C string, so it ends at the first NUL.
	if i := bytes.IndexByte(data, 0); i >= 0 {
		data = data[:i]
	}
	// A byte-order mark stays part of the first line, as in git.
	var rules []attrRule
	for len(data) > 0 {
		line, rest, _ := bytes.Cut(data, []byte("\n"))
		data = rest
		rule, macro, ok := parseAttrLine(string(line))
		switch {
		case !ok:
		case macro != "":
			if dir == "" {
				a.macros[macro] = rule.assigns
			}
		default:
			rules = append(rules, rule)
		}
	}
	a.files[dir] = rules
}

// parseAttrLine parses one line, which is either a pattern and the
// attributes it assigns or, with a name after "[attr]", a macro. ok is
// false for comments, blank lines, and lines git ignores as invalid.
func parseAttrLine(line string) (rule attrRule, macro string, ok bool) {
	if len(line) >= maxAttrLineLength {
		return rule, "", false
	}
	cp := strings.TrimLeft(line, attrBlank)
	if cp == "" || cp[0] == '#' {
		return rule, "", false
	}
	var name, states string
	if unquoted, rest, ok := unquoteC(cp); ok {
		name, states = unquoted, rest
	} else {
		name, states = cutBlank(cp)
	}
	if len(name) > len(attrMacroPrefix) && strings.HasPrefix(name, attrMacroPrefix) {
		macro, _ = cutBlank(strings.TrimLeft(name[len(attrMacroPrefix):], attrBlank))
		if !validAttrName(macro) {
			return rule, "", false
		}
	}
	for states = strings.TrimLeft(states, attrBlank); states != ""; {
		var token string
		token, states = cutBlank(states)
		states = strings.TrimLeft(states, attrBlank)
		assign := attrAssign{state: attrSet}
		key, value, hasValue := strings.Cut(token, "=")
		switch {
		case strings.HasPrefix(key, "-"):
			assign.state, key = attrUnset, key[1:]
		case strings.HasPrefix(key, "!"):
			assign.state, key = attrUnspecified, key[1:]
		case hasValue:
			assign.state, assign.value = attrValue, value
		}
		if !validAttrName(key) {
			return rule, "", false
		}
		assign.name = key
		rule.assigns = append(rule.assigns, assign)
	}
	if macro != "" {
		return rule, macro, true
	}
	// git warns that negative patterns mean nothing in attributes, and
	// ignores the line.
	if strings.HasPrefix(name, "!") {
		return rule, "", false
	}
	if trimmed, ok := strings.CutSuffix(name, "/"); ok {
		name, rule.mustBeDir = trimmed, true
	}
	rule.pattern = name
	rule.noDir = !strings.Contains(name, "/")
	return rule, "", true
}

func cutBlank(s string) (string, string) {
	if i := strings.IndexAny(s, attrBlank); i >= 0 {
		return s[:i], s[i:]
	}
	return s, ""
}

func validAttrName(name string) bool {
	if name == "" || name[0] == '-' {
		return false
	}
	for i := range len(name) {
		c := name[i]
		if !(c == '-' || c == '.' || c == '_' || '0' <= c && c <= '9' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z') {
			return false
		}
	}
	return true
}

// unquoteC undoes git's C-style quoting of a path: s starts with a double
// quote, and rest is what follows the closing one.
func unquoteC(s string) (unquoted, rest string, ok bool) {
	if !strings.HasPrefix(s, `"`) {
		return "", "", false
	}
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			return b.String(), s[i+1:], true
		case '\\':
		default:
			b.WriteByte(c)
			continue
		}
		i++
		switch c = at(s, i); c {
		case 'a':
			c = '\a'
		case 'b':
			c = '\b'
		case 'f':
			c = '\f'
		case 'n':
			c = '\n'
		case 'r':
			c = '\r'
		case 't':
			c = '\t'
		case 'v':
			c = '\v'
		case '\\', '"':
		case '0', '1', '2', '3':
			// Three octal digits; a first digit above 3 would overflow.
			v := c - '0'
			for range 2 {
				i++
				d := at(s, i)
				if d < '0' || d > '7' {
					return "", "", false
				}
				v = v<<3 | (d - '0')
			}
			c = v
		default:
			return "", "", false
		}
		b.WriteByte(c)
	}
	return "", "", false
}

// lookup returns every attribute a file has. Rules in deeper directories
// win over shallower ones, and later lines over earlier ones; the first
// rule to say anything about an attribute decides it.
func (a *attributes) lookup(path string) map[string]attrAssign {
	values := map[string]attrAssign{}
	dir := path
	for {
		i := strings.LastIndexByte(dir, '/')
		dir = dir[:max(i, 0)]
		rules := a.files[dir]
		for j := len(rules) - 1; j >= 0; j-- {
			if rules[j].matches(path, dir) {
				a.fill(values, rules[j].assigns)
			}
		}
		if dir == "" {
			return values
		}
	}
}

// fill records a rule's assignments that nothing more important already
// decided, last first, expanding macros where they are set.
func (a *attributes) fill(values map[string]attrAssign, assigns []attrAssign) {
	for i := len(assigns) - 1; i >= 0; i-- {
		as := assigns[i]
		if _, decided := values[as.name]; decided {
			continue
		}
		values[as.name] = as
		if macro, ok := a.macros[as.name]; ok && as.state == attrSet {
			a.fill(values, macro)
		}
	}
}

func (r *attrRule) matches(path, dir string) bool {
	// Attributes are only looked up for files, which a directory-only
	// pattern never matches.
	if r.mustBeDir {
		return false
	}
	if r.noDir {
		return wildmatch(r.pattern, path[strings.LastIndexByte(path, '/')+1:], 0)
	}
	rel := path
	if dir != "" {
		rel = path[len(dir)+1:]
	}
	return wildmatch(strings.TrimPrefix(r.pattern, "/"), rel, wmPathname)
}
