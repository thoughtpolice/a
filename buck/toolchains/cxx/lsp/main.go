// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command clangd runs clangd with the compile commands Buck builds with (see
// README.md):
//
//	clangd [ARGS...]   write the compilation database, then run clangd with
//	                   it and ARGS (none, for an editor's language server)
//	clangd db          write the compilation database and print its path
//
// Buck says what every C and C++ target compiles and how (clangd.bxl); this
// program writes that as a compile_commands.json under the user's cache
// directory, one per checkout, where clangd also keeps its index.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

const bxl = "toolchains//cxx/lsp/clangd.bxl:commands"

// The cells holding C and C++ targets. cellar is archived and left out.
var patterns = []string{"root//...", "toolchains//...", "third-party//...", "tilde//..."}

func main() {
	args := os.Args[1:]
	dbOnly := len(args) == 1 && args[0] == "db"

	root, err := projectRoot()
	if err != nil {
		fatal(err)
	}
	dir, err := dbDir(root)
	if err != nil {
		fatal(err)
	}
	drivers, err := writeDB(root, dir)
	if err != nil {
		// An editor still gets a server, from the last database written,
		// if there is one.
		if _, statErr := os.Stat(filepath.Join(dir, "compile_commands.json")); dbOnly || statErr != nil {
			fatal(err)
		}
		fmt.Fprintf(os.Stderr, "clangd: keeping the last compilation database: %v\n", err)
		drivers = readDrivers(dir)
	}
	if dbOnly {
		fmt.Println(filepath.Join(dir, "compile_commands.json"))
		return
	}

	clangd, err := exec.LookPath("clangd")
	if err != nil {
		fatal(err)
	}
	cmd := exec.Command(clangd, append([]string{
		"--compile-commands-dir=" + dir,
		// clangd asks the compilers for their own include paths, the
		// standard library's among them, which a wrapper such as Nix's adds
		// to the command line it runs.
		"--query-driver=" + strings.Join(drivers, ","),
	}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			os.Exit(exit.ExitCode())
		}
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "clangd:", err)
	os.Exit(1)
}

func projectRoot() (string, error) {
	out, err := run(".", "buck2", "root", "--kind", "project")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// dbDir is the directory for the compilation database of root. clangd keeps
// its index next to the database, under .cache/clangd.
func dbDir(root string) (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(root))
	dir := filepath.Join(cache, "depot-clangd", filepath.Base(root)+"-"+hex.EncodeToString(sum[:6]))
	return dir, os.MkdirAll(dir, 0o755)
}

func run(dir, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s failed (%v):\n%s", strings.Join(cmd.Args, " "), err, stderr.String())
	}
	return out, nil
}

// What clangd.bxl:commands writes.
type buckCommands struct {
	Entries []buckEntry `json:"entries"`
	Errors  []string    `json:"errors"`
	Root    string      `json:"root"`
}

type buckEntry struct {
	Arguments []string `json:"arguments"`
	File      string   `json:"file"`
	Header    bool     `json:"header"`
	Target    string   `json:"target"`
}

// writeDB asks Buck for the compile commands and writes them to dir, then
// returns the compilers they run.
func writeDB(root, dir string) ([]string, error) {
	out, err := run(root, "buck2", append([]string{"bxl", "--console=simple", bxl, "--", "--patterns"}, patterns...)...)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(strings.TrimSpace(string(out)))
	if err != nil {
		return nil, err
	}
	var in buckCommands
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, err
	}
	for _, e := range in.Errors {
		fmt.Fprintln(os.Stderr, "clangd: left out:", e)
	}

	db := newDatabase(in.Root)
	entries, err := db.entries(in.Entries)
	if err != nil {
		return nil, err
	}
	if err := writeJSON(filepath.Join(dir, "compile_commands.json"), entries); err != nil {
		return nil, err
	}
	drivers := db.drivers()
	return drivers, writeJSON(filepath.Join(dir, "drivers.json"), drivers)
}

func readDrivers(dir string) []string {
	var drivers []string
	if data, err := os.ReadFile(filepath.Join(dir, "drivers.json")); err == nil {
		json.Unmarshal(data, &drivers)
	}
	return drivers
}

// writeJSON replaces path in one step, as clangd may be reading it.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func sortedUnique(s []string) []string {
	s = slices.Clone(s)
	slices.Sort(s)
	return slices.Compact(s)
}
