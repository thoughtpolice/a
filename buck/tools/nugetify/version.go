// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"strconv"
	"strings"
)

// version is a NuGet package version: up to four numeric parts, an optional
// prerelease label, and build metadata that never takes part in ordering.
type version struct {
	parts   [4]int
	release []string
	text    string
}

// parseVersion accepts the forms nuget.org serves and normalizes them the way
// NuGet does: a missing part is zero and a zero fourth part is dropped.
func parseVersion(raw string) (version, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return version{}, fmt.Errorf("empty version")
	}
	body := text
	if index := strings.IndexByte(body, '+'); index >= 0 {
		body = body[:index]
	}
	var release string
	if index := strings.IndexByte(body, '-'); index >= 0 {
		body, release = body[:index], body[index+1:]
		if release == "" {
			return version{}, fmt.Errorf("version %q has an empty prerelease label", raw)
		}
	}
	numbers := strings.Split(body, ".")
	if len(numbers) == 0 || len(numbers) > 4 {
		return version{}, fmt.Errorf("version %q must have one to four numeric parts", raw)
	}
	var result version
	for index, number := range numbers {
		value, err := strconv.Atoi(number)
		if err != nil || value < 0 || (len(number) > 1 && number[0] == '0') {
			return version{}, fmt.Errorf("version %q: %q is not a version number", raw, number)
		}
		result.parts[index] = value
	}
	if release != "" {
		result.release = strings.Split(release, ".")
		for _, label := range result.release {
			if label == "" {
				return version{}, fmt.Errorf("version %q has an empty prerelease identifier", raw)
			}
		}
	}
	result.text = result.normalize()
	return result, nil
}

func (v version) normalize() string {
	text := fmt.Sprintf("%d.%d.%d", v.parts[0], v.parts[1], v.parts[2])
	if v.parts[3] != 0 {
		text += "." + strconv.Itoa(v.parts[3])
	}
	if len(v.release) > 0 {
		text += "-" + strings.Join(v.release, ".")
	}
	return text
}

func (v version) String() string {
	return v.text
}

// compare orders versions as NuGet does: numerically by part, then a
// prerelease sorts before the release it precedes, with identifiers compared
// numerically when both are numbers and case-insensitively otherwise.
func (v version) compare(other version) int {
	for index := range v.parts {
		if v.parts[index] != other.parts[index] {
			if v.parts[index] < other.parts[index] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(v.release) == 0 && len(other.release) == 0:
		return 0
	case len(v.release) == 0:
		return 1
	case len(other.release) == 0:
		return -1
	}
	for index := 0; index < len(v.release) && index < len(other.release); index++ {
		if result := compareIdentifier(v.release[index], other.release[index]); result != 0 {
			return result
		}
	}
	switch {
	case len(v.release) < len(other.release):
		return -1
	case len(v.release) > len(other.release):
		return 1
	}
	return 0
}

func compareIdentifier(left, right string) int {
	leftNumber, leftErr := strconv.Atoi(left)
	rightNumber, rightErr := strconv.Atoi(right)
	switch {
	case leftErr == nil && rightErr == nil:
		if leftNumber != rightNumber {
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		}
		return 0
	case leftErr == nil:
		return -1
	case rightErr == nil:
		return 1
	}
	return strings.Compare(strings.ToLower(left), strings.ToLower(right))
}

// lowerBound is the lowest version a dependency range accepts. NuGet picks
// that version for a dependency, so it is all a resolution needs from the
// range; open or exclusive lower bounds have no such version and are
// rejected rather than guessed at.
func lowerBound(rawRange string) (version, error) {
	text := strings.TrimSpace(rawRange)
	if text == "" {
		return version{}, fmt.Errorf("empty version range")
	}
	if text[0] != '[' && text[0] != '(' {
		// A bare version means "at least this version".
		return parseVersion(text)
	}
	if last := text[len(text)-1]; last != ']' && last != ')' {
		return version{}, fmt.Errorf("version range %q is not closed", rawRange)
	}
	inclusive := text[0] == '['
	inner := text[1 : len(text)-1]
	lower, _, hasUpper := strings.Cut(inner, ",")
	lower = strings.TrimSpace(lower)
	if lower == "" {
		return version{}, fmt.Errorf("version range %q has no lower bound", rawRange)
	}
	if !inclusive {
		return version{}, fmt.Errorf("version range %q excludes its lower bound", rawRange)
	}
	_ = hasUpper
	return parseVersion(lower)
}
