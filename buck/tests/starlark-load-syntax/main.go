// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// check-starlark-load-syntax checks that every load() of a .bzl file by
// an absolute path names it as a target, @cell//pkg:file.bzl, rather than
// as a file path, @cell//pkg/file.bzl.
package main

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func main() {
	os.Exit(run(os.Stdout, os.Stderr))
}

func run(stdout, stderr io.Writer) int {
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintf(stderr, "check-starlark-load-syntax: %v\n", err)
		return 1
	}
	files, err := starlarkFiles(root)
	if err != nil {
		fmt.Fprintf(stderr, "check-starlark-load-syntax: %v\n", err)
		return 1
	}
	bad := map[string][]badLoad{}
	var badFiles []string
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			fmt.Fprintf(stderr, "check-starlark-load-syntax: %v\n", err)
			return 1
		}
		if loads := badLoads(data); len(loads) > 0 {
			bad[file] = loads
			badFiles = append(badFiles, file)
		}
	}
	if len(badFiles) == 0 {
		fmt.Fprintf(stdout, "✓ All %d files use correct load() syntax\n", len(files))
		return 0
	}
	fmt.Fprintf(stdout, "Found %d files with incorrect load() syntax:\n", len(badFiles))
	fmt.Fprintln(stdout, strings.Repeat("=", 80))
	for _, file := range badFiles {
		fmt.Fprintf(stdout, "\n%s:\n", file)
		for _, load := range bad[file] {
			fmt.Fprintf(stdout, "  Line %d: %s\n", load.line, load.text)
			fmt.Fprintf(stdout, "    Found: load(%q, ...)\n", load.path)
			fmt.Fprintf(stdout, "    Should be: load(%q, ...)\n", corrected(load.path))
		}
	}
	fmt.Fprintf(stdout, "\nTotal files checked: %d\n", len(files))
	fmt.Fprintf(stdout, "Files with errors: %d\n", len(badFiles))
	return 1
}

// repoRoot is BUILD_WORKSPACE_DIRECTORY if it is set, and otherwise the
// nearest directory above the working directory with a .buckroot, which
// is the repository root itself when this runs as a test.
func repoRoot() (string, error) {
	if dir := os.Getenv("BUILD_WORKSPACE_DIRECTORY"); dir != "" {
		return dir, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".buckroot")); err == nil {
			return dir, nil
		}
		if dir == filepath.Dir(dir) {
			return "", fmt.Errorf("no .buckroot in %s or above it", cwd)
		}
	}
}

// starlarkFiles returns every BUILD, PACKAGE and .bzl file under root,
// relative to it and sorted, except those under a dot-leading directory or
// under root's work (jj workspaces, each a whole other checkout) and
// buck-out. Symbolic links are not followed.
func starlarkFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			hidden := rel != "." && strings.HasPrefix(d.Name(), ".")
			if hidden || rel == "work" || rel == "buck-out" {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.Type().IsRegular() && !strings.HasPrefix(name, ".") &&
			(name == "BUILD" || name == "PACKAGE" || strings.HasSuffix(name, ".bzl")) {
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	return files, err
}

// The first argument of a load(), which may be on a later line than the
// load( itself. It also matches in comments and strings, which is fine:
// an example there should be right too.
var loadPattern = regexp.MustCompile(`load\s*\(\s*["']([^"'\n]+)["']`)

type badLoad struct {
	line       int
	text, path string
}

// badLoads returns the loads in data of a .bzl file by an absolute path
// without a colon. Every such path needs one, even @cell//file.bzl, which
// is @cell//:file.bzl.
func badLoads(data []byte) []badLoad {
	var bad []badLoad
	for _, m := range loadPattern.FindAllSubmatchIndex(data, -1) {
		path := string(data[m[2]:m[3]])
		if !strings.HasSuffix(path, ".bzl") || strings.Contains(path, ":") || !strings.Contains(path, "//") {
			continue
		}
		start := bytes.LastIndexByte(data[:m[2]], '\n') + 1
		end := m[3] + bytes.IndexByte(data[m[3]:], '\n')
		if end < m[3] {
			end = len(data)
		}
		bad = append(bad, badLoad{
			line: bytes.Count(data[:m[2]], []byte("\n")) + 1,
			text: strings.TrimSpace(string(data[start:end])),
			path: path,
		})
	}
	return bad
}

// corrected turns the last slash of path after its // into a colon, or
// adds a colon after the // if there is no slash.
func corrected(path string) string {
	cell, rest, _ := strings.Cut(path, "//")
	if i := strings.LastIndexByte(rest, '/'); i >= 0 {
		return cell + "//" + rest[:i] + ":" + rest[i+1:]
	}
	return cell + "//:" + rest
}
