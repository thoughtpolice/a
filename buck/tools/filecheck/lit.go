// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// lit mode: test files carry their own RUN: lines, as in LLVM's lit. Under
// Buck2's internal test runner every file is a listed case and every RUN
// line reports a result of its own.

const litHelpText = `Run the RUN: lines of lit-style test files.

Usage:
  filecheck lit [OPTIONS] TEST-FILE...
  filecheck -list-tests lit [OPTIONS] TEST-FILE...
  filecheck -run-test lit [OPTIONS] TEST-FILE... FILTER

FILTER is a test file's index in the list or its name.

Options:
      --manifest FILE       JSON produced by the Buck2 rule: tools, defines,
                            features, env, and the owning package
      --tool NAME=PATH      Make %NAME and %{NAME} expand to PATH (repeatable)
  -D, --define NAME=VALUE   Make %{NAME} expand to VALUE (repeatable)
      --feature NAME        Declare a feature for REQUIRES:/UNSUPPORTED:/XFAIL:
                            (repeatable)
      --env NAME=VALUE      Environment for commands (repeatable)
      --package PATH        Strip PATH/ from test names
      --cwd DIR             Directory RUN lines start in (default: the
                            project root, or the current directory)
      --keep-tmp            Keep %t files after each test
  -v                        Show the output of every RUN line
  -h, --help                Print this help and exit

Test files may contain, on any line:
  RUN: <command>            Executed by the internal shell; a trailing '\'
                            continues on the next RUN: line
  REQUIRES: <expr>, ...     Skip unless every expression holds
  UNSUPPORTED: <expr>, ...  Skip if any expression holds
  XFAIL: <expr>, ... | *    The test is expected to fail
  DEFINE: %{name} = value   Per-file substitution; REDEFINE: replaces one
  END.                      Stop looking for directives

Substitutions: %s (test file), %S/%p (its directory), %t (a temp file path),
%T (the temp directory), %basename_t, %{pathsep}, %%, %filecheck (this
executable), %NAME for each tool, %{NAME} for tools and defines, and
%(line), %(line+N), %(line-N).

The shell understands pipes, &&, ||, ;, quoting, and redirections, and
provides these builtins: FileCheck (or filecheck, run in-process), not, env,
echo, cat, diff, mkdir, rm, cd, export, count, true, false, and ':'. Every
pipeline runs with pipefail semantics.

Features available to every test: filecheck, system-<os>, and the CPU
architecture (x86_64 or aarch64).

Under Buck2 (-list-tests / -run-test) results follow the dynamic_test line
protocol; otherwise a lit-style summary is printed and the exit status is 1
when any test fails.
`

type litArgs struct {
	manifest string
	// root is the project root the manifest's artifact paths are relative
	// to, once loaded.
	root     string
	tools    map[string][]string
	defines  map[string]string
	features []string
	env      map[string]string
	pkg      string
	files    []string
	keepTmp  bool
	verbose  bool
	cwd      string
	showHelp bool
}

type litManifest struct {
	Tools    map[string][]string `json:"tools"`
	Defines  map[string]string   `json:"defines"`
	Features []string            `json:"features"`
	Env      map[string]string   `json:"env"`
	Package  string              `json:"package"`
}

// defs.bzl marks artifact paths before writing the manifest, including paths
// embedded in arguments. Resolve them before quoting so a RUN can change cwd
// without changing the meaning of tool paths or ordinary literal arguments.
const projectRootMarker = "__FILECHECK_PROJECT_ROOT__/"

