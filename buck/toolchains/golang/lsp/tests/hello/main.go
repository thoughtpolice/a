// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command hello is the language server smoke test's program
// (../../smoke_test.py).
package main

import (
	"fmt"

	"golang/lsp/tests/greeting"
)

func main() {
	fmt.Println(greeting.Hello("gopher"))
}
