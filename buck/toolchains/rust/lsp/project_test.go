// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A project root laid out the way Buck lays out crates, with first-party
// sources in the repository and source trees (__srcs) of links to them, a
// third-party crate extracted under buck-out, and files the prelude writes.
type fixture struct {
	t    *testing.T
	root string
}

func newFixture(t *testing.T) *fixture {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t, root}
}

func (f *fixture) path(rel string) string { return filepath.Join(f.root, rel) }

func (f *fixture) write(rel, content string) string {
	path := f.path(rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
	return path
}

func (f *fixture) link(rel, target string) {
	path := f.path(rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Symlink(f.path(target), path); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) crates() *buckCrates {
	f.write("src/a/lib.rs", "")
	f.write("src/a/util.rs", "")
	f.link("buck-out/a/__srcs/lib.rs", "src/a/lib.rs")
	f.link("buck-out/a-test/__srcs/lib.rs", "src/a/lib.rs")
	f.write("buck-out/archive/foo.crate/src/lib.rs", "")
	f.link("buck-out/foo/__srcs/foo.crate", "buck-out/archive/foo.crate")
	f.write("buck-out/bar/__srcs/lib.rs", "")
	f.write("buck-out/macro/__srcs/lib.rs", "")
	argfile := f.write("buck-out/flags.txt", "--cfg=from_file\n-Copt-level=0\n")
	dynamic := f.write("buck-out/bar/crate.txt", "bar_dyn\n")

	return &buckCrates{
		Buildfiles: []string{f.path("src/a/BUILD")},
		Roots:      []string{"//a:lib", "//a:lib-test"},
		Crates: map[string]*buckCrate{
			"//a:lib": {
				Buildfile:   "src/a/BUILD",
				Crate:       "a",
				CrateRoot:   "lib.rs",
				Deps:        []string{"//tp:foo-1", "//a:macro", "//tp:foo-1"},
				Edition:     "2024",
				Env:         map[string]string{"OUT_DIR": f.path("buck-out/a/out")},
				Features:    []string{"x"},
				InWorkspace: true,
				Kind:        "lib",
				Label:       "//a:lib",
				Name:        "lib",
				NamedDeps:   map[string]string{"//tp:foo-1": "my-foo"},
				RustcFlags:  []string{"--cfg=tokio_unstable", "--cfg", "other", "@" + argfile, "-Cdebuginfo=2"},
				Sources:     f.path("buck-out/a/__srcs"),
				Srcs:        []string{f.path("src/a/lib.rs"), f.path("src/a/util.rs")},
			},
			"//a:lib-test": {
				Buildfile:   "src/a/BUILD",
				Crate:       "lib_test",
				CrateRoot:   "lib.rs",
				Deps:        []string{"//tp:foo-1", "//a:lib", "//tp:bar"},
				Env:         map[string]string{"RUST_MIN_STACK": "1"},
				Edition:     "2024",
				InWorkspace: true,
				Kind:        "test",
				Label:       "//a:lib-test",
				Name:        "lib-test",
				Sources:     f.path("buck-out/a-test/__srcs"),
				Srcs:        []string{f.path("src/a/lib.rs"), f.path("src/a/test.rs")},
			},
			"//tp:foo-1": {
				Buildfile:  "third-party/BUILD",
				Crate:      "foo",
				CrateRoot:  "foo.crate/src/lib.rs",
				Kind:       "lib",
				Label:      "//tp:foo-1",
				Name:       "foo-1",
				Sources:    f.path("buck-out/foo/__srcs"),
				Srcs:       []string{f.path("buck-out/archive/foo.crate")},
				ThirdParty: true,
			},
			"//tp:bar": {
				Buildfile:    "third-party/BUILD",
				CrateDynamic: dynamic,
				CrateRoot:    "lib.rs",
				Kind:         "lib",
				Label:        "//tp:bar",
				Name:         "bar",
				Sources:      f.path("buck-out/bar/__srcs"),
				ThirdParty:   true,
			},
			"//a:macro": {
				Buildfile:      "src/a/BUILD",
				Crate:          "a_macro",
				CrateRoot:      "lib.rs",
				Kind:           "lib",
				Label:          "//a:macro",
				Name:           "macro",
				ProcMacro:      true,
				ProcMacroDylib: f.path("buck-out/macro/libmacro.so"),
				Sources:        f.path("buck-out/macro/__srcs"),
			},
		},
	}
}

func (f *fixture) assemble(in *buckCrates) *projectJSON {
	project, err := assemble(in, f.root, sysroot{Sysroot: "/sysroot", Src: "/sysroot/library"})
	if err != nil {
		f.t.Fatal(err)
	}
	return project
}

func byName(t *testing.T, project *projectJSON, name string) crate {
	for _, c := range project.Crates {
		if c.DisplayName == name {
			return c
		}
	}
	t.Fatalf("no crate %s", name)
	return crate{}
}

func TestAssemble(t *testing.T) {
	f := newFixture(t)
	project := f.assemble(f.crates())

	// The unit test is part of the library's crate.
	var names []string
	for _, c := range project.Crates {
		names = append(names, c.DisplayName)
	}
	if want := []string{"lib", "macro", "bar_dyn", "foo"}; !slices.Equal(names, want) {
		t.Fatalf("crates %v, want %v", names, want)
	}
	lib := byName(t, project, "lib")

	if want := f.path("src/a/lib.rs"); lib.RootModule != want {
		t.Errorf("lib's root module %s, want the file itself, %s", lib.RootModule, want)
	}
	if want := f.path("buck-out/foo/__srcs/foo.crate/src/lib.rs"); byName(t, project, "foo").RootModule != want {
		t.Errorf("foo's root module %s, want the path in its source tree, %s", byName(t, project, "foo").RootModule, want)
	}

	var deps []string
	for _, d := range lib.Deps {
		deps = append(deps, project.Crates[d.Crate].DisplayName+" as "+d.Name)
	}
	if want := []string{"macro as a_macro", "bar_dyn as bar_dyn", "foo as my_foo"}; !slices.Equal(deps, want) {
		t.Errorf("lib's deps %v, want %v", deps, want)
	}

	if want := []string{`feature="x"`, "tokio_unstable", "other", "from_file", "test"}; !slices.Equal(lib.Cfg, want) {
		t.Errorf("lib's cfg %v, want %v", lib.Cfg, want)
	}
	if cfg := byName(t, project, "foo").Cfg; slices.Contains(cfg, "test") {
		t.Errorf("third-party foo has cfg(test): %v", cfg)
	}

	if lib.Env["RUST_MIN_STACK"] != "1" || lib.Env["OUT_DIR"] == "" {
		t.Errorf("lib's env %v lacks its test's or its own", lib.Env)
	}
	if want := []string{f.path("buck-out/a"), f.path("src/a")}; !slices.Equal(lib.Source.IncludeDirs, want) {
		t.Errorf("lib's include dirs %v, want %v", lib.Source.IncludeDirs, want)
	}
	if want := []string{f.path("buck-out/archive"), f.path("buck-out/foo/__srcs/foo.crate/src")}; !slices.Equal(byName(t, project, "foo").Source.IncludeDirs, want) {
		t.Errorf("foo's include dirs %v, want %v", byName(t, project, "foo").Source.IncludeDirs, want)
	}

	if lib.Build == nil || lib.Build.Label != "//a:lib-test" || lib.Build.TargetKind != "test" || lib.Build.BuildFile != f.path("src/a/BUILD") {
		t.Errorf("lib's build %+v, want its test's label", lib.Build)
	}
	if !lib.IsWorkspaceMember {
		t.Errorf("lib is not a workspace member")
	}
	if foo := byName(t, project, "foo"); foo.Build != nil || foo.IsWorkspaceMember {
		t.Errorf("foo is part of the workspace: %+v", foo)
	}

	macro := byName(t, project, "macro")
	if !macro.IsProcMacro || macro.ProcMacroDylib != f.path("buck-out/macro/libmacro.so") || macro.ProcMacroCwd != f.root {
		t.Errorf("macro: %+v", macro)
	}

	if project.Sysroot != "/sysroot" || project.SysrootSrc != "/sysroot/library" {
		t.Errorf("sysroot %s, %s", project.Sysroot, project.SysrootSrc)
	}
	if r := project.Runnables; len(r) != 1 || r[0].Kind != "testOne" || r[0].Cwd != f.root || !slices.Contains(r[0].Args, "{label}") {
		t.Errorf("runnables %+v", r)
	}
}

func TestAssembleNamedDepsFile(t *testing.T) {
	f := newFixture(t)
	in := f.crates()
	lib := in.Crates["//a:lib"]
	lib.NamedDeps = nil
	lib.NamedDepsFile = f.write("buck-out/a/named_deps", "renamed-foo\nrenamed-macro\n")
	lib.NamedDepsOrder = []string{"//tp:foo-1", "//a:macro"}
	delete(in.Crates, "//a:lib-test")

	var deps []string
	for _, d := range byName(t, f.assemble(in), "lib").Deps {
		deps = append(deps, d.Name)
	}
	if want := []string{"renamed_macro", "renamed_foo"}; !slices.Equal(deps, want) {
		t.Errorf("deps %v, want %v", deps, want)
	}
}

func TestAssembleUnitTestOf(t *testing.T) {
	f := newFixture(t)
	in := f.crates()
	in.Crates["//a:lib-test"].Kind = "unit_test"
	in.Crates["//a:lib-test"].UnitTestOf = "//a:missing"
	if _, err := assemble(in, f.root, sysroot{}); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Errorf("a unit test of a missing crate: %v", err)
	}

	f = newFixture(t)
	in = f.crates()
	test := in.Crates["//a:lib-test"]
	test.UnitTestOf = "//a:macro"
	if _, err := assemble(in, f.root, sysroot{}); err == nil || !strings.Contains(err.Error(), "root module") {
		t.Errorf("a unit test of a crate with another root module: %v", err)
	}
}

func TestAssembleUnfoldedTest(t *testing.T) {
	// A test with its own root module stays a crate of its own.
	f := newFixture(t)
	in := f.crates()
	f.write("src/a/test.rs", "")
	f.write("buck-out/t/__srcs/test.rs", "")
	in.Crates["//a:lib-test"].Sources = f.path("buck-out/t/__srcs")
	in.Crates["//a:lib-test"].CrateRoot = "test.rs"

	project := f.assemble(in)
	test := byName(t, project, "lib-test")
	if test.Build == nil || test.Build.Label != "//a:lib-test" || test.Build.TargetKind != "test" {
		t.Errorf("test's build %+v", test.Build)
	}
	if lib := byName(t, project, "lib"); lib.Build.Label != "//a:lib" || lib.Build.TargetKind != "lib" {
		t.Errorf("lib's build %+v", lib.Build)
	}
	var deps []string
	for _, d := range test.Deps {
		deps = append(deps, d.Name)
	}
	if !slices.Contains(deps, "a") {
		t.Errorf("test's deps %v lack the library", deps)
	}
}
