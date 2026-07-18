// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
)

// A formatter transforms a file's in-memory contents. Formatters are applied in
// registration order, so language-specific tools see the normalized output of
// general-purpose tools such as the whitespace formatter.
type formatter interface {
	name() string
	handles(path string) bool
	format(ctx context.Context, path, content string) (string, error)
}

type fixer struct {
	formatters []formatter
	stderr     io.Writer
}

func newFixer(stderr io.Writer, formatters ...formatter) *fixer {
	if stderr == nil {
		stderr = io.Discard
	}
	return &fixer{formatters: formatters, stderr: stderr}
}

func newDefaultFixer(stderr io.Writer) *fixer {
	return newFixer(
		stderr,
		whitespaceFormatter{},
		newRustFormatter(nil),
		newGoFormatter(nil),
		newBuildifierFormatter(nil),
	)
}

// formatFile treats an individual formatter failure as non-fatal: jj fix must
// receive the last valid contents rather than partial output from a failed
// subprocess. Cancellation remains fatal so an interrupted invocation stops
// promptly instead of reporting success.
func (f *fixer) formatFile(ctx context.Context, path, content string) (string, error) {
	result := content
	for _, tool := range f.formatters {
		if !tool.handles(path) {
			continue
		}

		formatted, err := tool.format(ctx, path, result)
		if err == nil {
			result = formatted
			continue
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		fmt.Fprintf(f.stderr, "%s failed for %s: %v\n", tool.name(), path, err)
	}
	return result, nil
}
