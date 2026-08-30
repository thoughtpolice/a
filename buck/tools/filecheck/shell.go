// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// A small shell for RUN: lines, modeled on lit's internal shell: pipelines,
// &&, ||, ;, redirections, quoting, and a set of builtins. It needs no
// /bin/sh, so RUN lines behave the same on every platform and never depend
// on what the host happens to have installed.

type tokKind int

const (
	tokWord tokKind = iota
	tokPipe
	tokAndAnd
	tokOrOr
	tokSemi
	tokRedirect
)

type token struct {
	kind tokKind
	text string
	// For redirects: the descriptor being redirected and the operator.
	fd int
	op string
}

type shellSyntaxError struct{ msg string }

func (e *shellSyntaxError) Error() string { return e.msg }

// lexShell splits a command line into tokens.
func lexShell(line string) ([]token, error) {
	var toks []token
	i := 0
	n := len(line)
	for i < n {
		c := line[i]
		if c == ' ' || c == '\t' {
			i++
			continue
		}
		switch c {
		case ';':
			toks = append(toks, token{kind: tokSemi, text: ";"})
			i++
			continue
		case '|':
			if i+1 < n && line[i+1] == '|' {
				toks = append(toks, token{kind: tokOrOr, text: "||"})
				i += 2
			} else {
				toks = append(toks, token{kind: tokPipe, text: "|"})
				i++
			}
			continue
		case '&':
			if i+1 < n && line[i+1] == '&' {
				toks = append(toks, token{kind: tokAndAnd, text: "&&"})
				i += 2
				continue
			}
			if i+1 < n && line[i+1] == '>' {
				op := "&>"
				i += 2
				if i < n && line[i] == '>' {
					op = "&>>"
					i++
				}
				toks = append(toks, token{kind: tokRedirect, fd: 1, op: op})
				continue
			}
			return nil, &shellSyntaxError{msg: "background commands ('&') are not supported"}
		case '<', '>':
			fd := 0
			if c == '>' {
				fd = 1
			}
			tok, adv, err := lexRedirect(line[i:], fd)
			if err != nil {
				return nil, err
			}
			toks = append(toks, tok)
			i += adv
			continue
		}
		// A descriptor number immediately before a redirect operator.
		if c >= '0' && c <= '9' && i+1 < n && (line[i+1] == '>' || line[i+1] == '<') {
			tok, adv, err := lexRedirect(line[i+1:], int(c-'0'))
			if err != nil {
				return nil, err
			}
			toks = append(toks, tok)
			i += 1 + adv
			continue
		}
		word, adv, err := lexWord(line[i:])
		if err != nil {
			return nil, err
		}
		toks = append(toks, token{kind: tokWord, text: word})
		i += adv
	}
	return toks, nil
}

func lexRedirect(s string, fd int) (token, int, error) {
	switch {
	case strings.HasPrefix(s, ">>"):
		return token{kind: tokRedirect, fd: fd, op: ">>"}, 2, nil
	case strings.HasPrefix(s, ">&"):
		return token{kind: tokRedirect, fd: fd, op: ">&"}, 2, nil
	case strings.HasPrefix(s, "<<"):
		return token{}, 0, &shellSyntaxError{msg: "here-documents ('<<') are not supported"}
	case strings.HasPrefix(s, "<&"):
		return token{kind: tokRedirect, fd: fd, op: "<&"}, 2, nil
	case strings.HasPrefix(s, ">"):
		return token{kind: tokRedirect, fd: fd, op: ">"}, 1, nil
	default:
		return token{kind: tokRedirect, fd: fd, op: "<"}, 1, nil
	}
}

