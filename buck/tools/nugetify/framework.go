// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"fmt"
	"strconv"
	"strings"
)

// framework is a parsed target framework moniker. Only the families a modern
// .NET consumer can reference are distinguished; everything else is "other"
// and never compatible.
type framework struct {
	family   string // "net", "netcoreapp", "netstandard", "netframework" or "other"
	major    int
	minor    int
	platform string // "windows" in net6.0-windows; empty for portable TFMs
	text     string
}

// parseFramework reads both the short form used for lib/ folders (net8.0,
// netstandard2.0, netcoreapp3.1, net472) and the long form older nuspecs use
// in dependency groups (.NETStandard2.0, .NETCoreApp3.1, .NETFramework4.7.2).
func parseFramework(raw string) (framework, bool) {
	text := strings.TrimSpace(raw)
	lower := strings.ToLower(text)
	result := framework{family: "other", text: text}
	var rest string
	switch {
	case strings.HasPrefix(lower, ".netstandard"):
		result.family, rest = "netstandard", lower[len(".netstandard"):]
	case strings.HasPrefix(lower, ".netcoreapp"):
		result.family, rest = "netcoreapp", lower[len(".netcoreapp"):]
	case strings.HasPrefix(lower, ".netframework"):
		result.family, rest = "netframework", lower[len(".netframework"):]
	case strings.HasPrefix(lower, "netstandard"):
		result.family, rest = "netstandard", lower[len("netstandard"):]
	case strings.HasPrefix(lower, "netcoreapp"):
		result.family, rest = "netcoreapp", lower[len("netcoreapp"):]
	case strings.HasPrefix(lower, "net"):
		result.family, rest = "net", lower[len("net"):]
	default:
		return result, false
	}
	rest = strings.TrimPrefix(rest, ",version=v")
	if index := strings.IndexByte(rest, '-'); index >= 0 {
		rest, result.platform = rest[:index], rest[index+1:]
	}
	if result.family == "net" && !strings.Contains(rest, ".") {
		// net472 and friends: the classic framework, with its version digits
		// run together.
		result.family = "netframework"
		if len(rest) < 2 || len(rest) > 3 {
			return result, false
		}
		major, err := strconv.Atoi(rest[:1])
		if err != nil {
			return result, false
		}
		minor, err := strconv.Atoi(rest[1:])
		if err != nil {
			return result, false
		}
		result.major, result.minor = major, minor
		return result, true
	}
	majorText, minorText, hasMinor := strings.Cut(rest, ".")
	major, err := strconv.Atoi(majorText)
	if err != nil {
		return result, false
	}
	minor := 0
	if hasMinor {
		// .NETFramework4.7.2 carries a third number; the families that matter
		// here never do.
		minorText, _, _ = strings.Cut(minorText, ".")
		if minor, err = strconv.Atoi(minorText); err != nil {
			return result, false
		}
	}
	result.major, result.minor = major, minor
	if result.family == "net" && major < 5 {
		return result, false
	}
	if result.family == "netcoreapp" && major >= 5 {
		result.family = "net"
	}
	return result, true
}

// compatibleWith reports whether an asset built for f can be consumed by a
// project targeting `target`, which must be net5.0 or later.
func (f framework) compatibleWith(target framework) bool {
	if target.family != "net" || f.platform != "" {
		return false
	}
	switch f.family {
	case "net":
		return f.major < target.major || (f.major == target.major && f.minor <= target.minor)
	case "netcoreapp":
		return true
	case "netstandard":
		return f.major < 2 || (f.major == 2 && f.minor <= 1)
	}
	return false
}

// precedence orders compatible frameworks the way NuGet picks the nearest
// one: a newer net over an older, then netcoreapp, then netstandard.
func (f framework) precedence() int {
	base := 0
	switch f.family {
	case "net":
		base = 3000
	case "netcoreapp":
		base = 2000
	case "netstandard":
		base = 1000
	}
	return base + f.major*10 + f.minor
}

// nearest picks the candidate NuGet would select for `target`: the
// compatible one with the highest precedence. Candidates that do not parse
// are skipped, since a package may ship folders for platforms this tool
// does not model.
func nearest(target framework, candidates []string) (string, bool) {
	best, bestPrecedence, found := "", -1, false
	for _, candidate := range candidates {
		parsed, ok := parseFramework(candidate)
		if !ok || !parsed.compatibleWith(target) {
			continue
		}
		if precedence := parsed.precedence(); precedence > bestPrecedence {
			best, bestPrecedence, found = candidate, precedence, true
		}
	}
	return best, found
}

// parseOverrides reads a targeting pack's data/PackageOverrides.txt: one
// `Id|Version` per line naming the packages the framework itself supplies.
// A dependency on one of them at or below that version is satisfied by the
// framework and never becomes a package reference.
func parseOverrides(text string) (map[string]version, error) {
	overrides := make(map[string]version)
	scanner := bufio.NewScanner(strings.NewReader(text))
	for line := 1; scanner.Scan(); line++ {
		entry := strings.TrimSpace(scanner.Text())
		if entry == "" {
			continue
		}
		id, versionText, ok := strings.Cut(entry, "|")
		if !ok {
			return nil, fmt.Errorf("PackageOverrides.txt line %d: expected Id|Version, got %q", line, entry)
		}
		parsed, err := parseVersion(versionText)
		if err != nil {
			return nil, fmt.Errorf("PackageOverrides.txt line %d: %w", line, err)
		}
		overrides[strings.ToLower(strings.TrimSpace(id))] = parsed
	}
	return overrides, nil
}
