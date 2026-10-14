// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "strings"

func newNixFormatter(run commandRunner) commandFormatter {
	return newCommandFormatter(
		"nixfmt",
		"nixfmt",
		func(path string) bool { return strings.HasSuffix(path, ".nix") },
		func(path string) []string {
			return []string{"--filename=" + path, "-"}
		},
		run,
	)
}