func parseLitArgs(argv []string) (*litArgs, error) {
	a := &litArgs{tools: map[string][]string{}, defines: map[string]string{}, env: map[string]string{}}
	s := &argScanner{argv: argv}
	for s.err == nil {
		name, value, hasValue, ok := s.next()
		if !ok {
			break
		}
		switch name {
		case "h", "help":
			a.showHelp = true
		case "v":
			a.verbose = true
		case "keep-tmp":
			a.keepTmp = true
		case "manifest":
			a.manifest = s.value(name, value, hasValue)
		case "package":
			a.pkg = s.value(name, value, hasValue)
		case "cwd":
			a.cwd = s.value(name, value, hasValue)
		case "feature":
			a.features = append(a.features, s.value(name, value, hasValue))
		case "tool", "define", "D", "env":
			k, v := s.assignment(name, value, hasValue)
			switch name {
			case "tool":
				a.tools[k] = []string{v}
			case "env":
				a.env[k] = v
			default:
				a.defines[k] = v
			}
		default:
			s.fail("unknown option '%s'", s.arg)
		}
	}
	if s.err != nil {
		return nil, s.err
	}
	a.files = append(s.positional, s.rest...)
	return a, nil
}

// projectRootFromPath finds the directory containing a "buck-out" component
// of p, which is the project root for any artifact path Buck2 hands us.
func projectRootFromPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return ""
	}
	dir := abs
	for {
		parent := filepath.Dir(dir)
		if filepath.Base(dir) == "buck-out" {
			return parent
		}
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// loadManifest reads the manifest written by defs.bzl. Its artifact paths
// are relative to the project root, which is where the manifest's own
// buck-out sits; a manifest written by hand elsewhere is taken to be
// relative to the current directory.
func (a *litArgs) loadManifest() error {
	if a.manifest == "" {
		return nil
	}
	data, err := os.ReadFile(a.manifest)
	if err != nil {
		return err
	}
	var m litManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("%s: %v", a.manifest, err)
	}

	a.root = projectRootFromPath(a.manifest)
	if a.root == "" {
		if a.root, err = filepath.Abs("."); err != nil {
			return err
		}
	}
	root := strings.TrimSuffix(filepath.ToSlash(a.root), "/") + "/"
	resolveArtifactPaths := func(arg string) string {
		return strings.ReplaceAll(arg, projectRootMarker, root)
	}
	for name, argv := range m.Tools {
		if len(argv) == 0 {
			return fmt.Errorf("%s: tool %q has no command", a.manifest, name)
		}
		for i, arg := range argv {
			argv[i] = resolveArtifactPaths(arg)
		}
		a.tools[name] = argv
	}
	for k, v := range m.Defines {
		if _, exists := a.defines[k]; !exists {
			a.defines[k] = resolveArtifactPaths(v)
		}
	}
	a.features = append(a.features, m.Features...)
	for k, v := range m.Env {
		if _, exists := a.env[k]; !exists {
			a.env[k] = v
		}
	}
	if a.pkg == "" {
		a.pkg = m.Package
	}
	return nil
}

// litTest is one parsed test file.
type litTest struct {
	path        string
	name        string
	runs        []runLine
	xfail       []string
	requires    []string
	unsupported []string
	defines     []substitution
	parseErr    error
}

type runLine struct {
	line int
	text string
	// defines is the per-file substitution table as it stood at this line,
	// so a REDEFINE: only affects the RUN: lines after it.
	defines []substitution
}

type substitution struct {
	from, to string
}

var litKeywords = []string{"RUN:", "XFAIL:", "REQUIRES:", "UNSUPPORTED:", "ALLOW_RETRIES:", "DEFINE:", "REDEFINE:", "END."}

var lineNumberRe = regexp.MustCompile(`%\(line(?: *([+-]) *(\d+))?\)`)

var defineNameRe = regexp.MustCompile(`^%\{[_a-zA-Z][-_:.0-9a-zA-Z]*\}$`)

