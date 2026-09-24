// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// fakeSource serves packages from memory and records what was asked for.
type fakeSource struct {
	packages map[string][]byte
	origins  map[string]string
	fetched  []string
}

func (f *fakeSource) fetch(_ context.Context, id, version string) ([]byte, string, error) {
	key := strings.ToLower(id + "@" + version)
	f.fetched = append(f.fetched, key)
	data, ok := f.packages[key]
	if !ok {
		return nil, "", fmt.Errorf("no such package")
	}
	return data, f.origins[key], nil
}

func (f *fakeSource) add(t *testing.T, id, version string, deps []testDependency, files ...string) {
	t.Helper()
	if f.packages == nil {
		f.packages = make(map[string][]byte)
	}
	f.packages[strings.ToLower(id+"@"+version)] = makeNupkg(t, id, version, deps, files...)
}

func refPack(t *testing.T, source *fakeSource) packageRef {
	t.Helper()
	source.add(t, "Microsoft.NETCore.App.Ref", "11.0.0-rc.1", nil,
		"ref/net11.0/System.Runtime.dll=",
		"data/PackageOverrides.txt=System.Collections.Immutable|11.0.0-rc.1\nSystem.Memory|4.5.5\n")
	return packageRef{ID: "Microsoft.NETCore.App.Ref", Version: "11.0.0-rc.1"}
}

// A graph shaped like Roslyn's: the direct package depends on a sibling
// pinned exactly, on a framework-provided package, and on an analyzer
// package with no assemblies that itself depends on something real.
func exampleGraph(t *testing.T) *fakeSource {
	t.Helper()
	source := &fakeSource{}
	source.add(t, "Top.CSharp", "5.9.0", []testDependency{
		{framework: "net10.0", id: "Top.Common", rng: "[5.9.0]"},
		{framework: ".NETStandard2.0", id: "Top.Common", rng: "[5.9.0]"},
		{framework: ".NETStandard2.0", id: "System.Memory", rng: "4.5.5"},
	}, "lib/net10.0/Top.CSharp.dll=", "lib/net10.0/Top.CSharp.pdb=", "lib/netstandard2.0/Top.CSharp.dll=")
	source.add(t, "Top.Common", "5.9.0", []testDependency{
		{framework: "net10.0", id: "System.Collections.Immutable", rng: "10.0.0"},
		{framework: "net10.0", id: "Top.Analyzers", rng: "3.11.0", exclude: "Build,Analyzers"},
	}, "lib/net10.0/Top.dll=", "lib/net10.0/Top.pdb=")
	source.add(t, "Top.Analyzers", "3.11.0", []testDependency{
		{id: "Leaf.Cecil", rng: "0.11.0"},
	}, "analyzers/dotnet/cs/Top.Analyzers.dll=")
	source.add(t, "Leaf.Cecil", "0.11.0", nil, "lib/netstandard2.0/Leaf.Cecil.dll=", "lib/netstandard2.0/Leaf.Cecil.Rocks.dll=", "lib/netstandard2.0/Leaf.Cecil.Rocks.pdb=")
	source.add(t, "Leaf.Cecil", "0.11.6", nil, "lib/netstandard2.0/Leaf.Cecil.dll=", "lib/netstandard2.0/Leaf.Cecil.Rocks.dll=")
	return source
}

