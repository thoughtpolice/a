// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
)

// manifest is nuget.toml: the targeting pack that fixes the framework, the
// packages first-party code may reference, each pinned to one version, and
// the feeds besides nuget.org a package may come from, tried in order after
// it.
type manifest struct {
	Framework packageRef
	Packages  []packageRef
	Sources   []string
}

type packageRef struct {
	ID      string
	Version string
}

func loadManifest(path string) (*manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	parsed, err := parseManifest(file)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return parsed, nil
}

// parseManifest reads the subset of TOML the manifest uses: the [framework]
// table with `package` and `version` keys, the [packages] table mapping a
// (usually quoted) package id to a version string, and the [sources] table
// naming NuGet V3 flat-container base URLs. Parsing it here keeps
// the tool free of a TOML module the repository would otherwise have to
// carry for two tables of strings.
func parseManifest(r io.Reader) (*manifest, error) {
	result := &manifest{}
	seen := make(map[string]struct{})
	table := ""
	scanner := bufio.NewScanner(r)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(stripComment(scanner.Text()))
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "[") {
			if !strings.HasSuffix(text, "]") || strings.HasPrefix(text, "[[") {
				return nil, fmt.Errorf("line %d: malformed table header %q", line, text)
			}
			table = strings.TrimSpace(text[1 : len(text)-1])
			if table != "framework" && table != "packages" && table != "sources" {
				return nil, fmt.Errorf("line %d: unsupported table %q; nuget.toml has [framework], [packages] and [sources]", line, table)
			}
			continue
		}
		rawKey, rawValue, ok := strings.Cut(text, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected key = \"value\"", line)
		}
		key, err := parseKey(strings.TrimSpace(rawKey))
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		value, err := parseString(strings.TrimSpace(rawValue))
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		switch table {
		case "framework":
			switch key {
			case "package":
				result.Framework.ID = value
			case "version":
				result.Framework.Version = value
			default:
				return nil, fmt.Errorf("line %d: [framework] has no key %q", line, key)
			}
		case "packages":
			if _, duplicate := seen[strings.ToLower(key)]; duplicate {
				return nil, fmt.Errorf("line %d: package %q is listed twice", line, key)
			}
			seen[strings.ToLower(key)] = struct{}{}
			result.Packages = append(result.Packages, packageRef{ID: key, Version: value})
		case "sources":
			if !strings.HasPrefix(value, "https://") {
				return nil, fmt.Errorf("line %d: source %q is not an https URL", line, key)
			}
			if !strings.HasSuffix(value, "/") {
				value += "/"
			}
			result.Sources = append(result.Sources, value)
		default:
			return nil, fmt.Errorf("line %d: key %q outside a table", line, key)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if result.Framework.ID == "" || result.Framework.Version == "" {
		return nil, fmt.Errorf("[framework] needs both package and version")
	}
	if _, err := parseVersion(result.Framework.Version); err != nil {
		return nil, fmt.Errorf("[framework] version: %w", err)
	}
	for _, ref := range result.Packages {
		if err := validateID(ref.ID); err != nil {
			return nil, err
		}
		if _, err := parseVersion(ref.Version); err != nil {
			return nil, fmt.Errorf("package %s: %w", ref.ID, err)
		}
	}
	sort.Slice(result.Packages, func(i, j int) bool {
		return strings.ToLower(result.Packages[i].ID) < strings.ToLower(result.Packages[j].ID)
	})
	return result, nil
}

func (m *manifest) hasSource(source string) bool {
	for _, candidate := range m.Sources {
		if candidate == source {
			return true
		}
	}
	return false
}

// validateID accepts NuGet package ids, which are also used verbatim as
// target names: letters, digits, dots, underscores and hyphens.
func validateID(id string) error {
	if id == "" {
		return fmt.Errorf("empty package id")
	}
	for _, char := range id {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9', char == '.', char == '_', char == '-':
		default:
			return fmt.Errorf("package id %q contains %q", id, char)
		}
	}
	return nil
}

func parseKey(raw string) (string, error) {
	if strings.HasPrefix(raw, "\"") || strings.HasPrefix(raw, "'") {
		return parseString(raw)
	}
	if raw == "" {
		return "", fmt.Errorf("empty key")
	}
	return raw, nil
}

func parseString(raw string) (string, error) {
	if len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' {
		return raw[1 : len(raw)-1], nil
	}
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		value, err := strconv.Unquote(raw)
		if err != nil {
			return "", fmt.Errorf("invalid string %s", raw)
		}
		return value, nil
	}
	return "", fmt.Errorf("expected a quoted string, got %s", raw)
}

func stripComment(line string) string {
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
