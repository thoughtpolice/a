// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// filecheck verifies that a text matches the directives of a check file, in
// the manner of LLVM's FileCheck, and additionally runs lit-style RUN: test
// files as Buck2 tests.
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	os.Exit(programMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// invocation is the environment of one command. prog names the subcommand
// in error messages; protocolMode is the internal-runner flag that Buck2
// prepends, -list-tests or -run-test, and is empty for plain invocations.
type invocation struct {
	prog         string
	protocolMode string
	stdin        io.Reader
	stdout       io.Writer
	stderr       io.Writer
}

// failf reports an error under the subcommand's name and returns the exit
// status for usage and setup errors.
func (inv invocation) failf(format string, args ...any) int {
	fmt.Fprintf(inv.stderr, "%s: %s\n", inv.prog, fmt.Sprintf(format, args...))
	return 2
}

func programMain(argv []string, stdin io.Reader, stdout, stderr io.Writer) int {
	inv := invocation{prog: "filecheck", stdin: stdin, stdout: stdout, stderr: stderr}
	if len(argv) > 0 && (argv[0] == "-list-tests" || argv[0] == "-run-test") {
		inv.protocolMode = argv[0]
		argv = argv[1:]
	}
	sub := ""
	if len(argv) > 0 {
		switch argv[0] {
		case "check", "exec", "lit", "help", "version":
			sub = argv[0]
			argv = argv[1:]
		}
	}
	if inv.protocolMode != "" && sub != "lit" {
		return inv.failf("%s is only supported by the lit subcommand", inv.protocolMode)
	}
	switch sub {
	case "help":
		io.WriteString(stdout, checkHelpText)
		return 0
	case "version":
		fmt.Fprintf(stdout, "filecheck %s\n", filecheckVersion)
		return 0
	case "exec":
		return runExec(inv, argv)
	case "lit":
		return runLit(inv, argv)
	}
	if env := os.Getenv("FILECHECK_OPTS"); env != "" {
		argv = append(splitEnvOpts(env), argv...)
	}
	return runCheckCommand(inv, argv)
}

func runCheckCommand(inv invocation, argv []string) int {
	args, err := parseCheckArgs(argv)
	if err != nil {
		return inv.failf("%v", err)
	}
	return runParsedCheck(inv, args)
}

// runParsedCheck is the FileCheck-compatible mode after option parsing.
func runParsedCheck(inv invocation, args *checkArgs) int {
	if args.showHelp {
		io.WriteString(inv.stdout, checkHelpText)
		return 0
	}
	if args.showVersion {
		fmt.Fprintf(inv.stdout, "filecheck %s\n", filecheckVersion)
		return 0
	}
	if args.dumpInput == "help" {
		io.WriteString(inv.stdout, dumpInputHelp)
		return 0
	}
	checkPath, err := args.checkFilePath()
	if err != nil {
		return inv.failf("%v", err)
	}

	var input []byte
	inputName := displayPath(args.inputFile)
	if args.inputFile == "-" {
		inputName = "<stdin>"
		input, err = io.ReadAll(inv.stdin)
	} else {
		input, err = os.ReadFile(args.inputFile)
	}
	if err != nil {
		return inv.failf("could not open input file '%s': %v", args.inputFile, err)
	}
	return checkBytes(inv, args, checkPath, input, inputName)
}

// checkBytes runs the check file over input and reports the exit status.
func checkBytes(inv invocation, args *checkArgs, checkPath string, input []byte, inputName string) int {
	checkData, err := os.ReadFile(checkPath)
	if err != nil {
		return inv.failf("could not open check file '%s': %v", checkPath, err)
	}
	return checkContent(inv, args, checkData, displayPath(checkPath), input, inputName)
}

// displayPath shortens an absolute path under the current directory for
// diagnostics, so they read like the project-relative paths Buck2 prints.
func displayPath(p string) string {
	if !filepath.IsAbs(p) {
		return p
	}
	cwd, err := os.Getwd()
	if err != nil {
		return p
	}
	rel, err := filepath.Rel(cwd, p)
	if err != nil || strings.HasPrefix(rel, "..") {
		return p
	}
	return rel
}

// checkContent runs an in-memory check file over in-memory input.
func checkContent(inv invocation, args *checkArgs, checkData []byte, checkName string, input []byte, inputName string) int {
	color := false
	switch args.color {
	case "always":
		color = true
	case "auto":
		color = isTerminal(inv.stderr)
	}
	out := &diagPrinter{w: inv.stderr, color: color}

	checkBuf := newSourceBuffer(checkName, canonicalize(checkData, args.opts.strictWhitespace))
	ctx := newVarContext()
	if err := ctx.defineCmdlineVariables(args.defines); err != nil {
		return inv.failf("%v", err)
	}
	cf, err := readCheckFile(checkBuf, args.opts, ctx)
	if err != nil {
		if cfe, ok := err.(*checkFileError); ok {
			out.message(checkBuf, cfe.off, 0, diagError, cfe.msg)
		} else {
			out.message(nil, -1, 0, diagError, err.Error())
		}
		return 2
	}

	if len(input) == 0 && !args.allowEmpty {
		fmt.Fprintf(inv.stderr, "filecheck error: '%s' is empty.\n", inputName)
		return 2
	}
	inputBuf := newSourceBuffer(inputName, canonicalize(input, args.opts.strictWhitespace))

	c := &checker{cf: cf, input: inputBuf, verbose: args.verbose, out: out}
	ok := c.checkInput()
	if args.dumpInput == "always" || (args.dumpInput == "fail" && !ok) {
		dumpAnnotatedInput(inv.stderr, inputBuf, checkName, c.diags, args.verbose, dumpOptions{filter: args.dumpFilter, context: args.dumpContext})
	}
	if ok {
		return 0
	}
	return 1
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

const execHelpText = `Run a command and check its output against a check file.

Usage:
  filecheck exec [OPTIONS] CHECK-FILE -- COMMAND [ARGS...]

Options specific to exec (all check options are accepted as well):
      --capture WHAT      Which output to check: stdout (default), stderr, or
                          both (interleaved as produced)
      --stdin FILE        Feed FILE to the command's standard input
      --expect-exit N     Exit status the command must return (default: 0)
      --any-exit          Accept any exit status from the command
      --cwd DIR           Run the command in DIR
      --env NAME=VALUE    Set an environment variable for the command
                          (repeatable)

The command's output is shown when the check fails or the command exits with
an unexpected status.
`

type execArgs struct {
	capture  string
	stdin    string
	expect   int
	anyExit  bool
	cwd      string
	env      []string
	showHelp bool
}

// option handles exec's own options; every other option belongs to the
// checker.
func (e *execArgs) option(s *argScanner, name, value string, hasValue bool) bool {
	switch name {
	case "h", "help":
		e.showHelp = true
	case "capture":
		e.capture = s.choice(name, value, hasValue, "stdout", "stderr", "both")
	case "stdin":
		e.stdin = s.value(name, value, hasValue)
	case "expect-exit":
		e.expect = s.integer(name, value, hasValue)
	case "any-exit":
		e.anyExit = true
	case "cwd":
		e.cwd = s.value(name, value, hasValue)
	case "env":
		k, v := s.assignment(name, value, hasValue)
		e.env = append(e.env, k+"="+v)
	default:
		return false
	}
	return true
}

func runExec(inv invocation, argv []string) int {
	inv.prog = "filecheck exec"
	e := &execArgs{capture: "stdout"}
	args, command, err := parseCheckArgsWith(argv, e.option)
	if err != nil {
		return inv.failf("%v", err)
	}
	if e.showHelp {
		io.WriteString(inv.stdout, execHelpText)
		return 0
	}
	checkPath, err := args.checkFilePath()
	if err != nil {
		return inv.failf("%v", err)
	}
	if len(command) == 0 {
		return inv.failf("expected a command after '--'")
	}

	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = e.cwd
	cmd.Env = append(os.Environ(), e.env...)
	if e.stdin != "" {
		f, err := os.Open(e.stdin)
		if err != nil {
			return inv.failf("%v", err)
		}
		defer f.Close()
		cmd.Stdin = f
	}
	var stdout, stderr, both lockedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	captured := &stdout
	switch e.capture {
	case "stderr":
		captured = &stderr
	case "both":
		cmd.Stdout, cmd.Stderr, captured = &both, &both, &both
	}
	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		if _, isExit := runErr.(*exec.ExitError); !isExit {
			return inv.failf("could not run %q: %v", command[0], runErr)
		}
	}
	if !e.anyExit && exitCode != e.expect {
		fmt.Fprintf(inv.stderr, "filecheck exec: command exited with status %d, expected %d\n", exitCode, e.expect)
		fmt.Fprintf(inv.stderr, "command: %s\n", strings.Join(command, " "))
		dumpCaptured(inv.stderr, "stdout", stdout.Bytes())
		dumpCaptured(inv.stderr, "stderr", stderr.Bytes())
		dumpCaptured(inv.stderr, "output", both.Bytes())
		return 1
	}
	inputName := "<" + e.capture + " of " + command[0] + ">"
	status := checkBytes(inv, args, checkPath, captured.Bytes(), inputName)
	if status != 0 {
		fmt.Fprintf(inv.stderr, "command: %s\n", strings.Join(command, " "))
		if e.capture == "stdout" {
			dumpCaptured(inv.stderr, "stderr", stderr.Bytes())
		}
	}
	return status
}

func dumpCaptured(w io.Writer, name string, data []byte) {
	if len(data) == 0 {
		return
	}
	fmt.Fprintf(w, "--- %s ---\n", name)
	w.Write(data)
	if !bytes.HasSuffix(data, []byte("\n")) {
		fmt.Fprintln(w)
	}
	fmt.Fprintf(w, "--- end %s ---\n", name)
}
