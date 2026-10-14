// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const supportedNuGetLockVersion = 1

// nugetLock is the part of buck/third-party/csharp/nuget.lock this check
// reads: the file buck/tools/nugetify writes carries more, which is that
// tool's business.
type nugetLock struct {
	Version  int            `json:"version"`
	Packages []nugetPackage `json:"packages"`
}

type nugetPackage struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

func loadNuGetLock(path string) ([]nugetPackage, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	packages, err := parseNuGetLock(data)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return packages, nil
}

func parseNuGetLock(data []byte) ([]nugetPackage, error) {
	var lock nugetLock
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&lock); err != nil {
		return nil, err
	}
	if lock.Version != supportedNuGetLockVersion {
		return nil, fmt.Errorf("nuget.lock format version is %d; expected %d", lock.Version, supportedNuGetLockVersion)
	}
	seen := make(map[string]struct{}, len(lock.Packages))
	for _, pkg := range lock.Packages {
		if pkg.ID == "" || pkg.Version == "" {
			return nil, fmt.Errorf("a package is missing its id or version")
		}
		key := strings.ToLower(pkg.ID)
		if _, duplicate := seen[key]; duplicate {
			return nil, fmt.Errorf("package %s is listed twice", pkg.ID)
		}
		seen[key] = struct{}{}
	}
	return lock.Packages, nil
}

// nugetSubjects queries OSV by NuGet purl. An empty lock is fine: the
// directory exists before its first package does.
func nugetSubjects(packages []nugetPackage) ([]subject, error) {
	subjects := make([]subject, 0, len(packages))
	for _, pkg := range packages {
		purl := "pkg:nuget/" + pkg.ID
		query := osvQuery{
			Version: pkg.Version,
			Package: &osvPackage{PURL: purl},
		}
		if err := query.validate(); err != nil {
			return nil, fmt.Errorf("package %s %s: %w", pkg.ID, pkg.Version, err)
		}
		subjects = append(subjects, subject{
			Kind:    nugetSubject,
			Name:    pkg.ID + "@" + pkg.Version,
			Display: purl + "@" + pkg.Version,
			Query:   query,
		})
	}
	return subjects, nil
}
