// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// celld-project runs Deno's language server over celld TypeScript units, the
// way rust-project feeds rust-analyzer: the units have no checked-in
// deno.json, so it asks Buck which units own each file an editor opens and
// hands Deno one generated config with their import maps.
//
//	celld-project --deno DENO [flags] -- lsp
//	celld-project --deno DENO [flags] -- ARGS...   (runs DENO ARGS...)
//
// Anything but `lsp` goes straight to Deno, so editors can use this where
// they expect a deno executable (`deno --version`, for one). Editors start it
// through buck/bin/celld-project, which finds the project root, builds
// toolchains//celld:project once and caches its command line.
//
// The config lives at buck-out/celld-project-lsp/<pid>/deno.json. Every path
// in it is absolute, and Deno is told to use it through the `config` setting,
// which applies it to every file in the workspace that no nearer deno.json
// claims: other Deno packages keep their own configs.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, " ") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func findRoot(dir string) (string, error) {
	for {
		if _, err := os.Stat(filepath.Join(dir, ".buckroot")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no .buckroot above the working directory")
		}
		dir = parent
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "celld-project: "+format+"\n", args...)
	os.Exit(2)
}

func main() {
	flags := flag.NewFlagSet("celld-project", flag.ContinueOnError)
	deno := flags.String("deno", "", "the deno executable")
	root := flags.String("root", os.Getenv("CELLD_PROJECT_ROOT"), "project root (default: $CELLD_PROJECT_ROOT, else the nearest directory above the working directory holding .buckroot)")
	buck2 := flags.String("buck2", "", "buck2 executable for discovery (default: <root>/buck/bin/buck2, else buck2)")
	isolation := flags.String("isolation-dir", "celld-project", "buck2 isolation directory for discovery")
	script := flags.String("bxl", "toolchains//celld/project.bxl:main", "the discovery BXL function")
	hold := flags.Duration("hold", 15*time.Second, "longest wait for discovery before a newly opened document reaches Deno anyway")
	var fragments listFlag
	flags.Var(&fragments, "fragment", "serve this fragment instead of asking Buck (repeatable; for tests)")
	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	if *deno == "" {
		fail("--deno is required")
	}
	args := flags.Args()
	if len(args) == 0 || args[0] != "lsp" {
		argv := append([]string{*deno}, args...)
		if err := syscall.Exec(*deno, argv, os.Environ()); err != nil {
			fail("exec %s: %v", *deno, err)
		}
	}

	if *root == "" {
		cwd, err := os.Getwd()
		if err != nil {
			fail("%v", err)
		}
		if *root, err = findRoot(cwd); err != nil {
			fail("%v", err)
		}
	}
	var discover Discoverer
	if len(fragments) > 0 {
		static, err := LoadStaticDiscoverer(*root, fragments)
		if err != nil {
			fail("%v", err)
		}
		discover = static
	} else {
		if *buck2 == "" {
			*buck2 = DefaultBuck2(*root)
		}
		discover = &BuckDiscoverer{Buck2: *buck2, Root: *root, IsolationDir: *isolation, Script: *script}
	}

	state := filepath.Join(*root, "buck-out", "celld-project-lsp")
	pruneStale(state)
	dir := filepath.Join(state, strconv.Itoa(os.Getpid()))
	proxy := &Proxy{Root: *root, ConfigPath: filepath.Join(dir, "deno.json"), Discover: discover, Hold: *hold}
	code, err := runServer(proxy, *deno, args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "celld-project: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	os.RemoveAll(dir)
	os.Exit(code)
}

// runServer starts `deno lsp ...` and relays stdio through proxy.
func runServer(proxy *Proxy, deno string, args []string) (int, error) {
	cmd := exec.Command(deno, args...)
	cmd.Dir = proxy.Root
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "DENO_NO_UPDATE_CHECK=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 1, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 1, err
	}
	if err := cmd.Start(); err != nil {
		return 1, err
	}
	runErr := proxy.Run(os.Stdin, os.Stdout, stdin, stdout)
	if err := cmd.Wait(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode(), runErr
		}
		return 1, err
	}
	return 0, runErr
}

// pruneStale removes the config directories of proxies that are gone. Editors
// kill their language server when they quit (Helix does, right after `exit`),
// so a proxy rarely gets to remove its own.
func pruneStale(state string) {
	entries, err := os.ReadDir(state)
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || !entry.IsDir() {
			continue
		}
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			os.RemoveAll(filepath.Join(state, entry.Name()))
		}
	}
}
