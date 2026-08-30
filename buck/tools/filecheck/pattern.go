// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"regexp/syntax"
	"slices"
	"strings"
)

// varContext holds string and numeric variables across a whole check file.
type varContext struct {
	strVars map[string]string
	// definedStr records string variables that some pattern defines, so
	// name collisions with numeric variables are caught while parsing even
	// before the defining pattern has matched.
	definedStr map[string]bool
	numVars    map[string]*numVar
}

func newVarContext() *varContext {
	return &varContext{
		strVars:    map[string]string{},
		definedStr: map[string]bool{},
		numVars:    map[string]*numVar{},
	}
}

// numericVariable returns the variable named name, creating an undefined
// placeholder on first sight so uses can be bound before definitions.
func (c *varContext) numericVariable(name string) *numVar {
	if v, ok := c.numVars[name]; ok {
		return v
	}
	v := &numVar{name: name, format: numFormat{kind: fmtUnsigned}}
	c.numVars[name] = v
	return v
}

// lineVar is the @LINE pseudo variable for a directive on the given line.
func lineVar(line int) *numVar {
	return &numVar{name: "@LINE", format: numFormat{kind: fmtUnsigned}, value: big.NewInt(int64(line))}
}

// clearLocalVars forgets every variable whose name does not start with '$'.
func (c *varContext) clearLocalVars() {
	for name := range c.strVars {
		if !strings.HasPrefix(name, "$") {
			delete(c.strVars, name)
		}
	}
	for name, v := range c.numVars {
		if !strings.HasPrefix(name, "$") {
			v.value = nil
		}
	}
}

// defineCmdlineVariables processes -D options: NAME=VALUE defines a string
// variable, #NAME=EXPR or #%fmt,NAME=EXPR a numeric one.
func (c *varContext) defineCmdlineVariables(defs []string) error {
	for _, def := range defs {
		if strings.HasPrefix(def, "#") {
			body := def[1:]
			eq := strings.IndexByte(body, '=')
			if eq < 0 {
				return fmt.Errorf("missing equal sign in global definition '-D%s'", def)
			}
			// Reuse the substitution grammar: "#NAME=EXPR" is "[[#NAME: EXPR]]".
			block, err := parseNumericBlock(body[:eq]+":"+body[eq+1:], 0, c, false)
			if err != nil {
				return fmt.Errorf("invalid numeric definition '-D%s': %v", def, err)
			}
			if block.defName == "" || block.expr == nil {
				return fmt.Errorf("invalid numeric definition '-D%s': expected #NAME=EXPR", def)
			}
			if c.definedStr[block.defName] {
				return fmt.Errorf("string variable with name '%s' already exists", block.defName)
			}
			value, err := block.expr.eval()
			if err != nil {
				return fmt.Errorf("invalid numeric definition '-D%s': %v", def, err)
			}
			v := c.numericVariable(block.defName)
			v.format = block.format
			v.value = value
			continue
		}
		eq := strings.IndexByte(def, '=')
		if eq < 0 {
			return fmt.Errorf("missing equal sign in global definition '-D%s'", def)
		}
		name, pseudo, n, err := parseVariableName(def[:eq])
		if err != nil || pseudo || n != eq {
			return fmt.Errorf("invalid name in string variable definition '%s'", def[:eq])
		}
		if _, exists := c.numVars[name]; exists {
			return fmt.Errorf("numeric variable with name '%s' already exists", name)
		}
		c.strVars[name] = def[eq+1:]
		c.definedStr[name] = true
	}
	return nil
}

type pieceKind int

const (
	pieceRegex pieceKind = iota
	pieceStrSub
	pieceNumSub
	pieceSameUse
)