func parseLitTest(path, name string, data []byte) *litTest {
	t := &litTest{path: path, name: name}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	continued := "" // keyword whose previous line ended with '\'
	continuedDefine := -1
	for idx, raw := range lines {
		lineNo := idx + 1
		keyword := ""
		at := -1
		for _, k := range litKeywords {
			if i := strings.Index(raw, k); i >= 0 && (at < 0 || i < at) {
				at, keyword = i, k
			}
		}
		if at < 0 {
			if continued != "" {
				t.parseErr = fmt.Errorf("%s:%d: expected a %s line to continue the previous one", path, lineNo, continued)
				return t
			}
			continue
		}
		rest := strings.TrimSpace(raw[at+len(keyword):])
		if continued != "" && keyword != continued {
			t.parseErr = fmt.Errorf("%s:%d: expected a %s line to continue the previous one", path, lineNo, continued)
			return t
		}
		switch keyword {
		case "END.":
			if rest == "" {
				return t
			}
		case "RUN:":
			rest = lineNumberRe.ReplaceAllStringFunc(rest, func(m string) string {
				sub := lineNumberRe.FindStringSubmatch(m)
				n := lineNo
				if sub[1] != "" {
					d, _ := strconv.Atoi(sub[2])
					if sub[1] == "+" {
						n += d
					} else {
						n -= d
					}
				}
				return strconv.Itoa(n)
			})
			if continued != "" {
				last := &t.runs[len(t.runs)-1]
				last.text = strings.TrimSuffix(last.text, "\\") + rest
			} else {
				t.runs = append(t.runs, runLine{line: lineNo, text: rest, defines: append([]substitution{}, t.defines...)})
			}
			continued = ""
			if strings.HasSuffix(rest, "\\") {
				continued = "RUN:"
			}
		case "XFAIL:":
			t.xfail = append(t.xfail, splitDirectiveList(rest)...)
		case "REQUIRES:":
			t.requires = append(t.requires, splitDirectiveList(rest)...)
		case "UNSUPPORTED:":
			t.unsupported = append(t.unsupported, splitDirectiveList(rest)...)
		case "ALLOW_RETRIES:":
			// Accepted for compatibility; Buck2 owns retry policy.
		case "DEFINE:", "REDEFINE:":
			if continued != "" {
				last := &t.defines[continuedDefine]
				last.to = strings.TrimSuffix(last.to, "\\") + rest
				continued = ""
				if strings.HasSuffix(rest, "\\") {
					continued = keyword
				} else {
					continuedDefine = -1
				}
				continue
			}
			name, value, ok := strings.Cut(rest, "=")
			name = strings.TrimSpace(name)
			value = strings.TrimSpace(value)
			if !ok || !defineNameRe.MatchString(name) {
				t.parseErr = fmt.Errorf("%s:%d: %s expects '%%{name} = value'", path, lineNo, keyword)
				return t
			}
			existing := slices.IndexFunc(t.defines, func(d substitution) bool { return d.from == name })
			if keyword == "DEFINE:" && existing >= 0 {
				t.parseErr = fmt.Errorf("%s:%d: %s already defined; use REDEFINE:", path, lineNo, name)
				return t
			}
			if keyword == "REDEFINE:" && existing < 0 {
				t.parseErr = fmt.Errorf("%s:%d: %s is not defined; use DEFINE:", path, lineNo, name)
				return t
			}
			if existing >= 0 {
				t.defines[existing].to = value
			} else {
				existing = len(t.defines)
				t.defines = append(t.defines, substitution{from: name, to: value})
			}
			if strings.HasSuffix(value, "\\") {
				continued = keyword
				continuedDefine = existing
			}
		}
	}
	if continued != "" {
		t.parseErr = fmt.Errorf("%s: %s line ends with '\\' but nothing follows", path, continued)
	}
	return t
}

func splitDirectiveList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// litRunner executes tests with a fixed configuration.
type litRunner struct {
	tools    map[string][]string
	defines  map[string]string
	features map[string]bool
	env      map[string]string
	cwd      string
	keepTmp  bool
}

// selfExecutable is the path of this binary, which %filecheck expands to.
var selfExecutable = sync.OnceValue(func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return exe
})

type runOutcome struct {
	line     int
	cmd      string
	status   int
	stdout   string
	stderr   string
	err      error
	duration time.Duration
}

