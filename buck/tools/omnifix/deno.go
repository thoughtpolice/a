// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"path"
	"strings"
)

// The DotSlash launcher pins the same Deno release as the Buck toolchain, so
// `jj fix` and `deno fmt --check` tests agree on the output.
const denoCommand = "buck/bin/deno"

var denoExtensions = map[string]struct{}{
	".ts":  {},
	".tsx": {},
	".mts": {},
	".cts": {},
	".js":  {},
	".jsx": {},
	".mjs": {},
	".cjs": {},
}

func newDenoFormatter(run commandRunner) commandFormatter {
	return newCommandFormatter(
		"deno fmt",
		denoCommand,
		isDenoFile,
		func(filePath string) []string {
			// Content arrives on stdin, so the extension picks the syntax.
			extension := strings.TrimPrefix(strings.ToLower(path.Ext(normalizePath(filePath))), ".")
			return []string{"fmt", "--ext", extension, "-"}
		},
		run,
	)
}

func isDenoFile(filePath string) bool {
	_, matched := denoExtensions[strings.ToLower(path.Ext(normalizePath(filePath)))]
	return matched
}
