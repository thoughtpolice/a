// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// What rust.bxl:crates writes, with every crate keyed by its target's label.
type buckCrates struct {
	Buildfiles []string              `json:"buildfiles"`
	Crates     map[string]*buckCrate `json:"crates"`
	Roots      []string              `json:"roots"`
	Rustc      []string              `json:"rustc"`
}

type buckCrate struct {
	Buildfile      string            `json:"buildfile"`
	Crate          string            `json:"crate"`
	CrateDynamic   string            `json:"crate_dynamic"`
	CrateRoot      string            `json:"crate_root"`
	Deps           []string          `json:"deps"`
	Edition        string            `json:"edition"`
	Env            map[string]string `json:"env"`
	Features       []string          `json:"features"`
	InWorkspace    bool              `json:"in_workspace"`
	Kind           string            `json:"kind"`
	Label          string            `json:"label"`
	Labels         []string          `json:"labels"`
	Name           string            `json:"name"`
	NamedDeps      map[string]string `json:"named_deps"`
	NamedDepsFile  string            `json:"named_deps_file"`
	NamedDepsOrder []string          `json:"named_deps_order"`
	ProcMacro      bool              `json:"proc_macro"`
	ProcMacroDylib string            `json:"proc_macro_dylib"`
	RustcFlags     []string          `json:"rustc_flags"`
	Sources        string            `json:"sources"`
	Srcs           []string          `json:"srcs"`
	ThirdParty     bool              `json:"third_party"`
	UnitTestOf     string            `json:"unit_test_of"`

	// Set by assemble.
	rootModule string
	testLabel  string
}

// rust-project.json, as rust-analyzer reads it:
// https://rust-analyzer.github.io/book/non_cargo_based_projects.html
type projectJSON struct {
	Sysroot    string     `json:"sysroot"`
	SysrootSrc string     `json:"sysroot_src,omitempty"`
	Crates     []crate    `json:"crates"`
	Runnables  []runnable `json:"runnables"`
}

type crate struct {
	DisplayName       string            `json:"display_name"`
	RootModule        string            `json:"root_module"`
	Edition           string            `json:"edition"`
	Deps              []dep             `json:"deps"`
	IsWorkspaceMember bool              `json:"is_workspace_member"`
	Source            source            `json:"source"`
	Cfg               []string          `json:"cfg"`
	Env               map[string]string `json:"env"`
	IsProcMacro       bool              `json:"is_proc_macro"`
	ProcMacroDylib    string            `json:"proc_macro_dylib_path,omitempty"`
	ProcMacroCwd      string            `json:"proc_macro_cwd,omitempty"`
	Build             *build            `json:"build,omitempty"`
}

type dep struct {
	Crate int    `json:"crate"`
	Name  string `json:"name"`
}

type source struct {
	IncludeDirs []string `json:"include_dirs"`
	ExcludeDirs []string `json:"exclude_dirs"`
}

type build struct {
	Label      string `json:"label"`
	BuildFile  string `json:"build_file"`
	TargetKind string `json:"target_kind"`
}

type runnable struct {
	Program string   `json:"program"`
	Args    []string `json:"args"`
	Cwd     string   `json:"cwd"`
	Kind    string   `json:"kind"`
}

type sysroot struct {
	Sysroot, Src string
}

// findSysroot asks the toolchain's rustc where its sysroot is. A rustc named
// without a directory is looked up on PATH, as Buck's actions do.
func findSysroot(rustc []string, root string) (sysroot, error) {
	if len(rustc) == 0 {
		return sysroot{}, fmt.Errorf("the Rust toolchain names no rustc")
	}
	out, err := run(root, rustc[0], append(slices.Clone(rustc[1:]), "--print=sysroot")...)
	if err != nil {
		return sysroot{}, fmt.Errorf("asking the toolchain's rustc for its sysroot: %v", err)
	}
	// Without the rust-src component there is no source to load, and
	// rust-analyzer goes without the standard library.
	s := sysroot{Sysroot: strings.TrimSpace(string(out))}
	src := filepath.Join(s.Sysroot, "lib", "rustlib", "src", "rust", "library")
	if _, err := os.Stat(src); err == nil {
		s.Src = src
	}
	return s, nil
}

