// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Numeric substitutions: [[#%<fmt>,<NAME>: <expr>]] and friends. The grammar,
// operator associativity and diagnostics follow LLVM's FileCheck so that check
// files written for it behave identically here.

type formatKind int

const (
	fmtNone formatKind = iota
	fmtUnsigned
	fmtSigned
	fmtHexLower
	fmtHexUpper
)

type numFormat struct {
	kind      formatKind
	precision int
	alternate bool
}

var (
	maxUint64 = new(big.Int).SetUint64(^uint64(0))
	minInt64  = big.NewInt(-1 << 63)
)

func (f numFormat) String() string {
	var b strings.Builder
	b.WriteByte('%')
	if f.alternate {
		b.WriteByte('#')
	}
	if f.precision > 0 {
		fmt.Fprintf(&b, ".%d", f.precision)
	}
	switch f.kind {
	case fmtSigned:
		b.WriteByte('d')
	case fmtHexLower:
		b.WriteByte('x')
	case fmtHexUpper:
		b.WriteByte('X')
	default:
		b.WriteByte('u')
	}
	return b.String()
}

// wildcardRegex is the regex matching any value in this format.
func (f numFormat) wildcardRegex() string {
	sign, lead, digit := "", "[1-9]", "[0-9]"
	switch f.kind {
	case fmtSigned:
		sign = "-?"
	case fmtHexLower:
		lead, digit = "[1-9a-f]", "[0-9a-f]"
	case fmtHexUpper:
		lead, digit = "[1-9A-F]", "[0-9A-F]"
	}
	prefix := ""
	if f.alternate {
		prefix = "0x"
	}
	if f.precision > 0 {
		return prefix + sign + "(" + lead + digit + "*)?" + digit + "{" + strconv.Itoa(f.precision) + "}"
	}
	return prefix + sign + digit + "+"
}

// format renders v the way this format would print it.
func (f numFormat) format(v *big.Int) (string, error) {
	var s string
	switch f.kind {
	case fmtSigned:
		s = v.Text(10)
	case fmtHexLower, fmtHexUpper:
		if v.Sign() < 0 {
			return "", errors.New("unable to represent negative value in hexadecimal format")
		}
		s = v.Text(16)
		if f.kind == fmtHexUpper {
			s = strings.ToUpper(s)
		}
	default:
		if v.Sign() < 0 {
			return "", errors.New("unable to represent negative value in unsigned format")
		}
		s = v.Text(10)
	}
	negative := strings.HasPrefix(s, "-")
	digits := strings.TrimPrefix(s, "-")
	if f.precision > len(digits) {
		digits = strings.Repeat("0", f.precision-len(digits)) + digits
	}
	if f.alternate && (f.kind == fmtHexLower || f.kind == fmtHexUpper) {
		digits = "0x" + digits
	}
	if negative {
		return "-" + digits, nil
	}
	return digits, nil
}

// parseValue converts text matched by wildcardRegex into a value.
func (f numFormat) parseValue(s string) (*big.Int, error) {
	text := s
	base := 10
	if f.kind == fmtHexLower || f.kind == fmtHexUpper {
		base = 16
		if f.alternate {
			text = strings.TrimPrefix(text, "0x")
		}
	}
	v, ok := new(big.Int).SetString(text, base)
	if !ok {
		return nil, fmt.Errorf("unable to represent numeric value %q", s)
	}
	if err := checkRange(v); err != nil {
		return nil, err
	}
	return v, nil
}

func checkRange(v *big.Int) error {
	if v.Cmp(maxUint64) > 0 {
		return errors.New("unsigned overflow")
	}
	if v.Cmp(minInt64) < 0 {
		return errors.New("signed overflow")
	}
	return nil
}

// numVar is a numeric variable. Entries are created at parse time for both
// definitions and uses, and take their value when a defining pattern matches.
// defLine is the check line of the defining directive, when hasLine.
type numVar struct {
	name    string
	format  numFormat
	value   *big.Int
	defLine int
	hasLine bool
}

// exprNode is a numeric expression. Variables are resolved when evaluated, so
// a use that precedes its definition in the check file is reported when the
// pattern is matched, not when it is parsed.
type exprNode interface {
	eval() (*big.Int, error)
	implicitFormat() (numFormat, error)
	// undefined appends the names of the variables that have no value yet.
	undefined(names *[]string)
}

type literalNode struct {
	value *big.Int
}

func (n *literalNode) eval() (*big.Int, error)            { return n.value, nil }
func (n *literalNode) implicitFormat() (numFormat, error) { return numFormat{}, nil }
func (n *literalNode) undefined(*[]string)                {}

type varNode struct {
	v *numVar
}

type undefinedVarError struct {
	name string
}

func (e *undefinedVarError) Error() string { return "undefined variable: " + e.name }