// lexWord reads one word with shell quoting: '...' is literal, "..." allows
// \" and \\, and a backslash outside quotes escapes the next character.
func lexWord(s string) (string, int, error) {
	var b strings.Builder
	i := 0
	for i < len(s) {
		c := s[i]
		switch c {
		case ' ', '\t', ';', '|', '&', '<', '>':
			return b.String(), i, nil
		case '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				return "", 0, &shellSyntaxError{msg: "unterminated single quote"}
			}
			b.WriteString(s[i+1 : i+1+end])
			i += end + 2
		case '"':
			i++
			closed := false
			for i < len(s) {
				if s[i] == '"' {
					closed = true
					i++
					break
				}
				if s[i] == '\\' && i+1 < len(s) && (s[i+1] == '"' || s[i+1] == '\\') {
					b.WriteByte(s[i+1])
					i += 2
					continue
				}
				b.WriteByte(s[i])
				i++
			}
			if !closed {
				return "", 0, &shellSyntaxError{msg: "unterminated double quote"}
			}
		case '\\':
			if i+1 < len(s) {
				b.WriteByte(s[i+1])
				i += 2
			} else {
				b.WriteByte('\\')
				i++
			}
		default:
			// Digits directly before a redirect operator belong to it.
			if c >= '0' && c <= '9' && b.Len() == 0 && i+1 < len(s) && (s[i+1] == '>' || s[i+1] == '<') {
				return b.String(), i, nil
			}
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), i, nil
}

type redirect struct {
	fd     int
	op     string
	target string
}

type simpleCommand struct {
	args      []string
	assigns   []string
	redirects []redirect
}

type pipeline struct {
	commands []*simpleCommand
}

// listEntry is a pipeline together with the operator that joins it to the
// previous one: "", "&&", "||", or ";".
type listEntry struct {
	op string
	pl *pipeline
}

// parseShell parses a command line into a list of pipelines.
func parseShell(line string) ([]listEntry, error) {
	toks, err := lexShell(line)
	if err != nil {
		return nil, err
	}
	var list []listEntry
	op := ""
	i := 0
	for i < len(toks) {
		pl := &pipeline{}
		for {
			cmd := &simpleCommand{}
			for i < len(toks) {
				t := toks[i]
				if t.kind == tokWord {
					if len(cmd.args) == 0 && isAssignment(t.text) {
						cmd.assigns = append(cmd.assigns, t.text)
					} else {
						cmd.args = append(cmd.args, t.text)
					}
					i++
					continue
				}
				if t.kind == tokRedirect {
					i++
					if i >= len(toks) || toks[i].kind != tokWord {
						return nil, &shellSyntaxError{msg: "missing target for redirection '" + t.op + "'"}
					}
					cmd.redirects = append(cmd.redirects, redirect{fd: t.fd, op: t.op, target: toks[i].text})
					i++
					continue
				}
				break
			}
			if len(cmd.args) == 0 && len(cmd.assigns) == 0 {
				return nil, &shellSyntaxError{msg: "empty command"}
			}
			pl.commands = append(pl.commands, cmd)
			if i < len(toks) && toks[i].kind == tokPipe {
				i++
				continue
			}
			break
		}
		list = append(list, listEntry{op: op, pl: pl})
		if i >= len(toks) {
			break
		}
		switch toks[i].kind {
		case tokAndAnd:
			op = "&&"
		case tokOrOr:
			op = "||"
		case tokSemi:
			op = ";"
		default:
			return nil, &shellSyntaxError{msg: "unexpected token '" + toks[i].text + "'"}
		}
		i++
		if i >= len(toks) {
			if op == ";" {
				break
			}
			return nil, &shellSyntaxError{msg: "missing command after '" + op + "'"}
		}
	}
	return list, nil
}

func isAssignment(w string) bool {
	eq := strings.IndexByte(w, '=')
	if eq <= 0 {
		return false
	}
	name := w[:eq]
	if !isVarStart(name[0]) {
		return false
	}
	for i := 1; i < len(name); i++ {
		if !isVarChar(name[i]) {
			return false
		}
	}
	return true
}

// shell is the persistent state of one test's RUN lines.
type shell struct {
	cwd string
	env map[string]string
}

