// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// srclint checks source files for an SPDX license header and for trailing
// whitespace and a missing final newline, and Starlark files for loads that
// name a .bzl file by its path rather than as a target.
//
// It does not find the files itself. The build graph does: every target
// declared through the shims gets a srclint test over its own sources (see
// buck/shims/srclint.bzl), which runs this tool in two steps. A build action
// runs `srclint check` and records what it found, so a target's sources are
// only read again when they change, and the test runs `srclint report` to
// print that record and pass or fail on it.
//
//	srclint check --manifest MANIFEST --out REPORT
//	srclint report REPORT
//	srclint FILE...
//
// The last form checks the named files directly and prints the problems.
package main

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

const usage = `usage:
  srclint check --manifest MANIFEST --out REPORT
  srclint report REPORT
  srclint FILE...`

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "check":
		err = runCheck(args[1:], stderr)
	case "report":
		if len(args) != 2 {
			fmt.Fprintln(stderr, usage)
			return 2
		}
		var r report
		if r, err = readReport(args[1]); err == nil {
			return printReport(r, stdout)
		}
	case "-h", "-help", "--help":
		fmt.Fprintln(stdout, usage)
		return 0
	default:
		files := make([]manifestFile, len(args))
		for i, path := range args {
			files[i] = manifestFile{Path: path, SPDX: true, Whitespace: true}
		}
		var r report
		if r, err = check(manifest{Files: files}); err == nil {
			return printReport(r, stdout)
		}
	}
	if err != nil {
		fmt.Fprintf(stderr, "srclint: %v\n", err)
		return 1
	}
	return 0
}

// A manifest names the files to check and which checks apply to each. The
// srclint_test rule writes it, so its paths are relative to the project root,
// which is where Buck2 runs actions.
type manifest struct {
	Label string         `json:"label"`
	Files []manifestFile `json:"files"`
}

type manifestFile struct {
	Path       string `json:"path"`
	SPDX       bool   `json:"spdx"`
	Whitespace bool   `json:"whitespace"`
}

// A report is what checking a manifest found.
type report struct {
	Label    string    `json:"label"`
	Checked  int       `json:"checked"`
	Problems []problem `json:"problems"`
}

// A problem is one thing wrong with one file. Line is 1-based, and 0 when the
// problem is with the file as a whole.
type problem struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Check   string `json:"check"`
	Message string `json:"message"`
}

func (p problem) String() string {
	if p.Line == 0 {
		return fmt.Sprintf("%s: [%s] %s", p.Path, p.Check, p.Message)
	}
	return fmt.Sprintf("%s:%d: [%s] %s", p.Path, p.Line, p.Check, p.Message)
}

func runCheck(args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("srclint check", flag.ContinueOnError)
	flags.SetOutput(stderr)
	manifestPath := flags.String("manifest", "", "the JSON manifest of files to check")
	out := flags.String("out", "", "where to write the JSON report")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *out == "" || flags.NArg() != 0 {
		return errors.New("check needs --manifest and --out, and no other arguments")
	}
	data, err := os.ReadFile(*manifestPath)
	if err != nil {
		return err
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("%s: %w", *manifestPath, err)
	}
	r, err := check(m)
	if err != nil {
		return err
	}
	data, err = json.Marshal(r, jsontext.WithIndent("  "))
	if err != nil {
		return err
	}
	return os.WriteFile(*out, append(data, '\n'), 0o644)
}

// check runs the checks m asks for, and the load check on every Starlark
// file, which has no exceptions. A file that cannot be read is an error
// rather than a problem: it means the build handed over something it should
// not have, not that the file needs fixing.
func check(m manifest) (report, error) {
	r := report{Label: m.Label, Problems: []problem{}}
	for _, f := range m.Files {
		if !f.SPDX && !f.Whitespace && !isStarlark(f.Path) {
			continue
		}
		data, err := os.ReadFile(f.Path)
		if err != nil {
			return report{}, err
		}
		r.Checked++
		if f.SPDX {
			r.Problems = append(r.Problems, spdxProblems(f.Path, data)...)
		}
		if f.Whitespace {
			r.Problems = append(r.Problems, whitespaceProblems(f.Path, data)...)
		}
		r.Problems = append(r.Problems, loadProblems(f.Path, data)...)
	}
	slices.SortStableFunc(r.Problems, func(a, b problem) int {
		return strings.Compare(a.Path, b.Path)
	})
	return r, nil
}

func readReport(path string) (report, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return report{}, err
	}
	var r report
	if err := json.Unmarshal(data, &r); err != nil {
		return report{}, fmt.Errorf("%s: %w", path, err)
	}
	return r, nil
}

// printReport prints r and returns the exit status it calls for.
func printReport(r report, w io.Writer) int {
	what := "files"
	if r.Label != "" {
		what = "files of " + r.Label
	}
	if len(r.Problems) == 0 {
		fmt.Fprintf(w, "srclint: checked %d %s; no problems\n", r.Checked, what)
		return 0
	}
	for _, p := range r.Problems {
		fmt.Fprintln(w, p)
	}
	fmt.Fprintf(w, "srclint: checked %d %s; found %d problems\n", r.Checked, what, len(r.Problems))
	return 1
}
