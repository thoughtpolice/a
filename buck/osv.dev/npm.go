// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// npm 7 and newer write the `packages` map keyed by install location, which is
// the only shape that records an exact version for every installed package. A
// lockfileVersion 1 file carries the legacy nested `dependencies` tree instead
// and is rejected rather than parsed twice.
const (
	minPackageLockVersion = 2
	maxPackageLockVersion = 3
)

const (
	nodeModulesSegment = "node_modules/"
	maxNPMNameLength   = 214
)

type npmPackage struct {
	Name    string
	Version string
}

// npmSkips counts the lockfile entries that carry no npm registry identity, so
// the scan can report what it did not check.
type npmSkips struct {
	Local       int
	NonRegistry int
	Duplicate   int
}

type npmLockEntry struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Resolved string `json:"resolved"`
	Link     bool   `json:"link"`
}

type npmLock struct {
	LockfileVersion *int                    `json:"lockfileVersion"`
	Packages        map[string]npmLockEntry `json:"packages"`
}

func loadPackageLock(path string) ([]npmPackage, npmSkips, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, npmSkips{}, fmt.Errorf("open %s: %w", path, err)
	}
	packages, skips, parseErr := parsePackageLock(file)
	closeErr := file.Close()
	if parseErr != nil {
		return nil, npmSkips{}, fmt.Errorf("parse %s: %w", path, parseErr)
	}
	if closeErr != nil {
		return nil, npmSkips{}, fmt.Errorf("close %s: %w", path, closeErr)
	}
	return packages, skips, nil
}

func parsePackageLock(r io.Reader) ([]npmPackage, npmSkips, error) {
	var lock npmLock
	decoder := json.NewDecoder(r)
	if err := decoder.Decode(&lock); err != nil {
		return nil, npmSkips{}, fmt.Errorf("decode package-lock.json: %w", err)
	}
	// A lockfile is exactly one JSON object; anything after it means the file
	// was concatenated or truncated mid-write.
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return nil, npmSkips{}, fmt.Errorf("package-lock.json has trailing content after the root object")
	}
	if lock.LockfileVersion == nil {
		return nil, npmSkips{}, fmt.Errorf("package-lock.json is missing its lockfileVersion")
	}
	if *lock.LockfileVersion < minPackageLockVersion || *lock.LockfileVersion > maxPackageLockVersion {
		return nil, npmSkips{}, fmt.Errorf("package-lock.json lockfileVersion is %d; expected %d or %d",
			*lock.LockfileVersion, minPackageLockVersion, maxPackageLockVersion)
	}
	if len(lock.Packages) == 0 {
		return nil, npmSkips{}, fmt.Errorf("package-lock.json contains no packages")
	}

	treePaths := make([]string, 0, len(lock.Packages))
	for treePath := range lock.Packages {
		treePaths = append(treePaths, treePath)
	}
	sort.Strings(treePaths)

	var skips npmSkips
	seen := make(map[string]struct{}, len(treePaths))
	packages := make([]npmPackage, 0, len(treePaths))
	for _, treePath := range treePaths {
		entry := lock.Packages[treePath]
		name, installed := npmPackageName(treePath, entry.Name)
		// The root project and workspace members live outside node_modules, and
		// a linked entry is a symlink to one of them rather than an install.
		if !installed || entry.Link {
			skips.Local++
			continue
		}
		if !isRegistryResolution(entry.Resolved) {
			skips.NonRegistry++
			continue
		}
		if entry.Version == "" {
			return nil, npmSkips{}, fmt.Errorf("%s has no version", treePath)
		}
		if err := validateNPMName(name); err != nil {
			return nil, npmSkips{}, fmt.Errorf("%s: %w", treePath, err)
		}
		key := name + "@" + entry.Version
		if _, duplicate := seen[key]; duplicate {
			// npm installs one copy per tree position; a package pinned to the
			// same version in several places is one subject for OSV.
			skips.Duplicate++
			continue
		}
		seen[key] = struct{}{}
		packages = append(packages, npmPackage{Name: name, Version: entry.Version})
	}
	if len(packages) == 0 {
		return nil, skips, fmt.Errorf("package-lock.json contains no registry packages")
	}
	return packages, skips, nil
}

// npmPackageName returns the registry name for one lockfile entry. Keys are
// install paths, so the installed name follows the final node_modules segment;
// an aliased install ("zod-v3": {"name": "zod"}) records the real package name
// in the entry itself.
func npmPackageName(treePath, entryName string) (string, bool) {
	index := strings.LastIndex(treePath, nodeModulesSegment)
	if index < 0 || (index > 0 && treePath[index-1] != '/') {
		return "", false
	}
	installed := treePath[index+len(nodeModulesSegment):]
	if installed == "" {
		return "", false
	}
	if entryName != "" {
		return entryName, true
	}
	return installed, true
}

// isRegistryResolution reports whether an entry was installed from a registry.
// Any http(s) tarball counts, so a private registry mirror scans like the
// public one. Git, file, and workspace resolutions name a source the npm
// ecosystem in OSV cannot describe, and bundled dependencies record no
// resolution at all.
func isRegistryResolution(resolved string) bool {
	return strings.HasPrefix(resolved, "https://") || strings.HasPrefix(resolved, "http://")
}

func validateNPMName(name string) error {
	invalid := func(reason string) error {
		return fmt.Errorf("invalid npm package name %q: %s", name, reason)
	}
	if name == "" || len(name) > maxNPMNameLength {
		return invalid(fmt.Sprintf("names must be 1 to %d characters", maxNPMNameLength))
	}
	segments := []string{name}
	if strings.HasPrefix(name, "@") {
		scope, bare, separated := strings.Cut(name[1:], "/")
		if !separated {
			return invalid("a scoped name needs both a scope and a package name")
		}
		segments = []string{scope, bare}
	}
	for _, segment := range segments {
		if segment == "" {
			return invalid("a name segment is empty")
		}
		if segment[0] == '.' || segment[0] == '_' {
			return invalid("segments may not start with a dot or an underscore")
		}
		if strings.ContainsFunc(segment, func(r rune) bool { return !isNPMNameRune(r) }) {
			return invalid("segments may only contain letters, digits, and -._~")
		}
	}
	return nil
}

func isNPMNameRune(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return r == '-' || r == '.' || r == '_' || r == '~'
}

// npmPURL renders the package URL for an npm package. A scope is the purl
// namespace, so its leading "@" is percent-encoded while the "/" that separates
// it from the name stays literal.
func npmPURL(name string) string {
	if strings.HasPrefix(name, "@") {
		return "pkg:npm/%40" + name[1:]
	}
	return "pkg:npm/" + name
}

func npmSubjects(packages []npmPackage) ([]subject, error) {
	subjects := make([]subject, 0, len(packages))
	for _, pkg := range packages {
		purl := npmPURL(pkg.Name)
		query := osvQuery{
			Version: pkg.Version,
			Package: &osvPackage{PURL: purl},
		}
		if err := query.validate(); err != nil {
			return nil, fmt.Errorf("package %s %s: %w", pkg.Name, pkg.Version, err)
		}
		subjects = append(subjects, subject{
			Kind:    npmSubject,
			Name:    pkg.Name + "@" + pkg.Version,
			Display: purl + "@" + pkg.Version,
			Query:   query,
		})
	}
	if len(subjects) == 0 {
		return nil, fmt.Errorf("package-lock.json contains no registry packages")
	}
	return subjects, nil
}