func newShell(cwd string, env map[string]string) *shell {
	sh := &shell{cwd: cwd, env: map[string]string{}}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			sh.env[k] = v
		}
	}
	for k, v := range env {
		sh.env[k] = v
	}
	return sh
}

// Environment edits use NAME=VALUE to assign and a bare NAME to unset.
func (sh *shell) environ(extra []string) []string {
	merged := map[string]string{}
	for k, v := range sh.env {
		merged[k] = v
	}
	for _, kv := range extra {
		if k, v, ok := strings.Cut(kv, "="); ok {
			merged[k] = v
		} else {
			delete(merged, kv)
		}
	}
	out := make([]string, 0, len(merged))
	for _, k := range slices.Sorted(maps.Keys(merged)) {
		out = append(out, k+"="+merged[k])
	}
	return out
}

func (sh *shell) lookupEnv(name string, extra []string) (string, bool) {
	for i := len(extra) - 1; i >= 0; i-- {
		k, v, assigned := strings.Cut(extra[i], "=")
		if k == name {
			return v, assigned
		}
	}
	v, ok := sh.env[name]
	return v, ok
}

// resolve makes a path absolute relative to the shell's directory.
func (sh *shell) resolve(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(sh.cwd, p)
}

// execError reports a failure to run a command at all (as opposed to a
// command that ran and failed).
type execError struct{ msg string }

func (e *execError) Error() string { return e.msg }

// run executes a full command line. Output goes to stdout and stderr; the
// returned status is that of the last pipeline executed.
func (sh *shell) run(line string, stdout, stderr io.Writer) (int, error) {
	list, err := parseShell(line)
	if err != nil {
		return 127, err
	}
	return sh.runList(list, stdout, stderr)
}

// runList executes an already parsed command line.
func (sh *shell) runList(list []listEntry, stdout, stderr io.Writer) (int, error) {
	status := 0
	for idx, entry := range list {
		if idx > 0 {
			if entry.op == "&&" && status != 0 {
				continue
			}
			if entry.op == "||" && status == 0 {
				continue
			}
		}
		var err error
		status, err = sh.runPipeline(entry.pl, stdout, stderr)
		if err != nil {
			return status, err
		}
	}
	return status, nil
}

// stage is one command of a pipeline with its streams resolved.
type stage struct {
	cmd    *simpleCommand
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	closer []io.Closer
	// pipeIn is the read end feeding this stage from the previous one; it
	// is closed when the stage exits so an upstream writer does not block.
	pipeIn *io.PipeReader
}

func (sh *shell) runPipeline(pl *pipeline, stdout, stderr io.Writer) (int, error) {
	n := len(pl.commands)
	for _, cmd := range pl.commands {
		if len(cmd.args) > 0 && (cmd.args[0] == "cd" || cmd.args[0] == "export") && n > 1 {
			return 127, &execError{msg: "'" + cmd.args[0] + "' cannot be part of a pipeline"}
		}
	}

	stages := make([]*stage, n)
	var prevReader *io.PipeReader
	for i, cmd := range pl.commands {
		st := &stage{cmd: cmd, stdin: strings.NewReader(""), stdout: stdout, stderr: stderr}
		if prevReader != nil {
			st.stdin = prevReader
			st.pipeIn = prevReader
		}
		if i < n-1 {
			pr, pw := io.Pipe()
			st.stdout = pw
			st.closer = append(st.closer, pw)
			prevReader = pr
		}
		if err := sh.applyRedirects(st); err != nil {
			for _, s := range stages[:i] {
				s.close()
			}
			st.close()
			return 127, err
		}
		stages[i] = st
	}

	if n == 1 {
		st := stages[0]
		cmd := st.cmd
		if len(cmd.args) > 0 {
			switch cmd.args[0] {
			case "cd":
				defer st.close()
				return sh.builtinCd(cmd.args[1:], st.stderr)
			case "export":
				defer st.close()
				return sh.builtinExport(cmd.args[1:], st.stderr)
			}
		} else {
			defer st.close()
			// Bare assignments set shell variables after redirects succeed.
			for _, a := range cmd.assigns {
				k, v, _ := strings.Cut(a, "=")
				sh.env[k] = v
			}
			return 0, nil
		}
	}

	statuses := make([]int, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i, st := range stages {
		wg.Add(1)
		go func(i int, st *stage) {
			defer wg.Done()
			statuses[i], errs[i] = sh.runStage(st)
			st.close()
		}(i, st)
	}
	wg.Wait()

	status := 0
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			return 127, errs[i]
		}
		// pipefail: the pipeline fails if any stage fails, reporting the
		// rightmost failure.
		if statuses[i] != 0 {
			status = statuses[i]
		}
	}
	return status, nil
}