func (n *varNode) eval() (*big.Int, error) {
	if n.v.value == nil {
		return nil, &undefinedVarError{name: n.v.name}
	}
	return n.v.value, nil
}
func (n *varNode) implicitFormat() (numFormat, error) { return n.v.format, nil }
func (n *varNode) undefined(names *[]string) {
	if n.v.value == nil {
		*names = append(*names, n.v.name)
	}
}

type binopNode struct {
	left, right exprNode
	fn          func(a, b *big.Int) (*big.Int, error)
}

func (n *binopNode) eval() (*big.Int, error) {
	l, err := n.left.eval()
	if err != nil {
		return nil, err
	}
	r, err := n.right.eval()
	if err != nil {
		return nil, err
	}
	v, err := n.fn(l, r)
	if err != nil {
		return nil, err
	}
	if err := checkRange(v); err != nil {
		return nil, err
	}
	return v, nil
}

func (n *binopNode) implicitFormat() (numFormat, error) {
	return mergeFormats(n.left, n.right)
}
func (n *binopNode) undefined(names *[]string) {
	n.left.undefined(names)
	n.right.undefined(names)
}

func mergeFormats(nodes ...exprNode) (numFormat, error) {
	var result numFormat
	for _, n := range nodes {
		f, err := n.implicitFormat()
		if err != nil {
			return numFormat{}, err
		}
		if f.kind == fmtNone {
			continue
		}
		if result.kind == fmtNone {
			result = f
			continue
		}
		if result != f {
			return numFormat{}, errors.New("implicit format conflict between '" + result.String() + "' and '" + f.String() + "', need an explicit format specifier")
		}
	}
	return result, nil
}

func exprAdd(a, b *big.Int) (*big.Int, error) { return new(big.Int).Add(a, b), nil }
func exprSub(a, b *big.Int) (*big.Int, error) { return new(big.Int).Sub(a, b), nil }
func exprMul(a, b *big.Int) (*big.Int, error) { return new(big.Int).Mul(a, b), nil }
func exprDiv(a, b *big.Int) (*big.Int, error) {
	if b.Sign() == 0 {
		return nil, errors.New("division by 0")
	}
	return new(big.Int).Quo(a, b), nil
}
func exprMin(a, b *big.Int) (*big.Int, error) {
	if a.Cmp(b) <= 0 {
		return a, nil
	}
	return b, nil
}
func exprMax(a, b *big.Int) (*big.Int, error) {
	if a.Cmp(b) >= 0 {
		return a, nil
	}
	return b, nil
}

var exprFunctions = map[string]func(a, b *big.Int) (*big.Int, error){
	"add": exprAdd,
	"sub": exprSub,
	"mul": exprMul,
	"div": exprDiv,
	"min": exprMin,
	"max": exprMax,
}

// numericBlock is a parsed [[#...]] substitution.
type numericBlock struct {
	defName string
	format  numFormat
	expr    exprNode
	// hasExplicitFormat records a %fmt spec, which for a definition becomes
	// the variable's implicit format.
	hasExplicitFormat bool
}

// value evaluates the block's expression and renders it in the block's
// format.
func (b *numericBlock) value() (string, error) {
	v, err := b.expr.eval()
	if err != nil {
		return "", err
	}
	return b.format.format(v)
}

type parseError struct {
	msg string
	// off is the byte offset of the error within the text handed to the
	// parser, or -1 when the whole text is at fault.
	off int
}

func (e *parseError) Error() string { return e.msg }

func perr(off int, msg string) error { return &parseError{msg: msg, off: off} }

// numericParser walks an expression string, tracking the offset for
// diagnostics.
type numericParser struct {
	src        string
	pos        int
	line       int
	ctx        *varContext
	legacyLine bool
}

func (p *numericParser) rest() string { return p.src[p.pos:] }

func (p *numericParser) skipSpaces() {
	for p.pos < len(p.src) && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t') {
		p.pos++
	}
}

func (p *numericParser) empty() bool {
	p.skipSpaces()
	return p.pos >= len(p.src)
}

func isVarStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isVarChar(c byte) bool {
	return isVarStart(c) || (c >= '0' && c <= '9')
}

// parseVariableName reads a variable name at the start of s, including a
// leading '$' (global) or '@' (pseudo) sigil. It returns the name, whether it
// is a pseudo variable, and the length consumed.
func parseVariableName(s string) (name string, pseudo bool, n int, err error) {
	i := 0
	if i < len(s) && (s[i] == '$' || s[i] == '@') {
		pseudo = s[i] == '@'
		i++
	}
	start := i
	if i < len(s) && isVarStart(s[i]) {
		i++
		for i < len(s) && isVarChar(s[i]) {
			i++
		}
	}
	if i == start {
		return "", false, 0, errors.New("invalid variable name")
	}
	return s[:i], pseudo, i, nil
}

