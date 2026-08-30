// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"regexp"
	"runtime"
	"strings"
)

// Boolean expressions for REQUIRES:, UNSUPPORTED: and XFAIL:, with lit's
// grammar: identifiers, !, &&, ||, parentheses, and {{regex}} matched
// against the available features.

type boolExprParser struct {
	tokens   []string
	pos      int
	features map[string]bool
}

func isFeatureChar(c byte) bool {
	return c == '-' || c == '+' || c == '=' || c == '.' || c == '_' || c == ':' ||
		(c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func tokenizeBoolExpr(s string) ([]string, error) {
	var toks []string
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t':
			i++
		case c == '(' || c == ')' || c == '!':
			toks = append(toks, string(c))
			i++
		case strings.HasPrefix(s[i:], "&&") || strings.HasPrefix(s[i:], "||"):
			toks = append(toks, s[i:i+2])
			i += 2
		case strings.HasPrefix(s[i:], "{{"):
			end := strings.Index(s[i:], "}}")
			if end < 0 {
				return nil, fmt.Errorf("unterminated regex in '%s'", s)
			}
			toks = append(toks, s[i:i+end+2])
			i += end + 2
		case isFeatureChar(c):
			j := i
			for j < len(s) && isFeatureChar(s[j]) {
				j++
			}
			toks = append(toks, s[i:j])
			i = j
		default:
			return nil, fmt.Errorf("unexpected character '%c' in '%s'", c, s)
		}
	}
	return toks, nil
}

// evalBoolExpr evaluates expr against the feature set.
func evalBoolExpr(expr string, features map[string]bool) (bool, error) {
	toks, err := tokenizeBoolExpr(expr)
	if err != nil {
		return false, err
	}
	if len(toks) == 0 {
		return false, fmt.Errorf("empty expression")
	}
	p := &boolExprParser{tokens: toks, features: features}
	v, err := p.parseOr()
	if err != nil {
		return false, err
	}
	if p.pos != len(p.tokens) {
		return false, fmt.Errorf("unexpected '%s' in '%s'", p.tokens[p.pos], expr)
	}
	return v, nil
}

func (p *boolExprParser) peek() string {
	if p.pos < len(p.tokens) {
		return p.tokens[p.pos]
	}
	return ""
}

func (p *boolExprParser) parseOr() (bool, error) {
	v, err := p.parseAnd()
	if err != nil {
		return false, err
	}
	for p.peek() == "||" {
		p.pos++
		r, err := p.parseAnd()
		if err != nil {
			return false, err
		}
		v = v || r
	}
	return v, nil
}

func (p *boolExprParser) parseAnd() (bool, error) {
	v, err := p.parseNot()
	if err != nil {
		return false, err
	}
	for p.peek() == "&&" {
		p.pos++
		r, err := p.parseNot()
		if err != nil {
			return false, err
		}
		v = v && r
	}
	return v, nil
}

func (p *boolExprParser) parseNot() (bool, error) {
	if p.peek() == "!" {
		p.pos++
		v, err := p.parseNot()
		return !v, err
	}
	return p.parseAtom()
}

func (p *boolExprParser) parseAtom() (bool, error) {
	t := p.peek()
	switch {
	case t == "":
		return false, fmt.Errorf("unexpected end of expression")
	case t == "(":
		p.pos++
		v, err := p.parseOr()
		if err != nil {
			return false, err
		}
		if p.peek() != ")" {
			return false, fmt.Errorf("missing ')'")
		}
		p.pos++
		return v, nil
	case t == ")" || t == "&&" || t == "||":
		return false, fmt.Errorf("unexpected '%s'", t)
	case strings.HasPrefix(t, "{{"):
		p.pos++
		re, err := regexp.Compile("^(?:" + t[2:len(t)-2] + ")$")
		if err != nil {
			return false, fmt.Errorf("invalid regex %s: %v", t, err)
		}
		if re.MatchString("true") {
			return true, nil
		}
		for f := range p.features {
			if re.MatchString(f) {
				return true, nil
			}
		}
		return false, nil
	default:
		p.pos++
		return t == "true" || p.features[t], nil
	}
}

// hostFeatures are the features every test can rely on.
func hostFeatures() []string {
	feats := []string{"filecheck", "system-" + runtime.GOOS}
	switch runtime.GOARCH {
	case "amd64":
		feats = append(feats, "x86_64", "x86")
	case "arm64":
		feats = append(feats, "aarch64", "arm64")
	default:
		feats = append(feats, runtime.GOARCH)
	}
	return feats
}