// rootModule is where rust-analyzer reads a crate's root from. For a file
// in the repository that is the file itself, so that the editor's paths
// match. For one that only Buck has (an extracted crate archive, a
// generated file) it is the path inside the crate's source tree, whose
// neighbours there may come from elsewhere through mapped_srcs.
func rootModule(c *buckCrate, root string) string {
	path := filepath.Join(c.Sources, c.CrateRoot)
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	if rel, err := filepath.Rel(root, real); err == nil && (rel == "buck-out" || strings.HasPrefix(rel, "buck-out"+string(filepath.Separator))) {
		return path
	}
	return real
}

// crateName is the name other crates know c by, unless they rename it.
func crateName(c *buckCrate) string {
	if c.CrateDynamic != "" {
		if data, err := os.ReadFile(c.CrateDynamic); err == nil {
			return strings.TrimSpace(string(data))
		}
	}
	if c.Crate != "" {
		return c.Crate
	}
	return strings.ReplaceAll(c.Name, "-", "_")
}

// namedDeps maps the label of each dependency c renames to its local name.
func namedDeps(c *buckCrate) (map[string]string, error) {
	named := map[string]string{}
	for label, name := range c.NamedDeps {
		named[label] = name
	}
	if c.NamedDepsFile != "" {
		data, err := os.ReadFile(c.NamedDepsFile)
		if err != nil {
			return nil, err
		}
		names := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		if len(names) < len(c.NamedDepsOrder) {
			return nil, fmt.Errorf("%s: %s names %d dependencies, not %d", c.Label, c.NamedDepsFile, len(names), len(c.NamedDepsOrder))
		}
		for i, label := range c.NamedDepsOrder {
			named[label] = names[i]
		}
	}
	return named, nil
}

// fold merges each test crate into the library or binary whose root module
// it shares. The build compiles that file twice, once with cfg(test), but
// rust-analyzer gives a file to one crate, so the one crate gets the test's
// dependencies and cfg(test). A test says which crate it belongs to with
// unit_test_of; otherwise it is the one crate with the same root module.
// Returns the crate each folded test went to.
func fold(crates map[string]*buckCrate) (map[string]string, error) {
	byRoot := map[string][]string{}
	for label, c := range crates {
		if c.Kind == "bin" || c.Kind == "lib" {
			byRoot[c.rootModule] = append(byRoot[c.rootModule], label)
		}
	}

	folded := map[string]string{}
	for _, label := range sortedKeys(crates) {
		test := crates[label]
		if test.Kind != "test" && test.Kind != "unit_test" {
			continue
		}
		parentLabel := test.UnitTestOf
		if parentLabel == "" {
			if candidates := byRoot[test.rootModule]; len(candidates) == 1 {
				parentLabel = candidates[0]
			}
		}
		parent := crates[parentLabel]
		if parent == nil {
			if test.UnitTestOf != "" {
				return nil, fmt.Errorf("unit test %s names missing crate %s", label, test.UnitTestOf)
			}
			continue
		}
		if parent.testLabel != "" {
			return nil, fmt.Errorf("%s and %s are both unit tests of %s", parent.testLabel, label, parentLabel)
		}
		if parent.rootModule != test.rootModule {
			return nil, fmt.Errorf("unit test %s has root module %s, but %s has %s", label, test.rootModule, parentLabel, parent.rootModule)
		}

		parent.testLabel = label
		for _, d := range test.Deps {
			if d != parentLabel && !slices.Contains(parent.Deps, d) {
				parent.Deps = append(parent.Deps, d)
			}
		}
		testNamed, err := namedDeps(test)
		if err != nil {
			return nil, err
		}
		parentNamed, err := namedDeps(parent)
		if err != nil {
			return nil, err
		}
		for d, name := range testNamed {
			if other, ok := parentNamed[d]; ok && other != name {
				return nil, fmt.Errorf("unit test %s calls %s %s, but %s calls it %s", label, d, name, parentLabel, other)
			}
			parentNamed[d] = name
		}
		parent.NamedDeps, parent.NamedDepsFile, parent.NamedDepsOrder = parentNamed, "", nil
		for _, src := range test.Srcs {
			if !slices.Contains(parent.Srcs, src) {
				parent.Srcs = append(parent.Srcs, src)
			}
		}
		for _, f := range test.Features {
			if !slices.Contains(parent.Features, f) {
				parent.Features = append(parent.Features, f)
			}
		}
		if parent.Env == nil {
			parent.Env = map[string]string{}
		}
		for k, v := range test.Env {
			parent.Env[k] = v
		}
		for _, f := range test.RustcFlags {
			if !slices.Contains(parent.RustcFlags, f) {
				parent.RustcFlags = append(parent.RustcFlags, f)
			}
		}
		parent.InWorkspace = parent.InWorkspace || test.InWorkspace
		folded[label] = parentLabel
	}
	for label := range folded {
		delete(crates, label)
	}
	return folded, nil
}

