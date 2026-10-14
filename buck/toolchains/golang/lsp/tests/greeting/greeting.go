// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Package greeting is a go_library for the language server's smoke test
// (../../smoke_test.py): another target imports it, and it imports
// golang.org/x.
package greeting

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// Hello greets someone by name.
func Hello(name string) string {
	return "Hello, " + cases.Title(language.English).String(name)
}
