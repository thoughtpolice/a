// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const supportedCargoLockVersion = 4

type cargoPackage struct {
	Name    string
	Version string
	Source  string
}

// parseCargoLock intentionally parses only the stable subset of TOML used by
// Cargo.lock. Keeping this parser here avoids adding a non-hermetic Go module
// dependency merely to read three scalar fields from each [[package]] table.
func parseCargoLock(r io.Reader) ([]cargoPackage, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	lockVersion := 0
	sawVersion := false
	inPackage := false
	inOtherTable := false
	var current cargoPackage
	var packages []cargoPackage

	finishPackage := func(line int) error {
		if !inPackage {
			return nil
		}
		if current.Name == "" || current.Version == "" {
			return fmt.Errorf("package ending near line %d is missing name or version", line)
		}
		packages = append(packages, current)
		current = cargoPackage{}
		inPackage = false
		return nil
	}

	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(stripTOMLComment(scanner.Text()))
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "[[") {
			if line != "[[package]]" {
				return nil, fmt.Errorf("line %d: unsupported array table %q", lineNumber, line)
			}
			if err := finishPackage(lineNumber); err != nil {
				return nil, err
			}
			inPackage = true
			inOtherTable = false
			continue
		}
		if strings.HasPrefix(line, "[") {
			if !strings.HasSuffix(line, "]") {
				return nil, fmt.Errorf("line %d: malformed table header %q", lineNumber, line)
			}
			if err := finishPackage(lineNumber); err != nil {
				return nil, err
			}
			table := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			if table != "metadata" && table != "patch" && !strings.HasPrefix(table, "patch.") {
				return nil, fmt.Errorf("line %d: unsupported top-level table %q", lineNumber, table)
			}
			inOtherTable = true
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			// Values in multiline arrays are irrelevant to this parser.
			if inPackage || inOtherTable {
				continue
			}
			return nil, fmt.Errorf("line %d: expected a key/value pair", lineNumber)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)

		if inPackage {
			var destination *string
			switch key {
			case "name":
				destination = &current.Name
			case "version":
				destination = &current.Version
			case "source":
				destination = &current.Source
			default:
				continue
			}
			if *destination != "" {
				return nil, fmt.Errorf("line %d: duplicate package field %q", lineNumber, key)
			}
			parsed, err := parseTOMLString(value)
			if err != nil {
				return nil, fmt.Errorf("line %d: invalid %s: %w", lineNumber, key, err)
			}
			*destination = parsed
			continue
		}

		if inOtherTable {
			continue
		}
		if key != "version" {
			return nil, fmt.Errorf("line %d: unexpected top-level key %q", lineNumber, key)
		}
		if sawVersion {
			return nil, fmt.Errorf("line %d: duplicate Cargo.lock version", lineNumber)
		}
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return nil, fmt.Errorf("line %d: invalid Cargo.lock version %q", lineNumber, value)
		}
		lockVersion = parsed
		sawVersion = true
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read Cargo.lock: %w", err)
	}
	if err := finishPackage(lineNumber + 1); err != nil {
		return nil, err
	}
	if !sawVersion {
		return nil, fmt.Errorf("Cargo.lock is missing its format version")
	}
	if lockVersion != supportedCargoLockVersion {
		return nil, fmt.Errorf("Cargo.lock format version is %d; expected %d", lockVersion, supportedCargoLockVersion)
	}
	if len(packages) == 0 {
		return nil, fmt.Errorf("Cargo.lock contains no packages")
	}
	return packages, nil
}

func parseTOMLString(value string) (string, error) {
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return value[1 : len(value)-1], nil
	}
	parsed, err := strconv.Unquote(value)
	if err != nil {
		return "", err
	}
	return parsed, nil
}

func stripTOMLComment(line string) string {
	var quote rune
	escaped := false
	for index, char := range line {
		if escaped {
			escaped = false
			continue
		}
		if quote == '"' && char == '\\' {
			escaped = true
			continue
		}
		if char == '\'' || char == '"' {
			if quote == 0 {
				quote = char
			} else if quote == char {
				quote = 0
			}
			continue
		}
		if char == '#' && quote == 0 {
			return line[:index]
		}
	}
	return line
}

func cargoSubjects(packages []cargoPackage) ([]subject, int, error) {
	subjects := make([]subject, 0, len(packages))
	skippedLocal := 0
	for _, pkg := range packages {
		// The source-less root/workspace package is not a third-party crate and
		// has no meaningful Cargo ecosystem identity in OSV.
		if pkg.Source == "" {
			skippedLocal++
			continue
		}
		purl := "pkg:cargo/" + pkg.Name
		query := osvQuery{
			Version: pkg.Version,
			Package: &osvPackage{PURL: purl},
		}
		if err := query.validate(); err != nil {
			return nil, 0, fmt.Errorf("crate %s %s: %w", pkg.Name, pkg.Version, err)
		}
		subjects = append(subjects, subject{
			Kind:    rustSubject,
			Name:    pkg.Name + "@" + pkg.Version,
			Display: purl + "@" + pkg.Version,
			Query:   query,
		})
	}
	if len(subjects) == 0 {
		return nil, 0, fmt.Errorf("Cargo.lock contains no third-party packages")
	}
	return subjects, skippedLocal, nil
}