func (st *stage) close() {
	for _, c := range st.closer {
		c.Close()
	}
	if st.pipeIn != nil {
		st.pipeIn.Close()
	}
}

func (sh *shell) applyRedirects(st *stage) error {
	for _, r := range st.cmd.redirects {
		switch r.op {
		case "<":
			f, err := os.Open(sh.resolve(r.target))
			if err != nil {
				return &execError{msg: err.Error()}
			}
			st.stdin = f
			st.closer = append(st.closer, f)
		case ">", ">>", "&>", "&>>":
			flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
			if r.op == ">>" || r.op == "&>>" {
				flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
			}
			f, err := os.OpenFile(sh.resolve(r.target), flags, 0o644)
			if err != nil {
				return &execError{msg: err.Error()}
			}
			st.closer = append(st.closer, f)
			if r.op == "&>" || r.op == "&>>" {
				st.stdout = f
				st.stderr = f
			} else if r.fd == 2 {
				st.stderr = f
			} else {
				st.stdout = f
			}
		case ">&":
			target, err := strconv.Atoi(r.target)
			if err != nil || (target != 1 && target != 2) {
				return &execError{msg: "unsupported redirection '" + r.op + r.target + "'"}
			}
			var w io.Writer = st.stdout
			if target == 2 {
				w = st.stderr
			}
			if r.fd == 2 {
				st.stderr = w
			} else {
				st.stdout = w
			}
		default:
			return &execError{msg: "unsupported redirection '" + r.op + "'"}
		}
	}
	return nil
}

// runStage runs one command with its streams. Builtins execute in-process.
func (sh *shell) runStage(st *stage) (status int, err error) {
	args := st.cmd.args
	extraEnv := st.cmd.assigns
	negate := false
	defer func() {
		if err == nil && negate {
			if status == 0 {
				status = 1
			} else {
				status = 0
			}
		}
	}()
	for {
		if len(args) == 0 {
			return 0, nil
		}
		switch args[0] {
		case "not":
			if len(args) > 1 && args[1] == "--crash" {
				return 127, &execError{msg: "'not --crash' is not supported"}
			}
			negate = !negate
			args = args[1:]
			continue
		case "env":
			var rest []string
			i := 1
			for i < len(args) {
				a := args[i]
				if a == "-u" && i+1 < len(args) {
					rest = append(rest, args[i+1])
					i += 2
					continue
				}
				if strings.HasPrefix(a, "-u") && len(a) > 2 {
					rest = append(rest, a[2:])
					i++
					continue
				}
				if isAssignment(a) {
					rest = append(rest, a)
					i++
					continue
				}
				break
			}
			extraEnv = append(extraEnv, rest...)
			args = args[i:]
			if len(args) == 0 {
				for _, kv := range sh.environ(extraEnv) {
					fmt.Fprintln(st.stdout, kv)
				}
				return 0, nil
			}
			continue
		}
		break
	}
	return sh.runCommand(args, extraEnv, st.stdin, st.stdout, st.stderr)
}

