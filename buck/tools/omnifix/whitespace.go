// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"strings"
	"unicode"
)

type whitespaceFormatter struct{}

func (whitespaceFormatter) name() string {
	return "whitespace"
}

func (whitespaceFormatter) handles(path string) bool {
	return shouldProcessFile(path)
}

func (w whitespaceFormatter) format(_ context.Context, _ string, content string) (string, error) {
	if content == "" {
		return content, nil
	}

	lineEnding := preferredLineEnding(content)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index := range lines {
		lines[index] = strings.TrimRightFunc(lines[index], unicode.IsSpace)
	}
	result := strings.Join(lines, lineEnding)

	if !strings.HasSuffix(result, "\n") {
		result += lineEnding
	}
	return result, nil
}

func preferredLineEnding(content string) string {
	if strings.Contains(content, "\r\n") {
		return "\r\n"
	}
	return "\n"
}
