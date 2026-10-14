// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"testing"

	"golang/lsp/tests/greeting"
)

func TestHello(t *testing.T) {
	if got := greeting.Hello("gopher"); got != "Hello, Gopher" {
		t.Errorf("Hello(%q) = %q", "gopher", got)
	}
}