// cfgs is what rustc's --cfg flags, the crate's features, and cfg(test) for
// one of the repository's own crates turn on. rust-analyzer adds the
// target's own cfgs (unix, target_os and so on) from rustc.
func cfgs(c *buckCrate) []string {
	var out []string
	for _, f := range c.Features {
		out = append(out, fmt.Sprintf("feature=%q", f))
	}
	flags := c.RustcFlags
	for i := 0; i < len(flags); i++ {
		switch flag := flags[i]; {
		case strings.HasPrefix(flag, "--cfg="):
			out = append(out, strings.TrimPrefix(flag, "--cfg="))
		case flag == "--cfg" && i+1 < len(flags):
			out = append(out, flags[i+1])
			i++
		case strings.HasPrefix(flag, "@"):
			// An argument file holds one flag per line. One that does not
			// read is skipped, as a missing cfg costs less than no crate.
			if data, err := os.ReadFile(flag[1:]); err == nil {
				for line := range strings.Lines(string(data)) {
					if cfg, ok := strings.CutPrefix(strings.TrimSpace(line), "--cfg="); ok {
						out = append(out, cfg)
					}
				}
			}
		}
	}
	if !c.ThirdParty && !slices.Contains(out, "test") {
		out = append(out, "test")
	}
	return out
}