// piece is one fragment of a pattern's regular expression. Substitution
// pieces are resolved against the variable context every time the pattern is
// matched.
type piece struct {
	kind pieceKind
	// text is the regex of a pieceRegex.
	text string
	// name is the variable a pieceStrSub substitutes.
	name string
	// block is the expression a pieceNumSub substitutes.
	block *numericBlock
	// A pieceSameUse repeats the regex of a variable defined earlier in the
	// same pattern: defGroup is that definition's capture group, useGroup the
	// group emitted for this use, and defRegex has defGroups groups of its
	// own.
	defGroup, useGroup, defGroups int
	defRegex                      string
	// off is the byte offset of a substitution block in the pattern text and
	// src its spelling, for diagnostics.
	off int
	src string
}

type strVarDef struct {
	name  string
	group int
	regex string
}

type numVarDef struct {
	group int
	v     *numVar
}

type patternOptions struct {
	matchFullLines bool
	strictWS       bool
	ignoreCase     bool
}

// pattern is one parsed check directive body.
type pattern struct {
	ty     checkType
	prefix string
	count  int
	// loc is the offset of the pattern text in the check file; lineNo its
	// 1-based line.
	loc    int
	lineNo int
	// src is the pattern text. A plain string that needs no regex is searched
	// for directly as fixed.
	src   string
	fixed []byte

	pieces  []piece
	strDefs []strVarDef
	numDefs []numVarDef

	hasVariable bool
	ctx         *varContext
	opts        patternOptions
	reCache     map[string]*regexp.Regexp
}

// matchError is returned when a pattern cannot be matched at all, as opposed
// to simply not matching. subs lists the substitutions without a value when
// they are the cause; otherwise msg describes the problem (an invalid regex,
// a captured number out of range).
type matchError struct {
	msg  string
	subs []substitutionValue
}

func (e *matchError) Error() string { return e.msg }

func newPattern(ty checkType, prefix string, ctx *varContext, opts patternOptions, loc, lineNo int) *pattern {
	return &pattern{ty: ty, prefix: prefix, count: 1, ctx: ctx, opts: opts, loc: loc, lineNo: lineNo, reCache: map[string]*regexp.Regexp{}}
}

func (p *pattern) checkName() string {
	return p.prefix + p.ty.suffix()
}

// regexBuilder assembles a pattern's pieces while numbering capture groups,
// so variable definitions know which group holds their value.
type regexBuilder struct {
	p        *pattern
	buf      strings.Builder
	curParen int
}

// raw appends regex text that contains no capture groups.
func (b *regexBuilder) raw(s string) {
	b.buf.WriteString(s)
}

// fragment validates a user-written regex and appends it, counting its
// capture groups.
func (b *regexBuilder) fragment(re string) error {
	n, err := regexGroupCount(re)
	if err != nil {
		return err
	}
	b.curParen += n
	b.buf.WriteString(re)
	return nil
}

// group opens a capture group and returns its number; the caller closes it
// with raw(")").
func (b *regexBuilder) group() int {
	b.buf.WriteString("(")
	n := b.curParen
	b.curParen++
	return n
}

// flush ends the pending regex piece.
func (b *regexBuilder) flush() {
	if b.buf.Len() > 0 {
		b.p.pieces = append(b.p.pieces, piece{kind: pieceRegex, text: b.buf.String()})
		b.buf.Reset()
	}
}

// piece appends a substitution piece after the pending regex text.
func (b *regexBuilder) piece(pc piece) {
	b.flush()
	b.p.pieces = append(b.p.pieces, pc)
}

