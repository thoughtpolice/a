// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command rust-project connects rust-analyzer to Buck (see README.md).
// rust-analyzer knows nothing of BUILD files, so it runs this program to
// find out which crates a file belongs to and what to build for diagnostics:
//
//	rust-project discover ARG   rust-analyzer's workspace discovery: ARG is
//	                            {"path": FILE}, {"buildfile": FILE} or
//	                            {"label": TARGET}; prints progress, then the
//	                            rust-project.json of the Rust targets it names
//	rust-project check FILE     the diagnostics of the targets owning FILE,
//	                            one rustc JSON message per line, for
//	                            rust-analyzer's check-on-save
//
// Buck does the querying and building (rust.bxl); this program turns its
// answer into what rust-analyzer reads.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const bxl = "toolchains//rust/lsp/rust.bxl"

func usage() {
	fmt.Fprintln(os.Stderr, "usage: rust-project discover [-max-extra N] '{\"path\": FILE}'")
	fmt.Fprintln(os.Stderr, "       rust-project check [-clippy=false] FILE")
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "discover":
		discoverMain(os.Args[2:])
	case "check":
		checkMain(os.Args[2:])
	default:
		usage()
	}
}

// The argument rust-analyzer's discovery passes in place of {arg}: one of
// the three keys.
type discoverArg struct {
	Path      string `json:"path"`
	Buildfile string `json:"buildfile"`
	Label     string `json:"label"`
}

// emit prints one line of the discovery protocol, an object whose "kind" is
// "progress", "error" or "finished".
func emit(kind string, fields map[string]any) {
	fields["kind"] = kind
	line, err := json.Marshal(fields)
	if err != nil {
		panic(err)
	}
	os.Stdout.Write(append(line, '\n'))
}

func discoverMain(args []string) {
	fs := flag.NewFlagSet("discover", flag.ExitOnError)
	maxExtra := fs.Int("max-extra", 50, "load up to this many other Rust targets of the BUILD files involved")
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}

	// rust-analyzer shows an "error" line to the user and drops the
	// workspace; the exit status is not looked at.
	if err := discover(fs.Arg(0), *maxExtra); err != nil {
		emit("error", map[string]any{"error": err.Error()})
	}
}

func discover(raw string, maxExtra int) error {
	var arg discoverArg
	if err := json.Unmarshal([]byte(raw), &arg); err != nil {
		return fmt.Errorf("expected {\"path\": ...}, {\"buildfile\": ...} or {\"label\": ...}, got %q: %v", raw, err)
	}

	var bxlArgs []string
	var dir, what string
	switch {
	case arg.Path != "":
		file := absolute(arg.Path)
		bxlArgs, dir, what = []string{"--file", file}, filepath.Dir(file), file
	case arg.Buildfile != "":
		file := absolute(arg.Buildfile)
		bxlArgs, dir, what = []string{"--buildfile", file}, filepath.Dir(file), file
	case arg.Label != "":
		bxlArgs, dir, what = []string{"--label", arg.Label}, ".", arg.Label
	default:
		return fmt.Errorf("expected {\"path\": ...}, {\"buildfile\": ...} or {\"label\": ...}, got %q", raw)
	}
	bxlArgs = append(bxlArgs, "--max_extra", strconv.Itoa(maxExtra))

	root, err := projectRoot(dir)
	if err != nil {
		return err
	}

	emit("progress", map[string]any{"message": "building the crates of " + what})
	out, err := buck(root, append([]string{"bxl", "--console=simple", bxl + ":crates", "--"}, bxlArgs...)...)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(strings.TrimSpace(string(out)))
	if err != nil {
		return err
	}
	var in buckCrates
	if err := json.Unmarshal(data, &in); err != nil {
		return fmt.Errorf("reading %s: %v", strings.TrimSpace(string(out)), err)
	}
	if len(in.Roots) == 0 {
		if arg.Path != "" {
			return fmt.Errorf("no Rust target owns %s", what)
		}
		return fmt.Errorf("no Rust targets in %s", what)
	}

	emit("progress", map[string]any{"message": "finding the sysroot"})
	sysroot, err := findSysroot(in.Rustc, root)
	if err != nil {
		return err
	}

	project, err := assemble(&in, root, sysroot)
	if err != nil {
		return err
	}
	emit("finished", map[string]any{"buildfile": in.Buildfiles[0], "project": project})
	return nil
}

func checkMain(args []string) {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	clippy := fs.Bool("clippy", true, "report clippy's lints as well as rustc's diagnostics")
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}
	if err := check(absolute(fs.Arg(0)), *clippy); err != nil {
		fmt.Fprintln(os.Stderr, "rust-project:", err)
		os.Exit(1)
	}
}

func check(file string, clippy bool) error {
	root, err := projectRoot(filepath.Dir(file))
	if err != nil {
		return err
	}
	out, err := buck(root, "bxl", "--console=simple", bxl+":check", "--", "--file", file, "--clippy", strconv.FormatBool(clippy))
	if err != nil {
		return err
	}
	var result struct {
		Diagnostics []string `json:"diagnostics"`
		Root        string   `json:"root"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return fmt.Errorf("reading %s's output: %v", bxl+":check", err)
	}
	var contents [][]byte
	for _, path := range result.Diagnostics {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		contents = append(contents, data)
	}
	lines, err := diagnostics(contents, result.Root)
	if err != nil {
		return err
	}
	for _, line := range lines {
		os.Stdout.Write(append(line, '\n'))
	}
	return nil
}

func absolute(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

// projectRoot is the Buck project holding dir. Every Buck command runs
// there, so that the cell aliases this program names, such as toolchains//,
// are the root cell's.
func projectRoot(dir string) (string, error) {
	out, err := run(dir, "buck2", "root", "--kind", "project")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// buck runs buck2 in the daemon the environment selects, and returns its
// stdout. Its stderr is kept back unless it fails:
// rust-analyzer shows a check command's stderr as an error.
func buck(root string, args ...string) ([]byte, error) {
	return run(root, "buck2", args...)
}

func run(dir, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	// rust-analyzer runs its check command with RUST_BACKTRACE set, and a
	// Buck daemon that starts with it set is much slower.
	cmd.Env = without(os.Environ(), "RUST_BACKTRACE", "RUST_LIB_BACKTRACE")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("%s failed (%v):\n%s", strings.Join(cmd.Args, " "), err, stderr.String())
		}
		return nil, err
	}
	return out, nil
}

func without(env []string, names ...string) []string {
	var out []string
outer:
	for _, kv := range env {
		for _, name := range names {
			if strings.HasPrefix(kv, name+"=") {
				continue outer
			}
		}
		out = append(out, kv)
	}
	return out
}
