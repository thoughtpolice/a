// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"testing"
)

func TestWhitespaceFormatter(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name: "empty file stays empty",
		},
		{
			name:  "trims trailing whitespace",
			input: "first  \nsecond\t",
			want:  "first\nsecond\n",
		},
		{
			name:  "preserves CRLF",
			input: "first  \r\nsecond\t",
			want:  "first\r\nsecond\r\n",
		},
		{
			name:  "normalizes mixed endings to CRLF",
			input: "first \nsecond \r\nthird",
			want:  "first\r\nsecond\r\nthird\r\n",
		},
		{
			name:  "trims Unicode whitespace",
			input: "value\u00a0",
			want:  "value\n",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			formatter := whitespaceFormatter{}
			got, err := formatter.format(context.Background(), "file.txt", test.input)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("format() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestWhitespaceFormatterHandlesOnlyTextFiles(t *testing.T) {
	formatter := whitespaceFormatter{}
	if !formatter.handles("README.md") {
		t.Fatal("formatter did not handle a text file")
	}
	if formatter.handles("Cargo.lock") {
		t.Fatal("formatter handled a skipped extension")
	}
}