type testResult struct {
	test     *litTest
	status   string // PASS, FAIL, XFAIL, XPASS, UNSUPPORTED, UNRESOLVED
	message  string
	runs     []runOutcome
	duration time.Duration
}

func (r *testResult) failed() bool {
	return r.status == "FAIL" || r.status == "XPASS" || r.status == "UNRESOLVED"
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if !strings.ContainsAny(s, " \t'\"\\|&;<>$`") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func quoteArgv(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		parts[i] = shellQuote(a)
	}
	return strings.Join(parts, " ")
}

// substitutions builds the expansion table for one test.
func (r *litRunner) substitutions(t *litTest, tmpDir string) []substitution {
	abs, err := filepath.Abs(t.path)
	if err != nil {
		abs = t.path
	}
	dir := filepath.Dir(abs)
	base := filepath.Base(abs)
	tmpFile := filepath.Join(tmpDir, base+".tmp")
	slash := filepath.ToSlash
	subs := []substitution{
		{"%s", abs}, {"%S", dir}, {"%p", dir}, {"%t", tmpFile}, {"%T", tmpDir},
		{"%basename_t", base + ".tmp"},
		{"%/s", slash(abs)}, {"%/S", slash(dir)}, {"%/p", slash(dir)}, {"%/t", slash(tmpFile)}, {"%/T", slash(tmpDir)},
		{"%{pathsep}", string(os.PathListSeparator)},
		{"%{s:basename}", base},
	}
	if exe := selfExecutable(); exe != "" {
		subs = append(subs, substitution{"%filecheck", shellQuote(exe)}, substitution{"%{filecheck}", shellQuote(exe)})
	}
	for name, argv := range r.tools {
		subs = append(subs, substitution{"%" + name, quoteArgv(argv)}, substitution{"%{" + name + "}", quoteArgv(argv)})
	}
	for name, value := range r.defines {
		subs = append(subs, substitution{"%{" + name + "}", value})
	}
	// Longer names first so %tool is never clobbered by %t.
	sort.SliceStable(subs, func(i, j int) bool { return len(subs[i].from) > len(subs[j].from) })
	return subs
}

const percentMarker = "\x00PERCENT\x00"

func expandRunLine(text string, perTest []substitution, global []substitution) string {
	out := strings.ReplaceAll(text, "%%", percentMarker)
	// Per-file DEFINEs expand most recent first, so a later definition can
	// use an earlier one.
	for i := len(perTest) - 1; i >= 0; i-- {
		out = strings.ReplaceAll(out, perTest[i].from, perTest[i].to)
	}
	for _, s := range global {
		out = strings.ReplaceAll(out, s.from, s.to)
	}
	return strings.ReplaceAll(out, percentMarker, "%")
}

func (r *litRunner) evalList(exprs []string) (bool, string, error) {
	for _, e := range exprs {
		if e == "*" {
			return true, e, nil
		}
		v, err := evalBoolExpr(e, r.features)
		if err != nil {
			return false, e, err
		}
		if v {
			return true, e, nil
		}
	}
	return false, "", nil
}