func (sh *shell) runCommand(args []string, extraEnv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	name := args[0]
	switch name {
	case "filecheck", "FileCheck":
		return sh.builtinFileCheck(args[1:], extraEnv, stdin, stdout, stderr), nil
	case "echo":
		return builtinEcho(args[1:], stdout), nil
	case "cat":
		return sh.builtinCat(args[1:], stdin, stdout, stderr), nil
	case "true", ":":
		return 0, nil
	case "false":
		return 1, nil
	case "mkdir":
		return sh.builtinMkdir(args[1:], stderr), nil
	case "rm":
		return sh.builtinRm(args[1:], stderr), nil
	case "diff":
		return sh.builtinDiff(args[1:], stdin, stdout, stderr), nil
	case "count":
		return builtinCount(args[1:], stdin, stderr), nil
	case "cd", "export":
		return 127, &execError{msg: "'" + name + "' cannot be part of a pipeline"}
	}
	return sh.runExternal(args, extraEnv, stdin, stdout, stderr)
}

func (sh *shell) runExternal(args []string, extraEnv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	path := args[0]
	if strings.ContainsAny(path, `/\`) {
		path = sh.resolve(path)
	} else {
		found := ""
		if searchPath, ok := sh.lookupEnv("PATH", extraEnv); ok {
			dirs := filepath.SplitList(searchPath)
			if searchPath == "" {
				dirs = []string{""}
			}
			for _, dir := range dirs {
				// Resolve relative PATH entries in the test's current directory,
				// not the runner's. Looking up this explicit path only checks
				// whether the candidate is executable; it cannot use host PATH.
				candidate := sh.resolve(filepath.Join(dir, path))
				if executable, err := exec.LookPath(candidate); err == nil {
					found = executable
					break
				}
			}
		}
		if found == "" {
			return 127, &execError{msg: "command not found: " + args[0]}
		}
		path = found
	}
	cmd := exec.Command(path, args[1:]...)
	cmd.Dir = sh.cwd
	cmd.Env = sh.environ(extraEnv)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			// The process ran; the error came from copying its output
			// (typically a downstream stage that stopped reading).
			return cmd.ProcessState.ExitCode(), nil
		}
		return 127, &execError{msg: "could not run " + args[0] + ": " + err.Error()}
	}
	return 0, nil
}

// MARK: Builtins

func (sh *shell) builtinCd(args []string, stderr io.Writer) (int, error) {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "cd: expected exactly one argument")
		return 1, nil
	}
	dir := sh.resolve(args[0])
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		fmt.Fprintf(stderr, "cd: %s: not a directory\n", args[0])
		return 1, nil
	}
	sh.cwd = dir
	return 0, nil
}

func (sh *shell) builtinExport(args []string, stderr io.Writer) (int, error) {
	if len(args) != 1 || !isAssignment(args[0]) {
		fmt.Fprintln(stderr, "export: expected exactly one NAME=VALUE argument")
		return 1, nil
	}
	k, v, _ := strings.Cut(args[0], "=")
	sh.env[k] = v
	return 0, nil
}

func builtinEcho(args []string, stdout io.Writer) int {
	newline := true
	escapes := false
	for len(args) > 0 {
		switch args[0] {
		case "-n":
			newline = false
		case "-e":
			escapes = true
		case "-ne", "-en":
			newline = false
			escapes = true
		default:
			goto body
		}
		args = args[1:]
	}
body:
	text := strings.Join(args, " ")
	if escapes {
		text = interpretEscapes(text)
	}
	if newline {
		text += "\n"
	}
	io.WriteString(stdout, text)
	return 0
}

func interpretEscapes(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		i++
		switch s[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case '\\':
			b.WriteByte('\\')
		case '0':
			b.WriteByte(0)
		default:
			b.WriteByte('\\')
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func (sh *shell) builtinCat(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		args = []string{"-"}
	}
	status := 0
	for _, a := range args {
		if a == "-" {
			io.Copy(stdout, stdin)
			continue
		}
		data, err := os.ReadFile(sh.resolve(a))
		if err != nil {
			fmt.Fprintf(stderr, "cat: %v\n", err)
			status = 1
			continue
		}
		stdout.Write(data)
	}
	return status
}

func (sh *shell) builtinMkdir(args []string, stderr io.Writer) int {
	parents := false
	var paths []string
	for _, a := range args {
		if a == "-p" {
			parents = true
		} else {
			paths = append(paths, a)
		}
	}
	if len(paths) == 0 {
		fmt.Fprintln(stderr, "mkdir: missing operand")
		return 1
	}
	status := 0
	for _, p := range paths {
		var err error
		if parents {
			err = os.MkdirAll(sh.resolve(p), 0o755)
		} else {
			err = os.Mkdir(sh.resolve(p), 0o755)
		}
		if err != nil {
			fmt.Fprintf(stderr, "mkdir: %v\n", err)
			status = 1
		}
	}
	return status
}

func (sh *shell) builtinRm(args []string, stderr io.Writer) int {
	recursive, force := false, false
	var paths []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") && len(a) > 1 && !strings.HasPrefix(a, "--") {
			for _, f := range a[1:] {
				switch f {
				case 'r', 'R':
					recursive = true
				case 'f':
					force = true
				default:
					fmt.Fprintf(stderr, "rm: unsupported option -%c\n", f)
					return 1
				}
			}
			continue
		}
		paths = append(paths, a)
	}
	if len(paths) == 0 {
		fmt.Fprintln(stderr, "rm: missing operand")
		return 1
	}
	status := 0
	for _, p := range paths {
		full := sh.resolve(p)
		info, err := os.Lstat(full)
		if err != nil {
			if !force {
				fmt.Fprintf(stderr, "rm: %v\n", err)
				status = 1
			}
			continue
		}
		if info.IsDir() {
			if !recursive {
				fmt.Fprintf(stderr, "rm: %s: is a directory\n", p)
				status = 1
				continue
			}
			err = os.RemoveAll(full)
		} else {
			err = os.Remove(full)
		}
		if err != nil {
			fmt.Fprintf(stderr, "rm: %v\n", err)
			status = 1
		}
	}
	return status
}

func builtinCount(args []string, stdin io.Reader, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "count: expected exactly one argument")
		return 2
	}
	want, err := strconv.Atoi(args[0])
	if err != nil || want < 0 {
		fmt.Fprintf(stderr, "count: invalid count '%s'\n", args[0])
		return 2
	}
	data, _ := io.ReadAll(stdin)
	got := strings.Count(string(data), "\n")
	if len(data) > 0 && data[len(data)-1] != '\n' {
		got++
	}
	if got != want {
		fmt.Fprintf(stderr, "count: expected %d lines, got %d\n", want, got)
		return 1
	}
	return 0
}

// builtinFileCheck runs the checker in-process. Relative file arguments are
// resolved against the shell's directory, which the checker does not track.
func (sh *shell) builtinFileCheck(argv, extraEnv []string, stdin io.Reader, stdout, stderr io.Writer) int {
	inv := invocation{prog: "filecheck", stdin: stdin, stdout: stdout, stderr: stderr}
	if len(argv) > 0 && argv[0] == "exec" {
		fmt.Fprintln(stderr, "filecheck: 'exec' is not available from RUN lines; use a pipeline instead")
		return 2
	}
	if len(argv) > 0 && argv[0] == "check" {
		argv = argv[1:]
	}
	if opts, _ := sh.lookupEnv("FILECHECK_OPTS", extraEnv); opts != "" {
		argv = append(splitEnvOpts(opts), argv...)
	}
	args, err := parseCheckArgs(argv)
	if err != nil {
		return inv.failf("%v", err)
	}
	for i, p := range args.positional {
		args.positional[i] = sh.resolve(p)
	}
	if args.inputFile != "-" {
		args.inputFile = sh.resolve(args.inputFile)
	}
	return runParsedCheck(inv, args)
}