// includeDirs are the directories rust-analyzer loads c's files from: those
// of its sources, which a source tree in buck-out need not lay out the way
// the repository does; the parent of OUT_DIR, which include!() reads from;
// and that of the root module. A directory of the prelude's source trees
// (__srcs) stands for its parent.
func includeDirs(c *buckCrate) []string {
	var dirs []string
	if out, ok := c.Env["OUT_DIR"]; ok {
		dirs = append(dirs, filepath.Dir(out))
	}
	var srcDirs []string
	for _, src := range c.Srcs {
		srcDirs = append(srcDirs, filepath.Dir(src))
	}
	slices.Sort(srcDirs)
	dirs = append(dirs, srcDirs...)
	dirs = append(dirs, filepath.Dir(c.rootModule))

	var out []string
	for _, d := range dirs {
		if strings.HasSuffix(filepath.Base(d), "__srcs") {
			d = filepath.Dir(d)
		}
		if !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	return out
}

func displayName(c *buckCrate) string {
	// Third-party targets are named for the crate's version (anyhow-1).
	if c.ThirdParty {
		return crateName(c)
	}
	// The prelude names a proc macro's library _NAME, and the alias that
	// builds it for the execution platform NAME.
	if c.ProcMacro {
		return strings.TrimPrefix(c.Name, "_")
	}
	return c.Name
}

// targetKind is the build kind rust-analyzer offers runnables for.
func targetKind(c *buckCrate) string {
	if c.testLabel != "" {
		return "test"
	}
	switch c.Kind {
	case "bin":
		return "bin"
	case "lib":
		return "lib"
	case "test", "unit_test":
		return "test"
	}
	return "other"
}

// assemble turns rust.bxl's crates into a rust-project.json.
func assemble(in *buckCrates, root string, sys sysroot) (*projectJSON, error) {
	crates := map[string]*buckCrate{}
	for label, c := range in.Crates {
		c.rootModule = rootModule(c, root)
		crates[label] = c
	}
	folded, err := fold(crates)
	if err != nil {
		return nil, err
	}

	labels := sortedKeys(crates)
	index := map[string]int{}
	for i, label := range labels {
		index[label] = i
	}

	project := &projectJSON{
		Sysroot:    sys.Sysroot,
		SysrootSrc: sys.Src,
		Crates:     make([]crate, 0, len(labels)),
		Runnables: []runnable{{
			// {label} is the build label of the crate holding the test: the
			// test target, for a library or binary with its unit tests
			// folded in, which `buck2 run` runs as a libtest binary.
			Program: "buck2",
			Args:    []string{"run", "{label}", "--", "{test_id}", "--exact", "--nocapture"},
			Cwd:     root,
			Kind:    "testOne",
		}},
	}

	for _, label := range labels {
		c := crates[label]
		named, err := namedDeps(c)
		if err != nil {
			return nil, err
		}

		// Each dependency once, under the name c uses for it. A renamed
		// dependency that rust_deps leaves out still counts.
		deps := []dep{}
		seen := map[int]bool{}
		add := func(d string) {
			if to, ok := folded[d]; ok {
				d = to
			}
			i, ok := index[d]
			if !ok || d == label || seen[i] {
				return
			}
			seen[i] = true
			name := crateName(crates[d])
			if n, ok := named[d]; ok {
				name = strings.ReplaceAll(n, "-", "_")
			}
			deps = append(deps, dep{Crate: i, Name: name})
		}
		for _, d := range c.Deps {
			add(d)
		}
		for _, d := range sortedKeys(named) {
			add(d)
		}
		slices.SortFunc(deps, func(a, b dep) int { return a.Crate - b.Crate })

		env := map[string]string{}
		for k, v := range c.Env {
			env[k] = v
		}
		if dir, ok := env["CARGO_MANIFEST_DIR"]; ok && !filepath.IsAbs(dir) {
			env["CARGO_MANIFEST_DIR"] = filepath.Join(c.Sources, dir)
		}

		edition := c.Edition
		if edition == "" {
			edition = "2021"
		}

		member := c.InWorkspace || slices.Contains(c.Labels, "generated")
		k := crate{
			DisplayName:       displayName(c),
			RootModule:        c.rootModule,
			Edition:           edition,
			Deps:              deps,
			IsWorkspaceMember: member,
			Source:            source{IncludeDirs: includeDirs(c), ExcludeDirs: []string{}},
			Cfg:               cfgs(c),
			Env:               env,
			IsProcMacro:       c.ProcMacro,
			ProcMacroDylib:    c.ProcMacroDylib,
			// Proc macros run where rustc does in Buck's build: the project
			// root.
			ProcMacroCwd: root,
		}
		if member {
			buildLabel := label
			if c.testLabel != "" {
				buildLabel = c.testLabel
			}
			k.Build = &build{
				Label:      buildLabel,
				BuildFile:  filepath.Join(root, c.Buildfile),
				TargetKind: targetKind(c),
			}
		}
		project.Crates = append(project.Crates, k)
	}
	return project, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
