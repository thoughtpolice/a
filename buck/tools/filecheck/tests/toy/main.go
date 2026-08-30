// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// toy is a stand-in compiler for the filecheck self-tests: it numbers the
// lines of its input, optionally upper-casing them, and reports a count on
// stderr. Its output shape exercises CHECK, CHECK-NEXT, numeric variables,
// and stderr capture.
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	upper := false
	fail := false
	var files []string
	for _, a := range os.Args[1:] {
		switch a {
		case "--upper":
			upper = true
		case "--fail":
			fail = true
		case "--version":
			fmt.Println("toy 1.0")
			return
		default:
			files = append(files, a)
		}
	}
	var in io.Reader = os.Stdin
	name := "<stdin>"
	if len(files) > 0 {
		f, err := os.Open(files[0])
		if err != nil {
			fmt.Fprintln(os.Stderr, "toy:", err)
			os.Exit(2)
		}
		defer f.Close()
		in = f
		name = files[0]
	}
	sc := bufio.NewScanner(in)
	n := 0
	for sc.Scan() {
		n++
		line := sc.Text()
		if upper {
			line = strings.ToUpper(line)
		}
		fmt.Printf("%d: %s\n", n, line)
	}
	fmt.Fprintf(os.Stderr, "toy: %d lines from %s\n", n, name)
	if fail {
		fmt.Fprintln(os.Stderr, "toy: error: failing as requested")
		os.Exit(1)
	}
}