// parse builds the pattern from the check line's text. literal requests
// {LITERAL} semantics: no regex or substitution syntax is recognized.
func (p *pattern) parse(text string, literal bool) error {
	matchFullLines := p.opts.matchFullLines && p.ty != checkNot
	if !(p.opts.strictWS && p.opts.matchFullLines) {
		text = strings.TrimRight(text, " \t")
	}
	p.src = text

	if p.ty == checkEmpty {
		if text != "" {
			return perr(0, "found non-empty check string for empty check with prefix '"+p.checkName()+":'")
		}
		p.pieces = []piece{{kind: pieceRegex, text: `(\n$)`}}
		return nil
	}
	if text == "" {
		return perr(0, "found empty check string with prefix '"+p.checkName()+":'")
	}
	if literal || (!matchFullLines && (len(text) < 2 || (!strings.Contains(text, "{{") && !strings.Contains(text, "[[")))) {
		// A plain string is searched for directly; case folding goes
		// through the regex engine instead.
		if p.opts.ignoreCase {
			p.pieces = []piece{{kind: pieceRegex, text: regexp.QuoteMeta(text)}}
		} else {
			p.fixed = []byte(text)
		}
		return nil
	}

	// Group 0 is the whole match; definitions take the groups after it.
	b := &regexBuilder{p: p, curParen: 1}
	if matchFullLines {
		b.raw("^")
		if !p.opts.strictWS {
			b.raw(" *")
		}
	}
	rest := text
	pos := 0 // offset of rest within text
	for len(rest) > 0 {
		switch {
		case strings.HasPrefix(rest, "{{"):
			// Only the first '}}' terminates a regex piece.
			end := strings.Index(rest, "}}")
			if end < 0 {
				return perr(pos, "found start of regex string with no end '}}'")
			}
			// Keep alternatives inside the fragment without adding captures.
			b.raw("(?:")
			if err := b.fragment(rest[2:end]); err != nil {
				return perr(pos+2, "invalid regex: "+err.Error())
			}
			b.raw(")")
			rest = rest[end+2:]
			pos += end + 2

		case strings.HasPrefix(rest, "[[") && !strings.HasPrefix(rest, "[[["):
			end := findSubstitutionEnd(rest[2:])
			if end < 0 {
				return perr(pos, "found start of substitution block with no end ']]'")
			}
			if err := p.parseSubstitution(b, rest[2:2+end], pos); err != nil {
				return err
			}
			rest = rest[2+end+2:]
			pos += 2 + end + 2

		default:
			end := len(rest)
			if i := strings.Index(rest, "{{"); i >= 0 {
				end = i
			}
			if i := strings.Index(rest, "[["); i >= 0 && i < end {
				end = i
			}
			if end == 0 {
				// "[[[": the first bracket is literal.
				end = 1
			}
			b.raw(regexp.QuoteMeta(rest[:end]))
			rest = rest[end:]
			pos += end
		}
	}
	if matchFullLines {
		if !p.opts.strictWS {
			b.raw(" *")
		}
		b.raw("$")
	}
	b.flush()
	return nil
}

