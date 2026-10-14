// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// barf runs HTTP scenario scripts: a sequence of requests, each followed by
// the status and checks its response must satisfy. See README.md for the
// script format. It is a pure Go replacement for the Hurl binary, which
// needed host libcurl and libxml2.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Variables can also come from the environment, so that Buck local resources
// can provide dynamic values such as a server's endpoint.
const envPrefix = "BARF_VAR_"

type options struct {
	vars           map[string]string
	fileRoot       string
	connectTimeout time.Duration
	timeout        time.Duration
	verbose        bool
	scripts        []string
}

type varFlag map[string]string

func (v varFlag) String() string { return "" }

func (v varFlag) Set(arg string) error {
	name, value, ok := strings.Cut(arg, "=")
	if !ok || !validName(name) {
		return fmt.Errorf("want NAME=VALUE with NAME matching [A-Za-z_][A-Za-z0-9_]*, got %q", arg)
	}
	v[name] = value
	return nil
}

func parseArgs(args []string, environ []string, stderr io.Writer) (*options, error) {
	opts := &options{vars: map[string]string{}}
	for _, kv := range environ {
		if name, value, ok := strings.Cut(kv, "="); ok && strings.HasPrefix(name, envPrefix) {
			if name := strings.TrimPrefix(name, envPrefix); validName(name) {
				opts.vars[name] = value
			}
		}
	}
	fs := flag.NewFlagSet("barf", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprintf(stderr, "usage: barf [flags] SCRIPT...\n\nVariables also come from %sNAME environment variables; --var wins.\n\n", envPrefix)
		fs.PrintDefaults()
	}
	// Flags override the environment because they are parsed afterwards.
	fs.Var(varFlag(opts.vars), "var", "set a script variable, as `NAME=VALUE` (repeatable)")
	fs.StringVar(&opts.fileRoot, "file-root", "", "directory for relative body-file paths (default: each script's directory)")
	fs.DurationVar(&opts.connectTimeout, "connect-timeout", 5*time.Second, "timeout for establishing each connection")
	fs.DurationVar(&opts.timeout, "timeout", 30*time.Second, "timeout for each request, including reading its response")
	fs.BoolVar(&opts.verbose, "v", false, "print every request and its response status")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	opts.scripts = fs.Args()
	if len(opts.scripts) == 0 {
		fs.Usage()
		return nil, errors.New("no scripts given")
	}
	if opts.connectTimeout <= 0 || opts.timeout <= 0 {
		return nil, errors.New("timeouts must be positive")
	}
	return opts, nil
}

// Exit codes: 0 when every script passes, 1 when a check or request fails,
// and 2 for usage errors and scripts that cannot be read or parsed.
func run(args []string, environ []string, stdout, stderr io.Writer) int {
	opts, err := parseArgs(args, environ, stderr)
	if err != nil {
		if !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintf(stderr, "barf: %v\n", err)
		}
		return 2
	}
	scripts := make([]*script, 0, len(opts.scripts))
	for _, path := range opts.scripts {
		data, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(stderr, "barf: %v\n", err)
			return 2
		}
		s, err := parseScript(path, string(data))
		if err != nil {
			fmt.Fprintf(stderr, "barf: %v\n", err)
			return 2
		}
		scripts = append(scripts, s)
	}
	client := newClient(opts.connectTimeout, opts.timeout)
	status := 0
	for _, s := range scripts {
		root := opts.fileRoot
		if root == "" {
			root = filepath.Dir(s.path)
		}
		r := &runner{
			client:   client,
			vars:     maps.Clone(opts.vars),
			fileRoot: root,
			verbose:  opts.verbose,
			stdout:   stdout,
			stderr:   stderr,
			now:      time.Now,
		}
		if !r.run(s) {
			status = 1
		}
	}
	return status
}

func main() {
	os.Exit(run(os.Args[1:], os.Environ(), os.Stdout, os.Stderr))
}
