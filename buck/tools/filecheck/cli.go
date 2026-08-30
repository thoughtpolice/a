// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

const filecheckVersion = "0.1.0"

const checkHelpText = `Check that an input text file contains the patterns of a check file.

Usage:
  filecheck [OPTIONS] CHECK-FILE
  filecheck check [OPTIONS] CHECK-FILE
  filecheck exec [OPTIONS] CHECK-FILE -- COMMAND [ARGS...]
  filecheck lit [OPTIONS] TEST-FILE...

The first two forms read the checked text from --input-file (stdin by
default), matching LLVM's FileCheck. "exec" runs COMMAND and checks its
output instead; "lit" runs the RUN: lines of each TEST-FILE. See
"filecheck exec --help" and "filecheck lit --help".

Check options:
      --check-prefix PREFIX     Directive prefix to look for (repeatable;
                                default: CHECK)
      --check-prefixes A,B      Comma-separated form of --check-prefix
      --comment-prefixes A,B    Prefixes whose lines are ignored
                                (default: COM,RUN)
      --input-file FILE         Text to check; "-" reads stdin (default)
      --match-full-lines        Patterns must match whole lines
      --strict-whitespace       Do not canonicalize horizontal whitespace
      --ignore-case             Match patterns case-insensitively
      --implicit-check-not PAT  Fail if PAT occurs anywhere between positive
                                checks (repeatable)
      --enable-var-scope        Forget non-$ variables at each CHECK-LABEL
  -D NAME=VALUE                 Define a string variable; -D#NAME=EXPR defines
                                a numeric one
      --allow-empty             Accept an empty input
      --allow-unused-prefixes   Do not fail when a prefix has no directives
      --allow-deprecated-dag-overlap
                                Let CHECK-DAG matches overlap
      --dump-input MODE         help, always, fail (default), or never
      --dump-input-filter MODE  all, annotation-full, annotation, or error
                                (default)
      --dump-input-context N    Context lines in the dump (default: 5)
  -v, -vv                       Report matches; -vv also reports discarded
                                CHECK-DAG matches and CHECK-NOT searches
      --color[=WHEN]            always, never, or auto (default)
      --version                 Print the version and exit
  -h, --help                    Print this help and exit

FILECHECK_OPTS in the environment is prepended to the arguments.

Exit status is 0 when every check passes, 1 when a check fails, and 2 for
usage errors or a malformed check file.
`

// checkArgs are the parsed FileCheck-compatible options.
type checkArgs struct {
	opts        checkOptions
	inputFile   string
	defines     []string
	dumpInput   string
	dumpFilter  string
	dumpContext int
	verbose     int
	color       string
	allowEmpty  bool
	showHelp    bool
	showVersion bool
	positional  []string
}

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usageErrorf(format string, args ...any) error {
	return &usageError{msg: fmt.Sprintf(format, args...)}
}

// argScanner walks argv the way LLVM's cl::opt does: --opt=value, --opt
// value, and their single-dash spellings. Plain arguments collect in
// positional and everything after a bare "--" in rest. The first error is
// kept in err, after which the accessors return zero values.
type argScanner struct {
	argv []string
	i    int
	// arg is the argument next returned last, for messages.
	arg        string
	positional []string
	rest       []string
	err        error
}

// next returns the next option's name and any value attached with '='. It
// reports false at the end of argv or at "--".
func (s *argScanner) next() (name, value string, hasValue, ok bool) {
	for s.i < len(s.argv) {
		s.arg = s.argv[s.i]
		s.i++
		if s.arg == "--" {
			s.rest = s.argv[s.i:]
			s.i = len(s.argv)
			return "", "", false, false
		}
		if s.arg == "-" || !strings.HasPrefix(s.arg, "-") {
			s.positional = append(s.positional, s.arg)
			continue
		}
		// -DNAME=VALUE has its value attached without '='.
		if strings.HasPrefix(s.arg, "-D") && !strings.HasPrefix(s.arg, "--") && len(s.arg) > 2 {
			return "D", s.arg[2:], true, true
		}
		name = strings.TrimLeft(s.arg, "-")
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			return name[:eq], name[eq+1:], true, true
		}
		return name, "", false, true
	}
	return "", "", false, false
}

func (s *argScanner) fail(format string, args ...any) {
	if s.err == nil {
		s.err = usageErrorf(format, args...)
	}
}

// value returns the value of an option: attached after '=' or the next
// argument.
func (s *argScanner) value(name, attached string, hasAttached bool) string {
	if hasAttached {
		return attached
	}
	if s.i >= len(s.argv) {
		s.fail("option '%s' requires a value", name)
		return ""
	}
	v := s.argv[s.i]
	s.i++
	return v
}

// choice is value restricted to the given spellings.
func (s *argScanner) choice(name, attached string, hasAttached bool, allowed ...string) string {
	v := s.value(name, attached, hasAttached)
	if s.err == nil && !slices.Contains(allowed, v) {
		last := len(allowed) - 1
		s.fail("invalid value '%s' for --%s (want %s, or %s)", v, name, strings.Join(allowed[:last], ", "), allowed[last])
	}
	return v
}

// integer is value parsed as a decimal integer.
func (s *argScanner) integer(name, attached string, hasAttached bool) int {
	v := s.value(name, attached, hasAttached)
	if s.err != nil {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		s.fail("invalid value '%s' for --%s", v, name)
	}
	return n
}

