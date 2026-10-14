// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// check_arguments substitutes for barf in the rule's argument-plumbing tests.
// It checks exact argument boundaries, generated artifacts, timeout overrides,
// hidden inputs, and environment propagation.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

func require(ok bool, format string, args ...any) {
	if !ok {
		fmt.Fprintf(os.Stderr, format+"\n", args...)
		os.Exit(1)
	}
}

func read(path string) string {
	data, err := os.ReadFile(path)
	require(err == nil, "read %s: %v", path, err)
	return string(data)
}

func main() {
	args := os.Args[1:]
	require(len(args) >= 1, "missing barf arguments: %q", args)
	src := args[len(args)-1]
	require(strings.Contains(read(src), "GET http://{not_a_real_endpoint}/"), "source is not the script: %q", src)
	flags := map[string]string{}
	variables := map[string]string{}
	for i := 0; i < len(args)-1; i += 2 {
		require(i+1 < len(args)-1, "unpaired argument: %q", args[i:])
		key, value := args[i], args[i+1]
		if key == "--var" {
			name, value, ok := strings.Cut(value, "=")
			require(ok, "malformed variable: %q", args[i+1])
			_, duplicate := variables[name]
			require(!duplicate, "duplicate variable: %q", name)
			variables[name] = value
		} else {
			_, duplicate := flags[key]
			require(!duplicate, "duplicate option: %q", key)
			flags[key] = value
		}
	}

	expected := map[string]string{"--connect-timeout": "5s", "--timeout": "30s"}
	if os.Getenv("BARF_RULE_CASE") == "custom" {
		expected["--connect-timeout"] = "1200ms"
		expected["--timeout"] = "9s"
		expected["--file-root"] = flags["--file-root"]
		require(read(filepath.Join(flags["--file-root"], "input.txt")) == "a generated fixture", "file root is not the generated directory")
		require(read(variables["fixture"]) == "a generated fixture", "artifact-valued variable was not materialized")
		require(len(variables) == 2 && variables["value"] == "spaces and an = sign", "variable argument boundaries: %q", variables)
		require(strings.Contains(read(filepath.Join(filepath.Dir(src), "hidden.txt")), "Additional scenario input"), "hidden input was not materialized")
	} else {
		require(len(variables) == 0, "unexpected default variables: %q", variables)
	}
	require(reflect.DeepEqual(flags, expected), "flags = %q; want %q", flags, expected)
	fmt.Println("barf rule arguments and inputs verified")
}