// parseSubstitution handles the body of one [[...]] block that starts at
// blockOff in the pattern text: string variable definitions and uses, and
// numeric definitions, substitutions and wildcards.
func (p *pattern) parseSubstitution(b *regexBuilder, body string, blockOff int) error {
	src := "[[" + body + "]]"
	numeric := strings.HasPrefix(body, "#")
	legacyLine := false
	if numeric {
		body = body[1:]
	} else {
		colon := strings.IndexByte(body, ':')
		nameEnd := len(body)
		if colon >= 0 {
			nameEnd = colon
		}
		if strings.ContainsAny(body[:nameEnd], " \t") {
			return perr(blockOff+2, "unexpected whitespace")
		}
		name, pseudo, n, err := parseVariableName(body)
		if err != nil {
			return perr(blockOff+2, "invalid variable name")
		}
		switch {
		case colon >= 0:
			// [[NAME:regex]] defines NAME as whatever the regex captures.
			if pseudo || n != colon {
				return perr(blockOff+2, "invalid name in string variable definition")
			}
			if _, exists := p.ctx.numVars[name]; exists {
				return perr(blockOff+2, "numeric variable with name '"+name+"' already exists")
			}
			p.hasVariable = true
			re := body[colon+1:]
			group := b.group()
			if err := b.fragment(re); err != nil {
				return perr(blockOff, "invalid regex: "+err.Error())
			}
			b.raw(")")
			p.strDefs = append(p.strDefs, strVarDef{name: name, group: group, regex: re})
			p.ctx.definedStr[name] = true
			return nil
		case pseudo:
			// [[@LINE+1]] is the legacy spelling of [[#@LINE+1]].
			numeric, legacyLine = true, true
		case n != len(body):
			return perr(blockOff+2+n, "invalid name in string variable use")
		default:
			p.hasVariable = true
			if def := p.findStrDef(name); def != nil {
				// A use of a variable defined earlier in this same pattern
				// is a backreference, which RE2 lacks; emit the definition's
				// regex again and verify equality after matching.
				n, _ := regexGroupCount(def.regex)
				b.piece(piece{kind: pieceSameUse, defGroup: def.group, useGroup: b.curParen, defGroups: n, defRegex: def.regex, off: blockOff, src: src})
				b.curParen += 1 + n
			} else {
				b.piece(piece{kind: pieceStrSub, name: name, off: blockOff, src: src})
			}
			return nil
		}
	}

	block, err := parseNumericBlock(body, p.lineNo, p.ctx, legacyLine)
	if err != nil {
		var pe *parseError
		if errors.As(err, &pe) && pe.off >= 0 {
			off := blockOff + 2 + pe.off
			if !legacyLine {
				off++ // the '#'
			}
			return perr(off, pe.msg)
		}
		return perr(blockOff, err.Error())
	}
	sub := piece{kind: pieceNumSub, block: block, off: blockOff, src: src}
	if block.defName == "" {
		if block.expr == nil {
			// [[#]] and [[#%x,]] match any value of the format.
			b.raw("(?:")
			b.fragment(block.format.wildcardRegex())
			b.raw(")")
			return nil
		}
		// [[#expr]] matches the value of the expression.
		p.hasVariable = true
		b.piece(sub)
		return nil
	}
	if p.ctx.definedStr[block.defName] {
		return perr(blockOff+3, "string variable with name '"+block.defName+"' already exists")
	}
	if v, exists := p.ctx.numVars[block.defName]; exists && v.hasLine && v.defLine == p.lineNo {
		return perr(blockOff+3, "numeric variable '"+block.defName+"' defined earlier in the same CHECK directive")
	}
	// [[#NAME:]] defines NAME as the number matched; [[#NAME: expr]] as the
	// value of the expression, which the input must contain.
	p.hasVariable = true
	v := p.ctx.numericVariable(block.defName)
	v.format = block.format
	v.defLine = p.lineNo
	v.hasLine = true
	group := b.group()
	if block.expr != nil {
		b.piece(sub)
	} else {
		b.fragment(block.format.wildcardRegex())
	}
	b.raw(")")
	p.numDefs = append(p.numDefs, numVarDef{group: group, v: v})
	return nil
}

func (p *pattern) findStrDef(name string) *strVarDef {
	if i := slices.IndexFunc(p.strDefs, func(d strVarDef) bool { return d.name == name }); i >= 0 {
		return &p.strDefs[i]
	}
	return nil
}

// regexGroupCount validates a regex fragment and returns its number of
// capturing groups, parsing it the way regexp.Compile does.
func regexGroupCount(re string) (int, error) {
	parsed, err := syntax.Parse(re, syntax.Perl)
	if err != nil {
		return 0, err
	}
	return parsed.MaxCap(), nil
}

// findSubstitutionEnd returns the offset of the "]]" closing a substitution
// block whose body starts at s[0], honoring nested brackets and escapes.
func findSubstitutionEnd(s string) int {
	depth := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '[':
			depth++
		case ']':
			if depth > 0 {
				depth--
			} else if i+1 < len(s) && s[i+1] == ']' {
				return i
			}
		}
	}
	return -1
}

// substitutionValue describes one substitution performed during a match, for
// the "with X equal to Y" diagnostics, or one that failed with err.
type substitutionValue struct {
	src   string
	value string
	off   int
	err   error
}

// matchResult is a successful match.
type matchResult struct {
	pos, length int
	subs        []substitutionValue
}

