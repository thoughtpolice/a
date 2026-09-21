// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// resolver turns the manifest into a lock the way NuGet restores a project:
// every dependency is taken at the lowest version its range allows, a
// package two dependents disagree on gets the higher of the two floors, and
// anything the targeting pack already supplies is left to the framework.
type resolver struct {
	source    packageSource
	target    framework
	overrides map[string]version
	fetched   map[string]*nupkg // lower id@version
}

// choice is the version currently selected for one package id.
type choice struct {
	id       string // as the manifest or a nuspec spells it
	version  version
	direct   bool
	wantedBy string
}

func resolve(ctx context.Context, source packageSource, m *manifest) (*lockFile, error) {
	r := &resolver{source: source, fetched: make(map[string]*nupkg)}
	if err := r.loadFramework(ctx, m.Framework); err != nil {
		return nil, err
	}
	chosen := make(map[string]*choice)
	var queue []string
	for _, ref := range m.Packages {
		parsed, _ := parseVersion(ref.Version)
		key := strings.ToLower(ref.ID)
		chosen[key] = &choice{id: ref.ID, version: parsed, direct: true, wantedBy: "nuget.toml"}
		queue = append(queue, key)
	}

	processed := make(map[string]struct{})
	for len(queue) > 0 {
		key := queue[0]
		queue = queue[1:]
		current := chosen[key]
		stamp := key + "@" + current.version.String()
		if _, done := processed[stamp]; done {
			continue
		}
		processed[stamp] = struct{}{}

		pkg, err := r.fetch(ctx, current.id, current.version.String())
		if err != nil {
			return nil, err
		}
		if pkg.ID != current.id {
			if current.direct {
				return nil, fmt.Errorf("nuget.toml spells %s as %q; use the package's own spelling, which names its target", pkg.ID, current.id)
			}
			current.id = pkg.ID
		}
		for _, dep := range pkg.dependenciesFor(r.target) {
			floor, err := lowerBound(dep.Range)
			if err != nil {
				return nil, fmt.Errorf("%s %s depends on %s %q: %w", pkg.ID, pkg.Version, dep.ID, dep.Range, err)
			}
			if r.providedByFramework(dep.ID, floor) {
				continue
			}
			depKey := strings.ToLower(dep.ID)
			existing, ok := chosen[depKey]
			switch {
			case !ok:
				chosen[depKey] = &choice{id: dep.ID, version: floor, wantedBy: pkg.ID + " " + pkg.Version}
				queue = append(queue, depKey)
			case floor.compare(existing.version) > 0 && existing.direct:
				return nil, fmt.Errorf("%s %s needs %s %s or newer, but nuget.toml pins %s %s", pkg.ID, pkg.Version, dep.ID, floor, existing.id, existing.version)
			case floor.compare(existing.version) > 0:
				existing.version = floor
				existing.wantedBy = pkg.ID + " " + pkg.Version
				queue = append(queue, depKey)
			}
		}
	}

	lock := &lockFile{
		Version: lockVersion,
		Framework: lockFramework{
			Package: m.Framework.ID,
			Version: m.Framework.Version,
			TFM:     r.target.text,
		},
	}
	for _, current := range chosen {
		pkg, err := r.fetch(ctx, current.id, current.version.String())
		if err != nil {
			return nil, err
		}
		folder, assemblies, symbols, err := pkg.assets(r.target)
		if err != nil {
			return nil, err
		}
		var deps []string
		for _, dep := range pkg.dependenciesFor(r.target) {
			if selected, ok := chosen[strings.ToLower(dep.ID)]; ok {
				deps = append(deps, selected.id)
			}
		}
		sort.Slice(deps, func(i, j int) bool { return lessID(deps[i], deps[j]) })
		lock.Packages = append(lock.Packages, lockPackage{
			ID:           pkg.ID,
			Version:      pkg.Version,
			Direct:       current.direct,
			SHA256:       pkg.SHA256,
			SHA512:       pkg.SHA512,
			Assets:       folder,
			Assemblies:   assemblies,
			Symbols:      symbols,
			Dependencies: deps,
		})
	}
	sort.Slice(lock.Packages, func(i, j int) bool { return lessID(lock.Packages[i].ID, lock.Packages[j].ID) })
	return lock, nil
}

// loadFramework reads the targeting pack: its single ref/<tfm>/ folder names
// the framework, and data/PackageOverrides.txt lists what it supplies.
func (r *resolver) loadFramework(ctx context.Context, ref packageRef) error {
	pack, err := r.fetch(ctx, ref.ID, ref.Version)
	if err != nil {
		return fmt.Errorf("targeting pack: %w", err)
	}
	tfms := make(map[string]struct{})
	for _, entry := range pack.Entries {
		parts := strings.Split(entry, "/")
		if len(parts) >= 3 && strings.EqualFold(parts[0], "ref") {
			tfms[parts[1]] = struct{}{}
		}
	}
	if len(tfms) != 1 {
		return fmt.Errorf("targeting pack %s %s should have exactly one ref/<tfm>/ folder, found %d", ref.ID, ref.Version, len(tfms))
	}
	for tfm := range tfms {
		parsed, ok := parseFramework(tfm)
		if !ok || parsed.family != "net" {
			return fmt.Errorf("targeting pack %s %s targets %s, which this tool does not model", ref.ID, ref.Version, tfm)
		}
		r.target = parsed
	}
	overrides, err := pack.file("data/PackageOverrides.txt")
	if err != nil {
		return err
	}
	r.overrides, err = parseOverrides(string(overrides))
	return err
}

func (r *resolver) providedByFramework(id string, floor version) bool {
	provided, ok := r.overrides[strings.ToLower(id)]
	return ok && floor.compare(provided) <= 0
}

func (r *resolver) fetch(ctx context.Context, id, version string) (*nupkg, error) {
	key := strings.ToLower(id + "@" + version)
	if pkg, ok := r.fetched[key]; ok {
		return pkg, nil
	}
	data, err := r.source.fetch(ctx, id, version)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", id, version, err)
	}
	pkg, err := readNupkg(data)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", id, version, err)
	}
	if !strings.EqualFold(pkg.ID, id) || pkg.Version != version {
		return nil, fmt.Errorf("%s %s: the package calls itself %s %s", id, version, pkg.ID, pkg.Version)
	}
	r.fetched[key] = pkg
	return pkg, nil
}
