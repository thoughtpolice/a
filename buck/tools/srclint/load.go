// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"fmt"
	"path"
	"regexp"
	"strings"
)

// isStarlark reports whether the file at p is Buck2 Starlark: a build file,
// a PACKAGE file, or a .bzl or .bxl module.
func isStarlark(p string) bool {
	switch path.Base(p) {
	case "BUILD", "BUCK", "PACKAGE":
		return true
	}
	return strings.HasSuffix(p, ".bzl") || strings.HasSuffix(p, ".bxl")
}

// loadProblems returns each load() in the Starlark file at p with contents
// data that names a .bzl file by an absolute path, @cell//pkg/file.bzl,
// rather than as a target, @cell//pkg:file.bzl.
func loadProblems(p string, data []byte) []problem {
	if !isStarlark(p) {
		return nil
	}
	var problems []problem
	for _, load := range badLoads(data) {
		problems = append(problems, problem{
			Path:    p,
			Line:    load.line,
			Check:   "load",
			Message: fmt.Sprintf("load(%q, ...) names a file path; write it as load(%q, ...)", load.path, corrected(load.path)),
		})
	}
	return problems
}

// The first argument of a load(), which may be on a later line than the
// load( itself. It also matches in comments and strings, which is fine:
// an example there should be right too.
var loadPattern = regexp.MustCompile(`load\s*\(\s*["']([^"'\n]+)["']`)

type badLoad struct {
	line int
	path string
}

// badLoads returns the loads in data of a .bzl file by an absolute path
// without a colon. Every such path needs one, even @cell//file.bzl, which
// is @cell//:file.bzl.
func badLoads(data []byte) []badLoad {
	var bad []badLoad
	for _, m := range loadPattern.FindAllSubmatchIndex(data, -1) {
		path := string(data[m[2]:m[3]])
		if !strings.HasSuffix(path, ".bzl") || strings.Contains(path, ":") || !strings.Contains(path, "//") {
			continue
		}
		bad = append(bad, badLoad{
			line: bytes.Count(data[:m[2]], []byte("\n")) + 1,
			path: path,
		})
	}
	return bad
}

// corrected turns the last slash of path after its // into a colon, or
// adds a colon after the // if there is no slash.
func corrected(path string) string {
	cell, rest, _ := strings.Cut(path, "//")
	if i := strings.LastIndexByte(rest, '/'); i >= 0 {
		return cell + "//" + rest[:i] + ":" + rest[i+1:]
	}
	return cell + "//:" + rest
}
