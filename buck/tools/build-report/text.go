// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// configurationHash matches the hash suffix buck2 appends to configuration
// names, as in `cfg:<empty>#1a608cc1468ec806`. The hash disambiguates
// configurations for machines but is noise for humans.
var configurationHash = regexp.MustCompile(`#[0-9a-f]{12,16}\b`)

func stripConfigurationHashes(value string) string {
	return configurationHash.ReplaceAllString(value, "")
}

// displayConfiguration is the human-readable form of a configuration name,
// used both for display and for grouping configurations in breakdowns.
func displayConfiguration(configuration string) string {
	return stripConfigurationHashes(configuration)
}

// withCommas renders 1234567 as "1,234,567".
func withCommas(value int64) string {
	text := strconv.FormatInt(value, 10)
	sign := ""
	if strings.HasPrefix(text, "-") {
		sign, text = "-", text[1:]
	}
	var builder strings.Builder
	for index, digit := range text {
		if index > 0 && (len(text)-index)%3 == 0 {
			builder.WriteByte(',')
		}
		builder.WriteRune(digit)
	}
	return sign + builder.String()
}

func percent(value float64) string {
	return fmt.Sprintf("%.1f%%", value)
}

// shortenTarget elides the middle of an overlong target label, keeping the
// cell prefix and the tail with the target name, which carry the meaning.
func shortenTarget(label string, max int) string {
	if len(label) <= max || max < 10 {
		return label
	}
	cell, rest, found := strings.Cut(label, "//")
	if !found {
		return label[:max-3] + "..."
	}
	keep := max - len(cell) - len("//...")
	if keep < 1 || keep >= len(rest) {
		return label[:max-3] + "..."
	}
	return cell + "//..." + rest[len(rest)-keep:]
}

func firstLine(value string) string {
	line, _, _ := strings.Cut(value, "\n")
	return strings.TrimRight(line, "\r")
}

// splitTrimmedLines splits into lines, dropping trailing blank lines.
func splitTrimmedLines(value string) []string {
	lines := strings.Split(strings.TrimRight(value, "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	return lines
}

// headLines returns at most limit leading lines plus the count of lines
// dropped; limit <= 0 keeps everything.
func headLines(lines []string, limit int) ([]string, int) {
	if limit <= 0 || len(lines) <= limit {
		return lines, 0
	}
	return lines[:limit], len(lines) - limit
}

// tailLines returns at most limit trailing lines plus the count of lines
// dropped; limit <= 0 keeps everything. The tail is where compilers put the
// actual error, so truncated output keeps the end rather than the start.
func tailLines(lines []string, limit int) ([]string, int) {
	if limit <= 0 || len(lines) <= limit {
		return lines, 0
	}
	return lines[len(lines)-limit:], len(lines) - limit
}

func plural(count int, singular, plural string) string {
	if count == 1 {
		return singular
	}
	return plural
}
