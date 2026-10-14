// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// check-dotslash-file checks one file under buck/bin. A DotSlash file has
// every platform's artifact downloaded and checked against its size and
// digest; a .exe beside it must be the DotSlash Windows shim.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "usage: check-dotslash-file FILE")
		fmt.Fprintln(stderr, "example: check-dotslash-file buck/bin/buck2")
		return 2
	}
	path, err := resolve(args[0])
	if err != nil {
		fmt.Fprintf(stderr, "check-dotslash-file: %v\n", err)
		return 1
	}
	if strings.HasSuffix(path, ".exe") {
		err = checkShim(path, shimHashes, stdout)
	} else {
		err = newChecker().checkFile(ctx, path, stdout)
	}
	if err != nil {
		fmt.Fprintf(stderr, "check-dotslash-file: %v\n", err)
		return 1
	}
	return 0
}

// resolve makes a relative path relative to the repository root, the
// nearest directory above the working directory with a .buckroot, so that
// `buck2 run` takes the same paths as the tests from any subdirectory.
func resolve(path string) (string, error) {
	if !filepath.IsAbs(path) {
		root, err := repoRoot()
		if err != nil {
			return "", err
		}
		path = filepath.Join(root, path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a file", path)
	}
	return path, nil
}

func repoRoot() (string, error) {
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