// assignment is value split at its '=' into NAME and VALUE.
func (s *argScanner) assignment(name, attached string, hasAttached bool) (string, string) {
	v := s.value(name, attached, hasAttached)
	k, val, ok := strings.Cut(v, "=")
	if s.err == nil && (!ok || k == "") {
		s.fail("invalid --%s value '%s': expected NAME=VALUE", name, v)
	}
	return k, val
}

// boolean is the value of a flag that may be spelled --flag, --flag=true or
// --flag=false.
func (s *argScanner) boolean(name, attached string, hasAttached bool) bool {
	if !hasAttached {
		return true
	}
	switch strings.ToLower(attached) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	s.fail("invalid value '%s' for boolean option '%s'", attached, name)
	return false
}

func newCheckArgs() *checkArgs {
	return &checkArgs{
		opts:        defaultCheckOptions(),
		inputFile:   "-",
		dumpInput:   "fail",
		dumpFilter:  "error",
		dumpContext: 5,
		color:       "auto",
	}
}

// addPrefixes adds check prefixes, replacing the default CHECK on first use.
func (a *checkArgs) addPrefixes(prefixes ...string) {
	if a.opts.defaultPrefix {
		a.opts.checkPrefixes, a.opts.defaultPrefix = nil, false
	}
	a.opts.checkPrefixes = append(a.opts.checkPrefixes, prefixes...)
}

// checkFilePath returns the check file, the single positional argument.
func (a *checkArgs) checkFilePath() (string, error) {
	if len(a.positional) != 1 {
		return "", usageErrorf("expected exactly one check file, got %d", len(a.positional))
	}
	return a.positional[0], nil
}

// optionHook lets a subcommand claim options ahead of the checker's own. It
// reports whether it handled the option.
type optionHook func(s *argScanner, name, value string, hasValue bool) bool

// parseCheckArgs parses the FileCheck-compatible option set. As in LLVM, a
// bare "--" only ends option parsing.
func parseCheckArgs(argv []string) (*checkArgs, error) {
	a, rest, err := parseCheckArgsWith(argv, nil)
	if err != nil {
		return nil, err
	}
	a.positional = append(a.positional, rest...)
	return a, nil
}

// parseCheckArgsWith parses the FileCheck-compatible option set for a
// subcommand that has options of its own, offered to extra first. The
// arguments after a bare "--" are returned separately.
func parseCheckArgsWith(argv []string, extra optionHook) (*checkArgs, []string, error) {
	a := newCheckArgs()
	s := &argScanner{argv: argv}
	for s.err == nil {
		name, value, hasValue, ok := s.next()
		if !ok {
			break
		}
		if extra != nil && extra(s, name, value, hasValue) {
			continue
		}
		switch name {
		case "h", "help":
			a.showHelp = true
		case "version":
			a.showVersion = true
		case "D":
			a.defines = append(a.defines, s.value(name, value, hasValue))
		case "check-prefix":
			a.addPrefixes(s.value(name, value, hasValue))
		case "check-prefixes":
			a.addPrefixes(strings.Split(s.value(name, value, hasValue), ",")...)
		case "comment-prefixes":
			a.opts.commentPrefixes = nil
			if v := s.value(name, value, hasValue); v != "" {
				a.opts.commentPrefixes = strings.Split(v, ",")
			}
		case "input-file":
			a.inputFile = s.value(name, value, hasValue)
		case "implicit-check-not":
			a.opts.implicitCheckNot = append(a.opts.implicitCheckNot, s.value(name, value, hasValue))
		case "dump-input":
			a.dumpInput = s.choice(name, value, hasValue, "help", "always", "fail", "never")
		case "dump-input-filter":
			a.dumpFilter = s.choice(name, value, hasValue, "all", "annotation-full", "annotation", "error")
		case "dump-input-context":
			if a.dumpContext = s.integer(name, value, hasValue); a.dumpContext < 0 {
				s.fail("invalid value '%d' for --dump-input-context", a.dumpContext)
			}
		case "color":
			switch {
			case !hasValue:
				a.color = "always"
			case value == "true" || value == "1":
				a.color = "always"
			case value == "false" || value == "0":
				a.color = "never"
			default:
				a.color = s.choice(name, value, hasValue, "always", "never", "auto")
			}
		case "no-color":
			a.color = "never"
		case "v":
			a.verbose = max(a.verbose, 1)
		case "vv":
			a.verbose = 2
		case "match-full-lines":
			a.opts.matchFullLines = s.boolean(name, value, hasValue)
		case "strict-whitespace":
			a.opts.strictWhitespace = s.boolean(name, value, hasValue)
		case "ignore-case":
			a.opts.ignoreCase = s.boolean(name, value, hasValue)
		case "enable-var-scope":
			a.opts.enableVarScope = s.boolean(name, value, hasValue)
		case "allow-empty":
			a.allowEmpty = s.boolean(name, value, hasValue)
		case "allow-unused-prefixes":
			a.opts.allowUnusedPrefix = s.boolean(name, value, hasValue)
		case "allow-deprecated-dag-overlap":
			a.opts.allowDeprecatedDag = s.boolean(name, value, hasValue)
		default:
			s.fail("unknown option '%s'", s.arg)
		}
	}
	if s.err != nil {
		return nil, nil, s.err
	}
	a.positional = s.positional
	return a, s.rest, nil
}

// splitEnvOpts splits FILECHECK_OPTS on whitespace, honoring simple quotes.
func splitEnvOpts(s string) []string {
	var out []string
	var cur strings.Builder
	inWord := false
	quote := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else {
				cur.WriteByte(c)
			}
		case c == '"' || c == '\'':
			quote = c
			inWord = true
		case c == ' ' || c == '\t' || c == '\n':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out
}