func (r *litRunner) runTest(t *litTest) *testResult {
	start := time.Now()
	res := &testResult{test: t}
	defer func() { res.duration = time.Since(start) }()
	if t.parseErr != nil {
		res.status = "UNRESOLVED"
		res.message = t.parseErr.Error()
		return res
	}
	if hit, expr, err := r.evalList(t.unsupported); err != nil {
		res.status = "UNRESOLVED"
		res.message = "invalid UNSUPPORTED expression '" + expr + "': " + err.Error()
		return res
	} else if hit {
		res.status = "UNSUPPORTED"
		res.message = "unsupported: " + expr
		return res
	}
	for _, e := range t.requires {
		v, err := evalBoolExpr(e, r.features)
		if err != nil {
			res.status = "UNRESOLVED"
			res.message = "invalid REQUIRES expression '" + e + "': " + err.Error()
			return res
		}
		if !v {
			res.status = "UNSUPPORTED"
			res.message = "missing feature: " + e
			return res
		}
	}
	xfail, xfailExpr, err := r.evalList(t.xfail)
	if err != nil {
		res.status = "UNRESOLVED"
		res.message = "invalid XFAIL expression '" + xfailExpr + "': " + err.Error()
		return res
	}
	if len(t.runs) == 0 {
		res.status = "UNRESOLVED"
		res.message = "test has no RUN: lines"
		return res
	}

	tmpDir, err := os.MkdirTemp("", "filecheck-lit-")
	if err != nil {
		res.status = "UNRESOLVED"
		res.message = "could not create temporary directory: " + err.Error()
		return res
	}
	if !r.keepTmp {
		defer os.RemoveAll(tmpDir)
	}
	// Every RUN line is expanded and parsed before the first one runs, so a
	// syntax error is reported even after an earlier line fails.
	global := r.substitutions(t, tmpDir)
	type command struct {
		text string
		list []listEntry
	}
	commands := make([]command, len(t.runs))
	for i, run := range t.runs {
		text := expandRunLine(run.text, run.defines, global)
		list, err := parseShell(text)
		if err != nil {
			res.status = "UNRESOLVED"
			res.message = fmt.Sprintf("RUN: at line %d: shell parser error: %v", run.line, err)
			return res
		}
		commands[i] = command{text, list}
	}
	sh := newShell(r.cwd, r.env)
	passed := true
	for i, run := range t.runs {
		var stdout, stderr lockedBuffer
		runStart := time.Now()
		status, err := sh.runList(commands[i].list, &stdout, &stderr)
		outcome := runOutcome{line: run.line, cmd: commands[i].text, status: status, stdout: stdout.String(), stderr: stderr.String(), err: err, duration: time.Since(runStart)}
		res.runs = append(res.runs, outcome)
		if err != nil || status != 0 {
			passed = false
			break
		}
	}
	switch {
	case passed && xfail:
		res.status = "XPASS"
		res.message = "unexpectedly passed (XFAIL: " + xfailExpr + ")"
	case passed:
		res.status = "PASS"
	case xfail:
		res.status = "XFAIL"
		res.message = "expected failure (XFAIL: " + xfailExpr + ")"
	default:
		res.status = "FAIL"
		last := res.runs[len(res.runs)-1]
		if last.err != nil {
			res.message = fmt.Sprintf("RUN: at line %d: %v", last.line, last.err)
		} else {
			res.message = fmt.Sprintf("RUN: at line %d exited with status %d", last.line, last.status)
		}
	}
	return res
}

const maxDetailBytes = 256 * 1024

func truncateOutput(s string) string {
	if len(s) <= maxDetailBytes {
		return s
	}
	return s[:maxDetailBytes] + fmt.Sprintf("\n... [%d more bytes truncated]\n", len(s)-maxDetailBytes)
}

// details renders the lit-style failure report for a test.
func (res *testResult) details(all bool) string {
	var b strings.Builder
	if res.message != "" && (res.failed() || res.status == "UNSUPPORTED" || res.status == "XFAIL") {
		fmt.Fprintf(&b, "%s\n", res.message)
	}
	if len(res.runs) == 0 {
		return b.String()
	}
	b.WriteString("Script:\n--\n")
	for _, run := range res.runs {
		fmt.Fprintf(&b, "RUN: at line %d\n%s\n", run.line, run.cmd)
	}
	b.WriteString("--\n")
	runs := res.runs
	if !all {
		runs = res.runs[len(res.runs)-1:]
	}
	for _, run := range runs {
		if len(runs) > 1 {
			fmt.Fprintf(&b, "\nRUN: at line %d\n", run.line)
		}
		if run.err != nil {
			fmt.Fprintf(&b, "Error: %v\n", run.err)
		}
		fmt.Fprintf(&b, "Exit Code: %d\n", run.status)
		section := func(stream, text string) {
			if text == "" {
				return
			}
			fmt.Fprintf(&b, "\nCommand Output (%s):\n--\n%s", stream, truncateOutput(text))
			if !strings.HasSuffix(text, "\n") {
				b.WriteString("\n")
			}
			b.WriteString("--\n")
		}
		section("stdout", run.stdout)
		section("stderr", run.stderr)
	}
	return b.String()
}

