// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// OmniFix applies repository formatters to content supplied by jj fix.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(realMain(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func realMain(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "Error: No file path provided")
		return 1
	}

	content, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "Fatal error: read input: %v\n", err)
		return 1
	}

	omnifix := newDefaultFixer(stderr)
	formatted, err := omnifix.formatFile(ctx, args[0], string(content))
	if err != nil {
		fmt.Fprintf(stderr, "Fatal error: format %s: %v\n", args[0], err)
		return 1
	}
	if _, err := io.WriteString(stdout, formatted); err != nil {
		fmt.Fprintf(stderr, "Fatal error: write output: %v\n", err)
		return 1
	}
	return 0
}