// parseNumericBlock parses the text between "[[#" and "]]".
func parseNumericBlock(src string, line int, ctx *varContext, legacyLine bool) (*numericBlock, error) {
	p := &numericParser{src: src, line: line, ctx: ctx, legacyLine: legacyLine}
	block := &numericBlock{}
	p.skipSpaces()
	if strings.HasPrefix(p.rest(), "%") {
		f, err := p.parseFormat()
		if err != nil {
			return nil, err
		}
		block.format = f
		block.hasExplicitFormat = true
		p.skipSpaces()
		if !strings.HasPrefix(p.rest(), ",") {
			return nil, perr(p.pos, "invalid format specifier in expression")
		}
		p.pos++
	}
	p.skipSpaces()

	// A ':' introduces a variable definition, possibly with a constraint
	// expression after it.
	if idx := strings.IndexByte(p.rest(), ':'); idx >= 0 {
		defStart := p.pos
		defText := strings.TrimRight(p.src[defStart:defStart+idx], " \t")
		name, pseudo, n, err := parseVariableName(defText)
		if err != nil {
			return nil, perr(defStart, "invalid variable name")
		}
		if pseudo {
			return nil, perr(defStart, "definition of pseudo numeric variable unsupported")
		}
		if n != len(defText) {
			return nil, perr(defStart+n, "invalid numeric variable definition")
		}
		block.defName = name
		p.pos = defStart + idx + 1
	}

	if !p.empty() {
		if block.defName != "" && strings.HasPrefix(p.rest(), "==") {
			p.pos += 2
		} else if block.defName != "" && (strings.HasPrefix(p.rest(), "!=") || strings.HasPrefix(p.rest(), "<") || strings.HasPrefix(p.rest(), ">")) {
			return nil, perr(p.pos, "unsupported numeric constraint; only '==' is supported")
		}
		expr, err := p.parseExpression()
		if err != nil {
			return nil, err
		}
		if !p.empty() {
			return nil, perr(p.pos, "unexpected characters at end of expression '"+strings.TrimSpace(p.rest())+"'")
		}
		block.expr = expr
	}

	if !block.hasExplicitFormat {
		if block.expr != nil {
			f, err := block.expr.implicitFormat()
			if err != nil {
				return nil, perr(-1, err.Error())
			}
			block.format = f
		}
		if block.format.kind == fmtNone {
			block.format = numFormat{kind: fmtUnsigned}
		}
	}
	return block, nil
}

func (p *numericParser) parseFormat() (numFormat, error) {
	start := p.pos
	p.pos++ // '%'
	var f numFormat
	if strings.HasPrefix(p.rest(), "#") {
		f.alternate = true
		p.pos++
	}
	if strings.HasPrefix(p.rest(), ".") {
		p.pos++
		digits := 0
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			f.precision = f.precision*10 + int(p.src[p.pos]-'0')
			p.pos++
			digits++
		}
		if digits == 0 {
			return f, perr(p.pos, "invalid precision in format specifier")
		}
	}
	if p.pos >= len(p.src) {
		return f, perr(start, "invalid format specifier in expression")
	}
	switch p.src[p.pos] {
	case 'u':
		f.kind = fmtUnsigned
	case 'd':
		f.kind = fmtSigned
	case 'x':
		f.kind = fmtHexLower
	case 'X':
		f.kind = fmtHexUpper
	default:
		return f, perr(p.pos, "invalid conversion specifier in format specifier")
	}
	p.pos++
	if f.alternate && f.kind != fmtHexLower && f.kind != fmtHexUpper {
		return f, perr(start, "alternate form only supported for hex values")
	}
	return f, nil
}

// parseExpression parses "operand (op operand)*". Like LLVM, every binary
// operator has the same precedence and associates to the left.
func (p *numericParser) parseExpression() (exprNode, error) {
	left, err := p.parseOperand(false)
	if err != nil {
		return nil, err
	}
	for {
		p.skipSpaces()
		if p.pos >= len(p.src) || p.src[p.pos] == ')' || p.src[p.pos] == ',' {
			return left, nil
		}
		opPos := p.pos
		op := p.src[p.pos]
		var fn func(a, b *big.Int) (*big.Int, error)
		switch op {
		case '+':
			fn = exprAdd
		case '-':
			fn = exprSub
		case '*':
			fn = exprMul
		case '/':
			fn = exprDiv
		default:
			return nil, perr(opPos, "unsupported operation '"+string(op)+"'")
		}
		p.pos++
		p.skipSpaces()
		if p.pos >= len(p.src) {
			return nil, perr(p.pos, "missing operand in expression")
		}
		right, err := p.parseOperand(p.legacyLine)
		if err != nil {
			return nil, err
		}
		left = &binopNode{left: left, right: right, fn: fn}
	}
}