func runLit(inv invocation, argv []string) int {
	inv.prog = "filecheck lit"
	args, err := parseLitArgs(argv)
	if err != nil {
		return inv.failf("%v", err)
	}
	if args.showHelp {
		io.WriteString(inv.stdout, litHelpText)
		return 0
	}
	if err := args.loadManifest(); err != nil {
		return inv.failf("%v", err)
	}
	// `buck2 run` starts the runner wherever it was invoked; RUN lines expect
	// the project root, as under `buck2 test`.
	if args.root != "" {
		if cwd, err := os.Getwd(); err == nil && cwd != args.root {
			if err := os.Chdir(args.root); err != nil {
				return inv.failf("cannot enter project root %s: %v", args.root, err)
			}
		}
	}

	filter := ""
	files := args.files
	if inv.protocolMode == "-run-test" {
		if len(files) == 0 {
			return inv.failf("-run-test requires a test filter")
		}
		filter = files[len(files)-1]
		files = files[:len(files)-1]
	}
	if len(files) == 0 {
		return inv.failf("no test files given")
	}

	names := make([]string, len(files))
	prefix := ""
	if args.pkg != "" {
		prefix = strings.TrimSuffix(filepath.ToSlash(args.pkg), "/") + "/"
	}
	for i, f := range files {
		// `buck2 run` hands out absolute paths; name tests by their
		// project-relative path either way.
		names[i] = strings.TrimPrefix(filepath.ToSlash(displayPath(f)), prefix)
	}

	if inv.protocolMode == "-list-tests" {
		// The filter is the file's index, so the name is the only part of a
		// listing line that the whitespace-delimited protocol constrains.
		for i, name := range names {
			if strings.ContainsAny(name, " \t\n") {
				return inv.failf("test name %q contains whitespace, which the runner protocol cannot carry", name)
			}
			fmt.Fprintf(inv.stdout, "test: %d %s\n", i, name)
		}
		return 0
	}

	cwd := args.cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	cwd, _ = filepath.Abs(cwd)
	features := map[string]bool{}
	for _, f := range hostFeatures() {
		features[f] = true
	}
	for _, f := range args.features {
		features[f] = true
	}
	for name := range args.tools {
		features["tool-"+name] = true
	}
	runner := &litRunner{
		tools:    args.tools,
		defines:  args.defines,
		features: features,
		env:      args.env,
		cwd:      cwd,
		keepTmp:  args.keepTmp,
	}

	load := func(i int) *litTest {
		data, err := os.ReadFile(files[i])
		if err != nil {
			return &litTest{path: files[i], name: names[i], parseErr: err}
		}
		return parseLitTest(files[i], names[i], data)
	}

	if inv.protocolMode == "-run-test" {
		idx, err := strconv.Atoi(filter)
		if err != nil || idx < 0 || idx >= len(files) {
			idx = slices.Index(names, filter)
		}
		if idx < 0 {
			return inv.failf("no test matches filter %q", filter)
		}
		res := runner.runTest(load(idx))
		return emitProtocolResults(inv.stdout, res)
	}

	return runBatch(inv, runner, files, names, load, args)
}

func formatSeconds(d time.Duration) string {
	return strconv.FormatFloat(d.Seconds(), 'f', 3, 64)
}

func writeDetails(w io.Writer, text string) {
	if text == "" {
		return
	}
	for _, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		fmt.Fprintf(w, "result-details: %s\n", line)
	}
}

// emitResult prints one result line of the dynamic_test protocol; duration
// is in seconds, or "-" when unknown.
func emitResult(w io.Writer, status, name, duration, message string) {
	fmt.Fprintf(w, "result: %s %s %s %s\n", status, name, duration, message)
}

