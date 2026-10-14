// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// A script is a sequence of steps. Each step starts with a request line,
// `METHOD TARGET`, followed by request directives; then `expect STATUS`,
// followed by checks and captures. Lines are trimmed, so indentation is only
// for readers, and lines starting with '#' are comments. Values run to the end
// of their line and may contain {name} variable references.
type script struct {
	path  string
	steps []*step
}

type step struct {
	line   int
	method string
	target string

	headers []field
	query   []field
	body    *payload
	sign    *signing

	expectLine int
	status     int
	captures   []capture
	checks     []check
}

type field struct {
	line        int
	name, value string
}

// A payload is a request body or an expected response body.
type payload struct {
	line  int
	kind  string // "body", "body-file", or "body-hex"
	value string
}

// signing overrides the access_key_id, secret_access_key, and region
// variables for one signed request.
type signing struct {
	line      int
	overrides map[string]string
}

type capture struct {
	line    int
	name    string
	subject string // "header" or "xml"
	arg     string
}

type check struct {
	line    int
	source  string // the trimmed script line, for diagnostics
	subject string // "header", "xml", "body", "body-file", "body-hex", "body-size", or "body-sha256"
	arg     string // header name or element path
	op      string // "=", "!=", "count", "present", "absent", or "nonempty"
	value   string
}

var signingVars = map[string]bool{"access_key_id": true, "secret_access_key": true, "region": true}

type parseError struct {
	path string
	line int
	msg  string
}

func (e *parseError) Error() string { return fmt.Sprintf("%s:%d: %s", e.path, e.line, e.msg) }

func parseScript(path, text string) (*script, error) {
	s := &script{path: path}
	var cur *step
	fail := func(line int, format string, args ...any) error {
		return &parseError{path, line, fmt.Sprintf(format, args...)}
	}
	for i, raw := range strings.Split(text, "\n") {
		n := i + 1
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		word, rest := cutWord(line)
		var err error
		switch {
		case isMethod(word):
			if cur != nil && cur.expectLine == 0 {
				return nil, fail(cur.line, "request has no 'expect STATUS' line")
			}
			target, extra := cutWord(rest)
			if target == "" || extra != "" {
				return nil, fail(n, "want 'METHOD TARGET', got %q", line)
			}
			cur = &step{line: n, method: word, target: target}
			s.steps = append(s.steps, cur)
		case cur == nil:
			return nil, fail(n, "expected a request line such as 'GET /path', got %q", line)
		case word == "expect":
			if cur.expectLine != 0 {
				return nil, fail(n, "request on line %d already has an expect line", cur.line)
			}
			status, err := strconv.Atoi(rest)
			if err != nil || status < 100 || status > 599 {
				return nil, fail(n, "want 'expect STATUS' with a status from 100 to 599, got %q", line)
			}
			cur.expectLine, cur.status = n, status
		case cur.expectLine == 0:
			err = parseRequestLine(cur, n, word, rest)
		default:
			err = parseExpectLine(cur, n, line, word, rest)
		}
		if err != nil {
			return nil, fail(n, "%v", err)
		}
	}
	if len(s.steps) == 0 {
		return nil, fail(1, "script has no requests")
	}
	if cur.expectLine == 0 {
		return nil, fail(cur.line, "request has no 'expect STATUS' line")
	}
	return s, nil
}

func parseRequestLine(st *step, n int, word, rest string) error {
	switch word {
	case "header", "query":
		name, value, ok := cutField(rest)
		if !ok {
			return fmt.Errorf("want '%s NAME: VALUE', got %q", word, word+" "+rest)
		}
		f := field{n, name, value}
		if word == "header" {
			st.headers = append(st.headers, f)
		} else {
			st.query = append(st.query, f)
		}
	case "body", "body-file", "body-hex":
		if st.body != nil {
			return fmt.Errorf("request already has a body on line %d", st.body.line)
		}
		p, err := parsePayload(n, word, rest)
		if err != nil {
			return err
		}
		st.body = p
	case "sign":
		if st.sign != nil {
			return fmt.Errorf("request is already signed on line %d", st.sign.line)
		}
		st.sign = &signing{line: n, overrides: map[string]string{}}
		for _, kv := range strings.Fields(rest) {
			name, value, ok := strings.Cut(kv, "=")
			if !ok || !signingVars[name] {
				return fmt.Errorf("want 'sign [NAME=VALUE...]' with NAME one of access_key_id, secret_access_key, or region; got %q", kv)
			}
			st.sign.overrides[name] = value
		}
	default:
		return fmt.Errorf("unknown request directive %q (want header, query, body, body-file, body-hex, or sign)", word)
	}
	return nil
}