// resolve evaluates the pattern's substitutions against the current variable
// values. It returns the regex text of every piece and the substitutions
// made, or a matchError listing the substitutions that have no value.
func (p *pattern) resolve() ([]string, []substitutionValue, *matchError) {
	frags := make([]string, len(p.pieces))
	var subs, failed []substitutionValue
	for i, pc := range p.pieces {
		switch pc.kind {
		case pieceRegex:
			frags[i] = pc.text
		case pieceStrSub:
			value, ok := p.ctx.strVars[pc.name]
			if !ok {
				failed = append(failed, substitutionValue{src: pc.src, off: pc.off, err: &undefinedVarError{name: pc.name}})
				continue
			}
			subs = append(subs, substitutionValue{src: pc.src, value: value, off: pc.off})
			frags[i] = regexp.QuoteMeta(value)
		case pieceNumSub:
			var names []string
			pc.block.expr.undefined(&names)
			for _, name := range names {
				failed = append(failed, substitutionValue{src: pc.src, off: pc.off, err: &undefinedVarError{name: name}})
			}
			if len(names) > 0 {
				continue
			}
			text, err := pc.block.value()
			if err != nil {
				failed = append(failed, substitutionValue{src: pc.src, off: pc.off, err: err})
				continue
			}
			subs = append(subs, substitutionValue{src: pc.src, value: text, off: pc.off})
			frags[i] = regexp.QuoteMeta(text)
		case pieceSameUse:
			frags[i] = "(" + pc.defRegex + ")"
		}
	}
	if len(failed) > 0 {
		return nil, subs, &matchError{msg: failed[0].err.Error(), subs: failed}
	}
	return frags, subs, nil
}

// regexText joins resolved fragments into the regex to run.
func (p *pattern) regexText(frags []string) string {
	var sb strings.Builder
	sb.WriteString("(?m)")
	if p.opts.ignoreCase {
		sb.WriteString("(?i)")
	}
	for _, f := range frags {
		sb.WriteString(f)
	}
	return sb.String()
}

// match finds the pattern in buf. The returned position and length are
// relative to buf; a nil result with a nil error means no match.
func (p *pattern) match(buf []byte) (*matchResult, error) {
	if p.ty == checkEOF {
		return &matchResult{pos: len(buf)}, nil
	}
	if p.fixed != nil {
		idx := bytes.Index(buf, p.fixed)
		if idx < 0 {
			return nil, nil
		}
		return &matchResult{pos: idx, length: len(p.fixed)}, nil
	}

	frags, subs, merr := p.resolve()
	if merr != nil {
		return nil, merr
	}
	reStr := p.regexText(frags)
	re, ok := p.reCache[reStr]
	if !ok {
		var err error
		re, err = regexp.Compile(reStr)
		if err != nil {
			return nil, &matchError{msg: "invalid regex: " + err.Error()}
		}
		p.reCache[reStr] = re
	}

	loc := p.findWithBackrefs(re, frags, buf)
	if loc == nil {
		return nil, nil
	}
	group := func(i int) []byte {
		if 2*i+1 >= len(loc) || loc[2*i] < 0 {
			return nil
		}
		return buf[loc[2*i]:loc[2*i+1]]
	}
	for _, def := range p.strDefs {
		p.ctx.strVars[def.name] = string(group(def.group))
	}
	for _, def := range p.numDefs {
		text := string(group(def.group))
		value, err := def.v.format.parseValue(text)
		if err != nil {
			return nil, &matchError{msg: fmt.Sprintf("unable to represent value of numeric variable '%s' matched at '%s': %v", def.v.name, text, err)}
		}
		def.v.value = value
	}

	pos, end := loc[0], loc[1]
	if p.ty == checkEmpty {
		// The pattern consumed the newline that ends the previous line; the
		// match itself is the empty line after it.
		pos++
	}
	return &matchResult{pos: pos, length: end - pos, subs: subs}, nil
}

