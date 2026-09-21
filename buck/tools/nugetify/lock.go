// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

const lockVersion = 1

// lockFile is nuget.lock: the resolved package graph with everything the
// BUILD file needs, so emitting it never touches the network. The OSV check
// under buck/tests/osv.io reads the same file.
type lockFile struct {
	Version   int           `json:"version"`
	Framework lockFramework `json:"framework"`
	Packages  []lockPackage `json:"packages"`
}

type lockFramework struct {
	Package string `json:"package"`
	Version string `json:"version"`
	TFM     string `json:"tfm"`
}

type lockPackage struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	// Direct packages are the manifest's; the rest were pulled in by them.
	Direct bool   `json:"direct"`
	SHA256 string `json:"sha256"`
	// The nupkg's SHA-512 in base64, the contentHash NuGet's own lock files
	// record, for comparison with them.
	SHA512 string `json:"sha512"`
	// The folder inside the package whose assemblies the framework consumes,
	// such as lib/net10.0; empty when the package ships none (analyzers,
	// meta-packages).
	Assets       string   `json:"assets,omitempty"`
	Assemblies   []string `json:"assemblies"`
	Symbols      []string `json:"symbols"`
	Dependencies []string `json:"dependencies"`
}

func loadLock(path string) (*lockFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lock, err := parseLock(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return lock, nil
}

func parseLock(data []byte) (*lockFile, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var lock lockFile
	if err := decoder.Decode(&lock); err != nil {
		return nil, err
	}
	if err := lock.validate(); err != nil {
		return nil, err
	}
	return &lock, nil
}

func (l *lockFile) validate() error {
	if l.Version != lockVersion {
		return fmt.Errorf("lock format version is %d; this tool writes %d", l.Version, lockVersion)
	}
	if l.Framework.Package == "" || l.Framework.Version == "" || l.Framework.TFM == "" {
		return fmt.Errorf("framework needs package, version and tfm")
	}
	ids := make(map[string]struct{}, len(l.Packages))
	for index, pkg := range l.Packages {
		if err := validateID(pkg.ID); err != nil {
			return err
		}
		if index > 0 && !lessID(l.Packages[index-1].ID, pkg.ID) {
			return fmt.Errorf("packages are not sorted by id at %s", pkg.ID)
		}
		if _, err := parseVersion(pkg.Version); err != nil {
			return fmt.Errorf("package %s: %w", pkg.ID, err)
		}
		if len(pkg.SHA256) != 64 || strings.Trim(pkg.SHA256, "0123456789abcdef") != "" {
			return fmt.Errorf("package %s: sha256 is not 64 hex digits", pkg.ID)
		}
		if pkg.SHA512 == "" {
			return fmt.Errorf("package %s: missing sha512", pkg.ID)
		}
		if (pkg.Assets == "") != (len(pkg.Assemblies) == 0) {
			return fmt.Errorf("package %s: assets and assemblies must be set together", pkg.ID)
		}
		for _, name := range pkg.Symbols {
			if !contains(pkg.Assemblies, name) {
				return fmt.Errorf("package %s: symbols for %s, which is not one of its assemblies", pkg.ID, name)
			}
		}
		ids[strings.ToLower(pkg.ID)] = struct{}{}
	}
	for _, pkg := range l.Packages {
		for _, dep := range pkg.Dependencies {
			if _, ok := ids[strings.ToLower(dep)]; !ok {
				return fmt.Errorf("package %s depends on %s, which the lock does not contain", pkg.ID, dep)
			}
		}
	}
	return nil
}

// direct lists the manifest-pinned packages the lock was resolved from, so
// a caller can tell whether the manifest still matches it.
func (l *lockFile) direct() []packageRef {
	var refs []packageRef
	for _, pkg := range l.Packages {
		if pkg.Direct {
			refs = append(refs, packageRef{ID: pkg.ID, Version: pkg.Version})
		}
	}
	return refs
}

// matches reports whether resolving the manifest again would reproduce the
// lock: same framework and the same direct pins. Resolution is a function
// of those alone, so an unchanged manifest means an unchanged lock.
func (l *lockFile) matches(m *manifest) bool {
	if l.Framework.Package != m.Framework.ID || l.Framework.Version != m.Framework.Version {
		return false
	}
	direct := l.direct()
	if len(direct) != len(m.Packages) {
		return false
	}
	for index, ref := range m.Packages {
		if direct[index].ID != ref.ID || direct[index].Version != ref.Version {
			return false
		}
	}
	return true
}

func (l *lockFile) find(id string) *lockPackage {
	for index := range l.Packages {
		if strings.EqualFold(l.Packages[index].ID, id) {
			return &l.Packages[index]
		}
	}
	return nil
}

func (l *lockFile) encode() ([]byte, error) {
	sort.Slice(l.Packages, func(i, j int) bool { return lessID(l.Packages[i].ID, l.Packages[j].ID) })
	for index := range l.Packages {
		pkg := &l.Packages[index]
		if pkg.Assemblies == nil {
			pkg.Assemblies = []string{}
		}
		if pkg.Symbols == nil {
			pkg.Symbols = []string{}
		}
		if pkg.Dependencies == nil {
			pkg.Dependencies = []string{}
		}
	}
	if l.Packages == nil {
		l.Packages = []lockPackage{}
	}
	data, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func lessID(left, right string) bool {
	return strings.ToLower(left) < strings.ToLower(right)
}

func contains(items []string, wanted string) bool {
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}