func parseExpectLine(st *step, n int, line, word, rest string) error {
	switch word {
	case "capture":
		// capture NAME = header NAME | xml PATH
		name, rest := cutWord(rest)
		eq, rest := cutWord(rest)
		subject, arg := cutWord(rest)
		if !validName(name) || eq != "=" || (subject != "header" && subject != "xml") || arg == "" || strings.ContainsAny(arg, " \t") {
			return fmt.Errorf("want 'capture NAME = header HEADER' or 'capture NAME = xml PATH', got %q", line)
		}
		st.captures = append(st.captures, capture{n, name, subject, arg})
		return nil
	case "header":
		c := check{line: n, source: line, subject: word}
		if name, value, ok := cutField(rest); ok {
			c.arg, c.op, c.value = name, "=", value
		} else {
			c.arg, rest = cutWord(rest)
			c.op, c.value = cutWord(rest)
			switch {
			case c.op == "!=" && c.value != "":
			case (c.op == "present" || c.op == "absent") && c.value == "":
			default:
				return fmt.Errorf("want 'header NAME: VALUE', 'header NAME != VALUE', or 'header NAME present|absent', got %q", line)
			}
		}
		st.checks = append(st.checks, c)
		return nil
	case "xml":
		c := check{line: n, source: line, subject: word}
		c.arg, rest = cutWord(rest)
		c.op, c.value = cutWord(rest)
		if _, err := parsePath(c.arg); err != nil {
			return err
		}
		switch c.op {
		case "=", "!=":
			// A value may be empty only for '=': the element exists with no text.
			if c.op == "!=" && c.value == "" {
				return fmt.Errorf("'xml PATH !=' needs a value")
			}
		case "count":
			if _, err := strconv.Atoi(c.value); err != nil {
				return fmt.Errorf("want 'xml PATH count N', got %q", line)
			}
		case "present", "absent", "nonempty":
			if c.value != "" {
				return fmt.Errorf("'xml PATH %s' takes no value", c.op)
			}
		default:
			return fmt.Errorf("want 'xml PATH' followed by '= VALUE', '!= VALUE', 'count N', 'present', 'absent', or 'nonempty'; got %q", line)
		}
		st.checks = append(st.checks, c)
		return nil
	case "body", "body-file", "body-hex", "body-size", "body-sha256":
		if word == "body-size" {
			if size, err := strconv.Atoi(rest); err != nil || size < 0 {
				return fmt.Errorf("want 'body-size BYTES', got %q", line)
			}
		} else if _, err := parsePayload(n, word, rest); err != nil {
			return err
		}
		st.checks = append(st.checks, check{line: n, source: line, subject: word, op: "=", value: rest})
		return nil
	}
	return fmt.Errorf("unknown check %q (want capture, header, xml, body, body-file, body-hex, body-size, or body-sha256)", word)
}

func parsePayload(n int, kind, value string) (*payload, error) {
	switch kind {
	case "body-file":
		if value == "" {
			return nil, fmt.Errorf("body-file needs a path")
		}
	case "body-hex", "body-sha256":
		if _, err := hex.DecodeString(value); err != nil {
			return nil, fmt.Errorf("%s: %v", kind, err)
		}
		if kind == "body-sha256" && len(value) != 64 {
			return nil, fmt.Errorf("body-sha256 needs 64 hex digits")
		}
	}
	return &payload{n, kind, value}, nil
}

// cutWord splits off the first whitespace-delimited word of s.
func cutWord(s string) (word, rest string) {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, " \t"); i >= 0 {
		return s[:i], strings.TrimSpace(s[i:])
	}
	return s, ""
}

// cutField parses 'NAME: VALUE', where NAME has no spaces and VALUE may be
// empty.
func cutField(s string) (name, value string, ok bool) {
	name, value, ok = strings.Cut(s, ":")
	if !ok || name == "" || strings.ContainsAny(name, " \t") {
		return "", "", false
	}
	return name, strings.TrimSpace(value), true
}

// Request lines begin with an upper-case method; every directive is lower case.
func isMethod(word string) bool {
	if word == "" {
		return false
	}
	for _, r := range word {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func validName(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		letter := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		if !letter && (i == 0 || r < '0' || r > '9') {
			return false
		}
	}
	return true
}

// expand replaces each {name} with the variable's value. A brace not followed
// by a valid name and a closing brace is literal text.
func expand(s string, vars map[string]string) (string, error) {
	var b strings.Builder
	for {
		i := strings.IndexByte(s, '{')
		if i < 0 {
			b.WriteString(s)
			return b.String(), nil
		}
		b.WriteString(s[:i])
		s = s[i:]
		j := strings.IndexByte(s, '}')
		if j < 0 || !validName(s[1:j]) {
			b.WriteByte('{')
			s = s[1:]
			continue
		}
		value, ok := vars[s[1:j]]
		if !ok {
			return "", fmt.Errorf("undefined variable {%s}", s[1:j])
		}
		b.WriteString(value)
		s = s[j+1:]
	}
}
