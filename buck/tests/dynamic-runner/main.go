// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Live fixture for the shims.dynamic_test discovery protocol. It exercises
// the parsing in buck/shims/dynamic_test_internal.bzl end to end: case
// listing, one execution flushing several named results, skip reporting,
// result-details attachment, and immunity to non-protocol stdout noise.
package main

import (
	"fmt"
	"os"
)

func main() {
	args := os.Args[1:]
	mode := ""
	if len(args) > 0 && (args[0] == "-list-tests" || args[0] == "-run-test") {
		mode = args[0]
		args = args[1:]
	}
	switch mode {
	case "-list-tests":
		fmt.Println("unrelated preamble the listing parser must ignore")
		fmt.Println("test: alpha alpha-case")
		fmt.Println("test: multi multi-case")
	case "-run-test":
		if len(args) != 1 {
			fmt.Fprintln(os.Stderr, "ERROR: expected exactly one filter argument")
			os.Exit(2)
		}
		switch args[0] {
		case "alpha":
			fmt.Println("result: PASS alpha-case 0.001 single result case")
		case "multi":
			fmt.Println("progress chatter the result parser must ignore")
			fmt.Println("result: PASS multi/first - first flushed item")
			fmt.Println("result-details: first item diagnostics")
			fmt.Println("result-details:   with indentation preserved")
			fmt.Println("result: SKIP multi/second - exercise skip reporting")
			fmt.Println("result: PASS multi-case 0.002 2 items checked")
		default:
			fmt.Fprintf(os.Stderr, "ERROR: unknown filter %q\n", args[0])
			os.Exit(2)
		}
	default:
		// Plain batch invocation, used by `buck2 run` and the external-runner
		// fallback, must succeed without protocol output.
		fmt.Println("dynamic-runner fixture: batch mode ok")
	}
}
