// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "strings"

const defaultRustEdition = "2024"

func newRustFormatter(run commandRunner) commandFormatter {
	return newCommandFormatter(
		"rustfmt",
		"rustfmt",
		func(path string) bool { return strings.HasSuffix(path, ".rs") },
		func(string) []string {
			return []string{"--emit=stdout", "--edition=" + defaultRustEdition}
		},
		run,
	)
}