func TestResolveBuildsTheLock(t *testing.T) {
	source := exampleGraph(t)
	m := &manifest{Framework: refPack(t, source), Packages: []packageRef{{ID: "Top.CSharp", Version: "5.9.0"}}}
	lock, err := resolve(context.Background(), source, m)
	if err != nil {
		t.Fatal(err)
	}
	if lock.Framework != (lockFramework{Package: "Microsoft.NETCore.App.Ref", Version: "11.0.0-rc.1", TFM: "net11.0"}) {
		t.Fatalf("framework = %+v", lock.Framework)
	}
	var summary []string
	for _, pkg := range lock.Packages {
		summary = append(summary, fmt.Sprintf("%s@%s direct=%t assets=%s asm=%v pdb=%v deps=%v", pkg.ID, pkg.Version, pkg.Direct, pkg.Assets, pkg.Assemblies, pkg.Symbols, pkg.Dependencies))
	}
	want := []string{
		"Leaf.Cecil@0.11.0 direct=false assets=lib/netstandard2.0 asm=[Leaf.Cecil Leaf.Cecil.Rocks] pdb=[Leaf.Cecil.Rocks] deps=[]",
		"Top.Analyzers@3.11.0 direct=false assets= asm=[] pdb=[] deps=[Leaf.Cecil]",
		"Top.Common@5.9.0 direct=false assets=lib/net10.0 asm=[Top] pdb=[Top] deps=[Top.Analyzers]",
		"Top.CSharp@5.9.0 direct=true assets=lib/net10.0 asm=[Top.CSharp] pdb=[Top.CSharp] deps=[Top.Common]",
	}
	if !reflect.DeepEqual(summary, want) {
		t.Fatalf("lock:\n%s\nwant:\n%s", strings.Join(summary, "\n"), strings.Join(want, "\n"))
	}
	for _, key := range source.fetched {
		if strings.HasPrefix(key, "system.") {
			t.Fatalf("a framework-provided package was fetched: %s", key)
		}
	}
	if lock.Packages[0].SHA256 == "" || lock.Packages[0].SHA512 == "" {
		t.Fatal("hashes are missing")
	}
	if err := lock.validate(); err != nil {
		t.Fatal(err)
	}
}

func TestResolveRaisesAFloorButNotAPin(t *testing.T) {
	source := exampleGraph(t)
	source.add(t, "Wants.Newer", "1.0.0", []testDependency{{id: "Leaf.Cecil", rng: "0.11.6"}}, "lib/netstandard2.0/Wants.Newer.dll=")
	m := &manifest{Framework: refPack(t, source), Packages: []packageRef{
		{ID: "Top.CSharp", Version: "5.9.0"},
		{ID: "Wants.Newer", Version: "1.0.0"},
	}}
	lock, err := resolve(context.Background(), source, m)
	if err != nil {
		t.Fatal(err)
	}
	if cecil := lock.find("Leaf.Cecil"); cecil == nil || cecil.Version != "0.11.6" || cecil.Direct {
		t.Fatalf("Leaf.Cecil = %+v", cecil)
	}

	m.Packages = append(m.Packages, packageRef{ID: "Leaf.Cecil", Version: "0.11.0"})
	if _, err := resolve(context.Background(), source, m); err == nil || !strings.Contains(err.Error(), "nuget.toml pins Leaf.Cecil 0.11.0") {
		t.Fatalf("a pin below a dependency's floor was accepted: %v", err)
	}
}

func TestResolveInsistsOnThePackageSpelling(t *testing.T) {
	source := exampleGraph(t)
	m := &manifest{Framework: refPack(t, source), Packages: []packageRef{{ID: "top.csharp", Version: "5.9.0"}}}
	if _, err := resolve(context.Background(), source, m); err == nil || !strings.Contains(err.Error(), "spells Top.CSharp") {
		t.Fatalf("expected a spelling error, got %v", err)
	}
}

func TestResolveNeedsARealTargetingPack(t *testing.T) {
	source := &fakeSource{}
	source.add(t, "Not.A.Pack", "1.0.0", nil, "lib/net8.0/Not.A.Pack.dll=")
	m := &manifest{Framework: packageRef{ID: "Not.A.Pack", Version: "1.0.0"}}
	if _, err := resolve(context.Background(), source, m); err == nil || !strings.Contains(err.Error(), "ref/<tfm>/") {
		t.Fatalf("expected a targeting pack error, got %v", err)
	}
	m.Framework = packageRef{ID: "Missing", Version: "1.0.0"}
	if _, err := resolve(context.Background(), source, m); err == nil {
		t.Fatal("a missing targeting pack resolved")
	}
}
