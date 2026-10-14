// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command manifest lists the packages of the pinned golang.org/x modules that
// the Go toolchain builds, and on which platforms, as the Starlark dictionary
// in packages.bzl.
//
// Rules hand Go dependencies around as a map from import path to archive,
// which has to exist at analysis time, before any source is read; this
// manifest is that map's key set. Each module is walked with go/build once
// per GOOS/GOARCH, and a package is kept on a platform when it has Go files
// there, is not a command, and imports only the standard library and other
// kept packages.
//
// Usage:
//
//	manifest (-platform goos/goarch)... (-module importpath=dir)... (-w FILE | -check FILE)
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"go/build"
	"io/fs"
	"maps"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

type module struct {
	path string // import path, e.g. golang.org/x/net
	dir  string // the module's root directory
}

type pkg struct {
	imports []string
}

func main() {
	var platforms, moduleArgs stringList
	flag.Var(&platforms, "platform", "GOOS/GOARCH to list packages for (repeatable)")
	flag.Var(&moduleArgs, "module", "importpath=dir of a module to list (repeatable)")
	write := flag.String("w", "", "write the manifest to this file")
	check := flag.String("check", "", "fail unless this file matches the manifest")
	flag.Parse()

	if (*write == "") == (*check == "") {
		fatalf("exactly one of -w and -check is required")
	}
	if len(platforms) == 0 || len(moduleArgs) == 0 || flag.NArg() != 0 {
		fatalf("usage: manifest (-platform goos/goarch)... (-module importpath=dir)... (-w FILE | -check FILE)")
	}

	var modules []module
	for _, arg := range moduleArgs {
		importPath, dir, ok := strings.Cut(arg, "=")
		if !ok {
			fatalf("-module %q is not importpath=dir", arg)
		}
		modules = append(modules, module{importPath, dir})
	}

	// import path -> platforms it builds on
	available := map[string][]string{}
	// import path -> why it was left out on some platform
	excluded := map[string]string{}
	for _, platform := range platforms {
		goos, goarch, ok := strings.Cut(platform, "/")
		if !ok {
			fatalf("platform %q is not goos/goarch", platform)
		}
		pkgs := map[string]pkg{}
		for _, m := range modules {
			if err := scan(goos, goarch, m, pkgs); err != nil {
				fatalf("%s: %v", m.path, err)
			}
		}
		for importPath, reason := range prune(pkgs) {
			excluded[importPath] = reason
		}
		for importPath := range pkgs {
			available[importPath] = append(available[importPath], platform)
		}
	}

	out := render(platforms, available, excluded)

	if *write != "" {
		if err := os.WriteFile(*write, out, 0o644); err != nil {
			fatalf("%v", err)
		}
		return
	}
	have, err := os.ReadFile(*check)
	if err != nil {
		fatalf("%v", err)
	}
	if !bytes.Equal(have, out) {
		fatalf("%s is out of date with the pinned golang.org/x modules; regenerate it with\n\n"+
			"  buck2 run toolchains//golang/x:manifest -- -w %s\n", *check, *check)
	}
}

// scan adds every package with Go files for goos/goarch under m to pkgs.
func scan(goos, goarch string, m module, pkgs map[string]pkg) error {
	ctxt := build.Default
	ctxt.GOOS = goos
	ctxt.GOARCH = goarch
	ctxt.CgoEnabled = false
	ctxt.GOPATH = ""
	ctxt.Dir = ""

	return filepath.WalkDir(m.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(m.dir, p)
		if err != nil {
			return err
		}
		if rel != "." {
			// The directories `go list ./...` skips, and nested modules.
			name := d.Name()
			if name == "testdata" || name == "vendor" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
				return filepath.SkipDir
			}
			if _, err := os.Stat(filepath.Join(p, "go.mod")); err == nil {
				return filepath.SkipDir
			}
		}

		bp, err := ctxt.ImportDir(p, 0)
		var noGo *build.NoGoError
		if errors.As(err, &noGo) {
			return nil
		}
		if err != nil {
			return err
		}
		if bp.Name == "main" || len(bp.GoFiles) == 0 {
			return nil
		}
		importPath := m.path
		if rel != "." {
			importPath = path.Join(m.path, filepath.ToSlash(rel))
		}
		pkgs[importPath] = pkg{imports: bp.Imports}
		return nil
	})
}

// prune removes, until none remain, packages importing something that is
// neither in the standard library nor in pkgs, and returns why each went.
func prune(pkgs map[string]pkg) map[string]string {
	all := maps.Clone(pkgs)
	for changed := true; changed; {
		changed = false
		for importPath, p := range pkgs {
			if len(missing(p, pkgs)) > 0 {
				delete(pkgs, importPath)
				changed = true
			}
		}
	}

	pruned := map[string]string{}
	for importPath, p := range all {
		if _, ok := pkgs[importPath]; !ok {
			pruned[importPath] = "imports " + strings.Join(missing(p, pkgs), ", ")
		}
	}
	return pruned
}

// missing returns the imports of p that are neither in the standard library
// nor in pkgs.
func missing(p pkg, pkgs map[string]pkg) []string {
	var out []string
	for _, imp := range p.imports {
		if _, ok := pkgs[imp]; !ok && !isStd(imp) {
			out = append(out, imp)
		}
	}
	return out
}

// isStd reports whether importPath names a standard library package, which
// is what `go` assumes of a path whose first element has no dot.
func isStd(importPath string) bool {
	first, _, _ := strings.Cut(importPath, "/")
	return !strings.Contains(first, ".")
}

func render(platforms []string, available map[string][]string, excluded map[string]string) []byte {
	var b bytes.Buffer
	b.WriteString(`# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# @` + `generated by manifest.go; do not edit. Regenerate after changing a module
# version in BUILD with:
#
#   buck2 run toolchains//golang/x:manifest -- -w buck/toolchains/golang/x/packages.bzl

# Every golang.org/x package the toolchain builds, mapped to the GOOS/GOARCH
# platforms it builds on, or to None where that is all of them.
X_PACKAGES = {
`)
	for _, importPath := range sortedKeys(available) {
		plats := available[importPath]
		if slices.Equal(plats, platforms) {
			fmt.Fprintf(&b, "    %q: None,\n", importPath)
			continue
		}
		quoted := make([]string, len(plats))
		for i, p := range plats {
			quoted[i] = fmt.Sprintf("%q", p)
		}
		fmt.Fprintf(&b, "    %q: [%s],\n", importPath, strings.Join(quoted, ", "))
	}
	b.WriteString("}\n")

	var never []string
	for _, importPath := range sortedKeys(excluded) {
		if _, ok := available[importPath]; !ok {
			never = append(never, importPath)
		}
	}
	if len(never) > 0 {
		b.WriteString("\n# Left out because they need a module outside the pinned set:\n#\n")
		for _, importPath := range never {
			fmt.Fprintf(&b, "#   %s %s\n", importPath, excluded[importPath])
		}
	}
	return b.Bytes()
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "manifest: "+format+"\n", args...)
	os.Exit(1)
}
