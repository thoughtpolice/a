// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"strings"
	"unicode"
)

// Formats whose bytes are not lines of text, or whose whitespace belongs to
// the tool that wrote them. Matched case-insensitively against the extension.
var whitespaceSkipExtensions = []string{
	".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf",
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
	".bin", ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".wasm",
	".pyc", ".pyo", ".pyd",
	".lock", ".json", ".jsonl", ".jsonc",
	// stage0 seed sources, whose whitespace is part of the format
	".hex0", ".hex1", ".hex2", ".M1",
}

// whitespaceProblems returns each line of the file at path with contents
// data that ends in whitespace, and the end of the file if it is not a
// newline.
func whitespaceProblems(path string, data []byte) []problem {
	if isBinary(data) || skipsWhitespace(path) {
		return nil
	}
	var problems []problem
	for i, line := range splitLines(data) {
		// A CRLF line ending is not trailing whitespace.
		line = strings.TrimSuffix(line, "\r")
		if line != strings.TrimRightFunc(line, unicode.IsSpace) {
			problems = append(problems, problem{Path: path, Line: i + 1, Check: "whitespace", Message: "trailing whitespace"})
		}
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		problems = append(problems, problem{
			Path:    path,
			Line:    bytes.Count(data, []byte("\n")) + 1,
			Check:   "whitespace",
			Message: "missing final newline",
		})
	}
	return problems
}

func skipsWhitespace(path string) bool {
	ext := strings.ToLower(path[strings.LastIndexByte(path, '/')+1:])
	if dot := strings.LastIndexByte(ext, '.'); dot > 0 {
		ext = ext[dot:]
	} else {
		return false
	}
	for _, skip := range whitespaceSkipExtensions {
		if ext == strings.ToLower(skip) {
			return true
		}
	}
	return false
}

// isBinary reports whether data looks like something other than text: a NUL
// byte in its first 8KiB, the same heuristic Git and grep use.
func isBinary(data []byte) bool {
	return bytes.IndexByte(data[:min(len(data), 8192)], 0) >= 0
}

// splitLines returns the lines of data without their newlines, and without
// the empty "line" after a final newline.
func splitLines(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}