// emitProtocolResults prints one test's results in the dynamic_test line
// protocol and returns the process exit status.
func emitProtocolResults(w io.Writer, res *testResult) int {
	name := res.test.name
	failed := false
	switch res.status {
	case "UNSUPPORTED":
		emitResult(w, "SKIP", name, "-", res.message)
	case "UNRESOLVED":
		emitResult(w, "FAIL", name, formatSeconds(res.duration), res.message)
		writeDetails(w, res.details(true))
		failed = true
	case "XFAIL":
		emitResult(w, "PASS", name, formatSeconds(res.duration), res.message)
		writeDetails(w, res.details(false))
	case "XPASS":
		emitResult(w, "FAIL", name, formatSeconds(res.duration), res.message)
		writeDetails(w, res.details(true))
		failed = true
	default:
		// Execution stops at the first failing RUN line, so it is the last
		// one recorded and the test's own report describes it.
		for _, run := range res.runs {
			item := fmt.Sprintf("%s:%d", name, run.line)
			if run.err == nil && run.status == 0 {
				emitResult(w, "PASS", item, formatSeconds(run.duration), fmt.Sprintf("RUN: at line %d", run.line))
				continue
			}
			emitResult(w, "FAIL", item, formatSeconds(run.duration), fmt.Sprintf("RUN: at line %d exited with status %d", run.line, run.status))
			writeDetails(w, res.details(false))
		}
		if res.status == "FAIL" {
			// RUN lines after the failure never ran.
			for _, run := range res.test.runs[len(res.runs):] {
				emitResult(w, "SKIP", fmt.Sprintf("%s:%d", name, run.line), "-", fmt.Sprintf("not run: RUN: at line %d failed", res.runs[len(res.runs)-1].line))
			}
			emitResult(w, "FAIL", name, formatSeconds(res.duration), res.message)
			failed = true
		} else {
			emitResult(w, "PASS", name, formatSeconds(res.duration), fmt.Sprintf("%d RUN lines", len(res.runs)))
		}
	}
	if failed {
		return 1
	}
	return 0
}

func runBatch(inv invocation, runner *litRunner, files, names []string, load func(int) *litTest, args *litArgs) int {
	start := time.Now()
	counts := map[string]int{}
	failed := false
	label := func(name string) string {
		if args.pkg != "" {
			return args.pkg + " :: " + name
		}
		return name
	}
	for i := range files {
		res := runner.runTest(load(i))
		counts[res.status]++
		fmt.Fprintf(inv.stdout, "%s: %s (%d of %d)\n", res.status, label(names[i]), i+1, len(files))
		show := res.failed() || args.verbose
		if show {
			fmt.Fprintf(inv.stdout, "%s TEST '%s' %s %s\n", strings.Repeat("*", 20), label(names[i]), res.status, strings.Repeat("*", 20))
			fmt.Fprint(inv.stdout, res.details(args.verbose))
			fmt.Fprintf(inv.stdout, "\n%s\n", strings.Repeat("*", 20))
		} else if res.status == "UNSUPPORTED" || res.status == "XFAIL" {
			fmt.Fprintf(inv.stdout, "    %s\n", res.message)
		}
		if res.failed() {
			failed = true
		}
	}
	fmt.Fprintf(inv.stdout, "\nTesting Time: %.2fs\n", time.Since(start).Seconds())
	order := []struct{ status, title string }{
		{"UNSUPPORTED", "Unsupported"},
		{"PASS", "Passed"},
		{"XFAIL", "Expectedly Failed"},
		{"UNRESOLVED", "Unresolved"},
		{"FAIL", "Failed"},
		{"XPASS", "Unexpectedly Passed"},
	}
	for _, o := range order {
		if counts[o.status] > 0 {
			fmt.Fprintf(inv.stdout, "  %-20s: %d\n", o.title, counts[o.status])
		}
	}
	if failed {
		return 1
	}
	return 0
}
