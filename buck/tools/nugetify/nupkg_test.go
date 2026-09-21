// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// testDependency is one <dependency> for makeNupkg.
type testDependency struct {
	framework string
	id        string
	rng       string
	exclude   string
}

// makeNupkg builds an in-memory package: a nuspec with the given
// dependencies and the listed files (contents are irrelevant to the tool).
func makeNupkg(t *testing.T, id, version string, deps []testDependency, files ...string) []byte {
	t.Helper()
	groups := make(map[string][]testDependency)
	var order []string
	for _, dep := range deps {
		if _, ok := groups[dep.framework]; !ok {
			order = append(order, dep.framework)
		}
		groups[dep.framework] = append(groups[dep.framework], dep)
	}
	var nuspec strings.Builder
	fmt.Fprintf(&nuspec, `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>%s</id>
    <version>%s</version>
    <dependencies>
`, id, version)
	for _, framework := range order {
		if framework == "" {
			nuspec.WriteString("      <group>\n")
		} else {
			fmt.Fprintf(&nuspec, "      <group targetFramework=%q>\n", framework)
		}
		for _, dep := range groups[framework] {
			fmt.Fprintf(&nuspec, "        <dependency id=%q version=%q", dep.id, dep.rng)
			if dep.exclude != "" {
				fmt.Fprintf(&nuspec, " exclude=%q", dep.exclude)
			}
			nuspec.WriteString(" />\n")
		}
		nuspec.WriteString("      </group>\n")
	}
	nuspec.WriteString("    </dependencies>\n  </metadata>\n</package>\n")

	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	add := func(name, content string) {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	add(id+".nuspec", nuspec.String())
	for _, file := range files {
		name, content, _ := strings.Cut(file, "=")
		add(name, content)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestReadNupkg(t *testing.T) {
	data := makeNupkg(t, "Sample.Package", "1.2.0", []testDependency{
		{framework: "net8.0", id: "Dep.Net", rng: "[2.0.0, )"},
		{framework: "net8.0", id: "Dep.Analyzers", rng: "1.0.0", exclude: "Build,Analyzers"},
		{framework: "net8.0", id: "Dep.Nothing", rng: "1.0.0", exclude: "Compile, Runtime"},
		{framework: ".NETStandard2.0", id: "Dep.Standard", rng: "1.0.0"},
		{framework: "", id: "Dep.Everywhere", rng: "3.0.0"},
	}, "lib/net8.0/Sample.Package.dll=", "lib/net8.0/Sample.Package.pdb=", "lib/net8.0/Sample.Extra.dll=",
		"lib/netstandard2.0/Sample.Package.dll=", "lib/net8.0/xml/Sample.Package.xml=")
	pkg, err := readNupkg(data)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.ID != "Sample.Package" || pkg.Version != "1.2.0" {
		t.Fatalf("package = %s %s", pkg.ID, pkg.Version)
	}
	if len(pkg.SHA256) != 64 || pkg.SHA512 == "" {
		t.Fatalf("hashes = %q %q", pkg.SHA256, pkg.SHA512)
	}

	target, _ := parseFramework("net11.0")
	deps := pkg.dependenciesFor(target)
	want := []dependency{{ID: "Dep.Net", Range: "[2.0.0, )"}, {ID: "Dep.Analyzers", Range: "1.0.0"}}
	if !reflect.DeepEqual(deps, want) {
		t.Fatalf("net11.0 dependencies = %+v, want %+v", deps, want)
	}
	folder, assemblies, symbols, err := pkg.assets(target)
	if err != nil {
		t.Fatal(err)
	}
	if folder != "lib/net8.0" || !reflect.DeepEqual(assemblies, []string{"Sample.Extra", "Sample.Package"}) || !reflect.DeepEqual(symbols, []string{"Sample.Package"}) {
		t.Fatalf("assets = %q %v %v", folder, assemblies, symbols)
	}

	old, _ := parseFramework("net5.0")
	if deps := pkg.dependenciesFor(old); !reflect.DeepEqual(deps, []dependency{{ID: "Dep.Standard", Range: "1.0.0"}}) {
		t.Fatalf("net5.0 dependencies = %+v", deps)
	}
}

func TestReadNupkgFallbackGroupAndNoAssets(t *testing.T) {
	target, _ := parseFramework("net11.0")
	pkg, err := readNupkg(makeNupkg(t, "Analyzers.Only", "1.0.0", []testDependency{{id: "Dep.Everywhere", rng: "3.0.0"}},
		"lib/netstandard2.0/_._=", "analyzers/dotnet/cs/Analyzers.Only.dll="))
	if err != nil {
		t.Fatal(err)
	}
	if deps := pkg.dependenciesFor(target); !reflect.DeepEqual(deps, []dependency{{ID: "Dep.Everywhere", Range: "3.0.0"}}) {
		t.Fatalf("dependencies = %+v", deps)
	}
	folder, assemblies, _, err := pkg.assets(target)
	if err != nil || folder != "" || assemblies != nil {
		t.Fatalf("placeholder assets = %q %v %v", folder, assemblies, err)
	}

	pkg, err = readNupkg(makeNupkg(t, "Tools.Only", "1.0.0", nil, "tools/run.sh="))
	if err != nil {
		t.Fatal(err)
	}
	if folder, _, _, err := pkg.assets(target); err != nil || folder != "" {
		t.Fatalf("tool-only assets = %q %v", folder, err)
	}

	pkg, err = readNupkg(makeNupkg(t, "Too.New", "1.0.0", nil, "lib/net12.0/Too.New.dll="))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := pkg.assets(target); err == nil {
		t.Fatal("an incompatible lib folder was accepted")
	}
}

func TestReadNupkgRejectsJunk(t *testing.T) {
	if _, err := readNupkg([]byte("not a zip")); err == nil {
		t.Fatal("non-zip data parsed")
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, _ := writer.Create("lib/net8.0/X.dll")
	entry.Write([]byte("x"))
	writer.Close()
	if _, err := readNupkg(buffer.Bytes()); err == nil {
		t.Fatal("a package without a nuspec parsed")
	}
}
