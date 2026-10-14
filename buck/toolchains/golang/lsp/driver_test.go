// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json/v2"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeJSON(t *testing.T, path string, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return writeFile(t, path, string(b))
}

func TestParseQuery(t *testing.T) {
	cwd := t.TempDir()
	writeFile(t, filepath.Join(cwd, "a", "a.go"), "package a\n")
	writeFile(t, filepath.Join(cwd, "a", "b", "b.go"), "package b\n")

	q, ok := parseQuery([]string{"file=a/a.go", "builtin", "example.com/p", "golang.org/x/..."}, cwd)
	if !ok {
		t.Fatal("not handled")
	}
	want := filepath.Join(cwd, "a", "a.go")
	if !slices.Equal(q.files, []string{want}) || !q.named[want] || !q.builtin || !slices.Equal(q.paths, []string{"example.com/p"}) {
		t.Errorf("got %+v", q)
	}

	q, _ = parseQuery([]string{"./a"}, cwd)
	if !slices.Equal(q.files, []string{want}) || q.named[want] {
		t.Errorf("./a: got %+v", q)
	}
	q, _ = parseQuery([]string{"./..."}, cwd)
	if len(q.files) != 2 {
		t.Errorf("./...: got %v", q.files)
	}

	// A standalone script is go list's to answer.
	if _, ok := parseQuery([]string{filepath.Join(cwd, "script.go")}, cwd); ok {
		t.Error("a standalone file was handled")
	}
}

func TestGoFilesSkips(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".buckroot"), "")
	keep := []string{
		writeFile(t, filepath.Join(root, "main.go"), ""),
		writeFile(t, filepath.Join(root, "src", "lib", "lib.go"), ""),
	}
	for _, skip := range []string{
		"src/testdata/t.go",
		"src/_hidden/h.go",
		"src/.cache/c.go",
		"buck-out/v2/gen.go",
		"node_modules/m/m.go",
		"work/ws/main.go",
		"nested/.buckroot",
		"nested/n.go",
		"src/lib/README.md",
	} {
		writeFile(t, filepath.Join(root, skip), "")
	}
	got := goFiles(root, true)
	slices.Sort(got)
	if !slices.Equal(got, keep) {
		t.Errorf("got %v, want %v", got, keep)
	}
	if got := goFiles(filepath.Join(root, "buck-out", "v2"), true); got != nil {
		t.Errorf("in buck-out: got %v", got)
	}
}

// fixture lays out what gopls.bxl:packages would point at: a GOROOT with a
// stdlib listing, a golang.org/x package, and two targets, one a test that
// imports a library.
type fixture struct {
	root, goroot, xdir string
	out                *buckOutput
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	f := &fixture{root: filepath.Join(dir, "repo"), goroot: filepath.Join(dir, "goroot")}
	writeFile(t, filepath.Join(f.goroot, "VERSION"), "go1.27.2\ntime 2026-10-01T00:00:00Z\n")
	stdlib := writeJSON(t, filepath.Join(dir, "stdlib.json"), []map[string]any{
		{"ImportPath": "fmt", "Name": "fmt", "GoFiles": []string{"print.go"}, "Imports": []string{"strings"}},
		{"ImportPath": "strings", "Name": "strings", "GoFiles": []string{"strings.go"}, "SFiles": []string{"strings_arm64.s"}},
		{
			"ImportPath": "net", "Name": "net", "GoFiles": []string{"net.go"}, "IgnoredGoFiles": []string{"cgo.go"},
			"Imports":   []string{"vendor/golang.org/x/net/dns/dnsmessage"},
			"ImportMap": map[string]string{"golang.org/x/net/dns/dnsmessage": "vendor/golang.org/x/net/dns/dnsmessage"},
		},
		{"ImportPath": "vendor/golang.org/x/net/dns/dnsmessage", "Name": "dnsmessage", "GoFiles": []string{"message.go"}},
	})
	f.xdir = filepath.Join(dir, "module-text", "cases")
	xlist := writeJSON(t, filepath.Join(dir, "cases.json"), map[string]any{
		"Name": "cases", "GoFiles": []string{"cases.go"}, "Imports": []string{"strings"},
	})

	lib := filepath.Join(f.root, "src", "lib")
	tool := filepath.Join(f.root, "src", "tool")
	f.out = &buckOutput{
		Importable: &importable{
			GOOS: "linux", GOARCH: "arm64", GOROOT: f.goroot, Stdlib: stdlib,
			X: map[string][2]string{"golang.org/x/text/cases": {xlist, f.xdir}},
		},
		Root: f.root,
		Packages: map[string]*target{
			"depot//src/lib:lib": {
				Files:   map[string]string{"lib.go": writeFile(t, filepath.Join(lib, "lib.go"), "package lib\n")},
				GoList:  writeJSON(t, filepath.Join(dir, "lib.json"), map[string]any{"Name": "lib", "GoFiles": []string{"lib.go"}, "Imports": []string{"fmt"}}),
				Kind:    "go_library",
				PkgPath: "src/lib",
			},
			"depot//src/tool:unit": {
				Deps: []string{"depot//src/lib:lib"},
				Files: map[string]string{
					"main.go":      writeFile(t, filepath.Join(tool, "main.go"), "package main\n"),
					"main_test.go": writeFile(t, filepath.Join(tool, "main_test.go"), "package main\n"),
					"x_test.go":    writeFile(t, filepath.Join(tool, "x_test.go"), "package main_test\n"),
					"win.go":       writeFile(t, filepath.Join(tool, "win.go"), "package main\n"),
				},
				GoList: writeJSON(t, filepath.Join(dir, "unit.json"), map[string]any{
					"Name":           "main",
					"GoFiles":        []string{"main.go"},
					"TestGoFiles":    []string{"main_test.go"},
					"XTestGoFiles":   []string{"x_test.go"},
					"IgnoredGoFiles": []string{"win.go"},
					"Imports":        []string{"src/lib", "golang.org/x/text/cases"},
					"TestImports":    []string{"net", "example.com/missing"},
				}),
				Kind:    "go_test_internal",
				PkgPath: "src/tool",
				Root:    true,
			},
		},
	}
	return f
}