// shiftLoc moves match indexes found in buf[start:] to be relative to buf.
func shiftLoc(loc []int, start int) {
	for i := range loc {
		if loc[i] >= 0 {
			loc[i] += start
		}
	}
}

// findWithBackrefs runs re over buf and, for patterns that reuse a variable
// defined in the same directive, keeps searching until the reused group
// equals its definition. RE2 has no backreferences, so a candidate whose
// groups disagree is retried with the definition's text substituted
// literally, then the search moves one byte forward.
func (p *pattern) findWithBackrefs(re *regexp.Regexp, frags []string, buf []byte) []int {
	if !slices.ContainsFunc(p.pieces, func(pc piece) bool { return pc.kind == pieceSameUse }) {
		return re.FindSubmatchIndex(buf)
	}
	start := 0
	for start <= len(buf) {
		loc := re.FindSubmatchIndex(buf[start:])
		if loc == nil {
			return nil
		}
		shiftLoc(loc, start)
		if p.sameUsesAgree(loc, buf) {
			return loc
		}
		if alt := p.retryWithLiterals(frags, loc, buf); alt != nil {
			return alt
		}
		start = loc[0] + 1
	}
	return nil
}

func (p *pattern) sameUsesAgree(loc []int, buf []byte) bool {
	for _, pc := range p.pieces {
		if pc.kind != pieceSameUse {
			continue
		}
		d, u := pc.defGroup, pc.useGroup
		if 2*u+1 >= len(loc) || 2*d+1 >= len(loc) || loc[2*d] < 0 || loc[2*u] < 0 {
			return false
		}
		def, use := buf[loc[2*d]:loc[2*d+1]], buf[loc[2*u]:loc[2*u+1]]
		if p.opts.ignoreCase {
			if !bytes.EqualFold(def, use) {
				return false
			}
		} else if !bytes.Equal(def, use) {
			return false
		}
	}
	return true
}

// retryWithLiterals matches again at the candidate's position with each
// reused variable replaced by the text its definition captured.
func (p *pattern) retryWithLiterals(frags []string, loc []int, buf []byte) []int {
	spliced := slices.Clone(frags)
	for i, pc := range p.pieces {
		if pc.kind != pieceSameUse {
			continue
		}
		d := pc.defGroup
		if 2*d+1 >= len(loc) || loc[2*d] < 0 {
			return nil
		}
		// Empty groups keep the numbering of the definition's own groups.
		spliced[i] = "(" + regexp.QuoteMeta(string(buf[loc[2*d]:loc[2*d+1]])) + strings.Repeat("()", pc.defGroups) + ")"
	}
	re, err := regexp.Compile(p.regexText(spliced))
	if err != nil {
		return nil
	}
	alt := re.FindSubmatchIndex(buf[loc[0]:])
	if alt == nil || alt[0] != 0 {
		return nil
	}
	shiftLoc(alt, loc[0])
	if !p.sameUsesAgree(alt, buf) {
		return nil
	}
	return alt
}

// fuzzyMatchLine finds the input line closest to the pattern text, for the
// "possible intended match here" note. It returns the offset of that line's
// first non-blank character, or -1.
func (p *pattern) fuzzyMatchLine(buf []byte) int {
	if p.src == "" {
		return -1
	}
	best := -1
	bestDist := -1
	const maxLines = 5000
	const maxLineLen = 1024
	lines := 0
	for off := 0; off < len(buf) && lines < maxLines; lines++ {
		end := off
		for end < len(buf) && buf[end] != '\n' {
			end++
		}
		line := buf[off:end]
		next := end + 1
		// Skip leading blanks so the note lands on content.
		lead := 0
		for lead < len(line) && (line[lead] == ' ' || line[lead] == '\t') {
			lead++
		}
		line = line[lead:]
		if len(line) > 0 && len(line) <= maxLineLen {
			d := editDistance(p.src, string(line))
			if bestDist < 0 || d < bestDist {
				bestDist = d
				best = off + lead
			}
		}
		off = next
	}
	return best
}

func editDistance(a, b string) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}