func (p *numericParser) parseOperand(legacyLiteralOnly bool) (exprNode, error) {
	p.skipSpaces()
	if p.pos >= len(p.src) {
		return nil, perr(p.pos, "missing operand in expression")
	}
	c := p.src[p.pos]
	if c == '(' && !legacyLiteralOnly {
		p.pos++
		inner, err := p.parseExpression()
		if err != nil {
			return nil, err
		}
		p.skipSpaces()
		if !strings.HasPrefix(p.rest(), ")") {
			return nil, perr(p.pos, "missing ')' at end of nested expression")
		}
		p.pos++
		return inner, nil
	}
	if isVarStart(c) || c == '$' || c == '@' {
		if legacyLiteralOnly {
			return nil, perr(p.pos, "unexpected function call or variable in legacy @LINE expression")
		}
		name, pseudo, n, err := parseVariableName(p.rest())
		if err != nil {
			return nil, perr(p.pos, err.Error())
		}
		namePos := p.pos
		p.pos += n
		p.skipSpaces()
		if !pseudo && strings.HasPrefix(p.rest(), "(") {
			return p.parseCall(name, namePos)
		}
		if pseudo {
			if name != "@LINE" {
				return nil, perr(namePos, "invalid pseudo numeric variable '"+name+"'")
			}
			return &varNode{v: lineVar(p.line)}, nil
		}
		v := p.ctx.numericVariable(name)
		if v.hasLine && v.defLine == p.line {
			return nil, perr(namePos, "numeric variable '"+name+"' defined earlier in the same CHECK directive")
		}
		return &varNode{v: v}, nil
	}
	return p.parseLiteral(legacyLiteralOnly)
}

func (p *numericParser) parseLiteral(decimalOnly bool) (exprNode, error) {
	start := p.pos
	negative := false
	if strings.HasPrefix(p.rest(), "-") {
		negative = true
		p.pos++
	}
	base := 10
	rest := p.rest()
	if !decimalOnly {
		switch {
		case strings.HasPrefix(rest, "0x") || strings.HasPrefix(rest, "0X"):
			base = 16
			p.pos += 2
		case strings.HasPrefix(rest, "0b") || strings.HasPrefix(rest, "0B"):
			base = 2
			p.pos += 2
		case strings.HasPrefix(rest, "0o") || strings.HasPrefix(rest, "0O"):
			base = 8
			p.pos += 2
		case len(rest) > 1 && rest[0] == '0' && rest[1] >= '0' && rest[1] <= '9':
			base = 8
			p.pos++
		}
	}
	digitsStart := p.pos
	for p.pos < len(p.src) && isDigitInBase(p.src[p.pos], base) {
		p.pos++
	}
	if p.pos == digitsStart {
		return nil, perr(start, "invalid operand format '"+strings.TrimSpace(p.src[start:])+"'")
	}
	v, ok := new(big.Int).SetString(p.src[digitsStart:p.pos], base)
	if !ok {
		return nil, perr(start, "invalid operand format")
	}
	if negative {
		v.Neg(v)
	}
	if err := checkRange(v); err != nil {
		return nil, perr(start, "unable to represent numeric value")
	}
	return &literalNode{value: v}, nil
}

func isDigitInBase(c byte, base int) bool {
	switch {
	case c >= '0' && c <= '9':
		return int(c-'0') < base
	case c >= 'a' && c <= 'f':
		return base == 16
	case c >= 'A' && c <= 'F':
		return base == 16
	}
	return false
}

func (p *numericParser) parseCall(name string, namePos int) (exprNode, error) {
	fn, ok := exprFunctions[name]
	if !ok {
		return nil, perr(namePos, "call to undefined function '"+name+"'")
	}
	start := namePos
	p.pos++ // '('
	var args []exprNode
	for {
		p.skipSpaces()
		if strings.HasPrefix(p.rest(), ")") {
			break
		}
		if len(args) > 0 {
			if !strings.HasPrefix(p.rest(), ",") {
				return nil, perr(p.pos, "missing ',' or ')' at end of call expression")
			}
			p.pos++
			p.skipSpaces()
		}
		if p.pos >= len(p.src) {
			return nil, perr(p.pos, "missing ')' at end of call expression")
		}
		arg, err := p.parseExpression()
		if err != nil {
			return nil, err
		}
		args = append(args, arg)
	}
	p.pos++ // ')'
	if len(args) != 2 {
		return nil, perr(start, fmt.Sprintf("function '%s' takes 2 arguments but %d given", name, len(args)))
	}
	return &binopNode{left: args[0], right: args[1], fn: fn}, nil
}