func byID(resp *response) map[string]*pkg {
	pkgs := map[string]*pkg{}
	for _, p := range resp.Packages {
		pkgs[p.ID] = p
	}
	return pkgs
}

func TestAssemble(t *testing.T) {
	f := newFixture(t)
	tool := filepath.Join(f.root, "src", "tool")
	resp, err := assemble(f.out, query{named: map[string]bool{}, builtin: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.GoVersion != 27 || resp.Arch != "arm64" || resp.Compiler != "gc" {
		t.Errorf("response header: %+v", resp)
	}
	if !slices.Equal(resp.Roots, []string{"builtin", "depot//src/tool:unit"}) {
		t.Errorf("roots: %v", resp.Roots)
	}
	pkgs := byID(resp)

	unit := pkgs["depot//src/tool:unit"]
	if unit == nil {
		t.Fatalf("no test package in %v", resp.Packages)
	}
	if want := []string{filepath.Join(tool, "main.go"), filepath.Join(tool, "main_test.go")}; !slices.Equal(unit.CompiledGoFiles, want) {
		t.Errorf("test files: %v", unit.CompiledGoFiles)
	}
	if want := []string{filepath.Join(tool, "win.go"), filepath.Join(tool, "x_test.go")}; !slices.Equal(unit.IgnoredFiles, want) {
		t.Errorf("ignored files: %v", unit.IgnoredFiles)
	}

	// Its library by label, x and the stdlib by import path, and nothing for
	// an import no target provides.
	wantImports := map[string]string{
		"src/lib":                 "depot//src/lib:lib",
		"golang.org/x/text/cases": "golang.org/x/text/cases",
		"net":                     "net",
	}
	if !maps.Equal(unit.Imports, wantImports) {
		t.Errorf("test imports: %v", unit.Imports)
	}
	if got := pkgs["depot//src/lib:lib"].Imports["fmt"]; got != "fmt" {
		t.Errorf("library imports fmt as %q", got)
	}
	for _, id := range []string{"fmt", "strings", "golang.org/x/text/cases"} {
		if pkgs[id] == nil {
			t.Errorf("missing %s", id)
		}
	}
	if s := pkgs["strings"]; !slices.Equal(s.OtherFiles, []string{filepath.Join(f.goroot, "src", "strings", "strings_arm64.s")}) {
		t.Errorf("strings other files: %v", s.OtherFiles)
	}

	// The stdlib's vendored imports keep the path the source writes.
	net := pkgs["net"]
	if got := net.Imports["golang.org/x/net/dns/dnsmessage"]; got != "vendor/golang.org/x/net/dns/dnsmessage" {
		t.Errorf("net imports: %v", net.Imports)
	}
	if len(net.GoFiles) != 1 || len(net.CompiledGoFiles) != 1 || len(net.IgnoredFiles) != 1 {
		t.Errorf("net files: %v, compiled %v, ignored %v", net.GoFiles, net.CompiledGoFiles, net.IgnoredFiles)
	}

	builtin := pkgs["builtin"]
	if builtin == nil || builtin.GoFiles[0] != filepath.Join(f.goroot, "src", "builtin", "builtin.go") {
		t.Errorf("builtin: %+v", builtin)
	}
}

func TestOverlayImports(t *testing.T) {
	f := newFixture(t)
	lib := filepath.Join(f.root, "src", "lib", "lib.go")
	overlay := map[string][]byte{lib: []byte("package lib\n\nimport (\n\t\"fmt\"\n\tc \"golang.org/x/text/cases\"\n)\n")}
	resp, err := assemble(f.out, query{named: map[string]bool{}}, overlay)
	if err != nil {
		t.Fatal(err)
	}
	if got := byID(resp)["depot//src/lib:lib"].Imports["golang.org/x/text/cases"]; got != "golang.org/x/text/cases" {
		t.Errorf("unsaved import resolved to %q", got)
	}
}

func TestUnownedFile(t *testing.T) {
	f := newFixture(t)
	file := writeFile(t, filepath.Join(f.root, "src", "new", "new.go"), "package new\n\nimport \"fmt\"\n")
	f.out.Unowned = []string{file}
	resp, err := assemble(f.out, query{files: []string{file}, named: map[string]bool{file: true}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := byID(resp)["file="+file]
	if p == nil {
		t.Fatalf("no package for %s in %v", file, resp.Roots)
	}
	if p.Name != "new" || p.PkgPath != "src/new" || p.Imports["fmt"] != "fmt" {
		t.Errorf("got %+v", p)
	}
	if len(p.Errors) != 1 || p.Errors[0].Pos != file+":1:1" || !strings.Contains(p.Errors[0].Msg, "srcs of no go_binary") {
		t.Errorf("errors: %+v", p.Errors)
	}

	// A file excluded by build constraints is a target's, ignored: gopls says
	// so itself.
	win := filepath.Join(f.root, "src", "tool", "win.go")
	resp, err = assemble(f.out, query{files: []string{win}, named: map[string]bool{win: true}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if byID(resp)["file="+win] != nil {
		t.Error("an ignored file got a package of its own")
	}
}

// An editor can ask about a file of the stdlib or golang.org/x directly, as
// one that roots a workspace folder at the nearest go.mod does after jumping
// to a definition there.
func TestDependencyFile(t *testing.T) {
	f := newFixture(t)
	f.out.Packages = nil // Buck owns nothing there
	for file, want := range map[string]string{
		filepath.Join(f.xdir, "cases.go"):                       "golang.org/x/text/cases",
		filepath.Join(f.goroot, "src", "strings", "strings.go"): "strings",
	} {
		resp, err := assemble(f.out, query{files: []string{file}, named: map[string]bool{file: true}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(resp.Roots, []string{want}) {
			t.Errorf("%s: roots %v, want %s", file, resp.Roots, want)
		}
	}
}

func TestBootstrapBinary(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.root, "src", "boot")
	f.out.Packages = map[string]*target{"depot//src/boot:gen": {
		Files: map[string]string{
			"gen.go":         writeFile(t, filepath.Join(dir, "gen.go"), "package main\n\nimport \"fmt\"\n"),
			"gen_windows.go": writeFile(t, filepath.Join(dir, "gen_windows.go"), "package main\n\nimport \"strings\"\n"),
		},
		Kind:    "go_bootstrap_binary",
		PkgPath: "src/boot",
		Root:    true,
	}}
	resp, err := assemble(f.out, query{named: map[string]bool{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := byID(resp)["depot//src/boot:gen"]
	if p.Name != "main" || len(p.CompiledGoFiles) != 1 || len(p.IgnoredFiles) != 1 || !maps.Equal(p.Imports, map[string]string{"fmt": "fmt"}) {
		t.Errorf("got %+v", p)
	}
}
