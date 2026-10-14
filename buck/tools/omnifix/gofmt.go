// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "strings"

func newGoFormatter(run commandRunner) commandFormatter {
	return newCommandFormatter(
		"gofmt",
		"gofmt",
		func(path string) bool { return strings.HasSuffix(path, ".go") },
		nil,
		run,
	)
}
