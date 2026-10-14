// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Package lib is a go_library that imports golang.org/x with no dependency of
// its own, as any Go target may, for x_test.go to import in turn.
package lib

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// Title title-cases English text.
func Title(s string) string {
	return cases.Title(language.English).String(s)
}
