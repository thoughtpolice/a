// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command driver is the go/packages driver behind the repository's gopls
// (its GOPACKAGESDRIVER; see README.md). gopls runs it with query patterns as
// arguments and a request on stdin, and reads back every package the
// queries name and everything those import.
//
// Buck says which targets own the files and where their sources and `go
// list` analyses are (gopls.bxl:packages); this program turns that into
// go/packages' answer:
//
//   - each go_binary, go_library and go_test is a package of its own, its ID
//     the target's label, with the files and imports of the analysis the
//     build itself made;
//   - the stdlib and golang.org/x packages they import are those of the
//     go_x_library every Go target depends on, with their import paths as
//     IDs;
//   - a file no Go target owns is a package of its own with an error that
//     says so, which can import the stdlib and golang.org/x.
//
// Patterns are the ones gopls sends: file=PATH; DIR/... and DIR, for the Go
// files under DIR, skipping what the go command skips, buck-out, nested Buck
// projects, and the workspaces under work/; import paths; and builtin. A
// bare .go file is a standalone script, which this leaves to `go list`.
package main

import (
	"bytes"
	"encoding/json/v2"
	"fmt"
	"go/build"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// The driver protocol, from golang.org/x/tools/go/packages: DriverRequest,
// DriverResponse, and the fields of Package that it decodes.
type request struct {
	Tests   bool              `json:"tests"`
	Overlay map[string][]byte `json:"overlay"`
}

type response struct {
	NotHandled bool     `json:",omitzero"`
	Compiler   string   `json:",omitempty"`
	Arch       string   `json:",omitempty"`
	Roots      []string `json:",omitempty"`
	Packages   []*pkg   `json:",omitempty"`
	GoVersion  int      `json:",omitzero"`
}

type pkg struct {
	ID              string
	Name            string            `json:",omitempty"`
	PkgPath         string            `json:",omitempty"`
	Errors          []pkgError        `json:",omitempty"`
	GoFiles         []string          `json:",omitempty"`
	CompiledGoFiles []string          `json:",omitempty"`
	OtherFiles      []string          `json:",omitempty"`
	EmbedFiles      []string          `json:",omitempty"`
	EmbedPatterns   []string          `json:",omitempty"`
	IgnoredFiles    []string          `json:",omitempty"`
	Imports         map[string]string `json:",omitempty"`
}

type pkgError struct {
	Pos  string
	Msg  string
	Kind int
}

// packages.ListError: an error loading the package, rather than parsing or
// type-checking it.
const listError = 1

// What gopls.bxl:packages prints.
type buckOutput struct {
	Errors     []buckError        `json:"errors"`
	Importable *importable        `json:"importable"`
	Packages   map[string]*target `json:"packages"`
	Root       string             `json:"root"`
	Unowned    []string           `json:"unowned"`
}

type buckError struct {
	File    string `json:"file"`
	Target  string `json:"target"`
	Message string `json:"message"`
}

type target struct {
	Deps    []string          `json:"deps"`
	Files   map[string]string `json:"files"`
	GoList  string            `json:"go_list"`
	Kind    string            `json:"kind"`
	PkgPath string            `json:"pkg_path"`
	Root    bool              `json:"root"`
}

type importable struct {
	GOARCH string               `json:"goarch"`
	GOOS   string               `json:"goos"`
	GOROOT string               `json:"goroot"`
	Stdlib string               `json:"stdlib"`
	X      map[string][2]string `json:"x"`
}

// A `go list -json` package, as the prelude's pkg_analyzer writes it for one
// directory and `go list std` for the stdlib.
type goList struct {
	ImportPath        string
	Name              string
	Imports           []string
	TestImports       []string
	ImportMap         map[string]string
	GoFiles           []string
	TestGoFiles       []string
	XTestGoFiles      []string
	IgnoredGoFiles    []string
	IgnoredOtherFiles []string
	CFiles            []string
	CXXFiles          []string
	HFiles            []string
	SFiles            []string
	SysoFiles         []string
	EmbedFiles        []string
	EmbedPatterns     []string
	TestEmbedPatterns []string
	Error             *struct{ Err string }
}

const bxl = "toolchains//golang/lsp/gopls.bxl:packages"

func main() {
	var req request
	if err := json.UnmarshalRead(os.Stdin, &req); err != nil {
		fatalf("reading the request: %v", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		fatalf("%v", err)
	}
	q, ok := parseQuery(os.Args[1:], cwd)
	if !ok {
		write(&response{NotHandled: true})
		return
	}
	out, err := runBuck(cwd, q, req.Tests)
	if err != nil {
		fatalf("%v", err)
	}
	resp, err := assemble(out, q, overlays(req.Overlay, cwd))
	if err != nil {
		fatalf("%v", err)
	}
	write(resp)
}

// MARK: Queries

type query struct {
	files   []string        // the Go files whose owners to describe
	named   map[string]bool // those a file= pattern named
	paths   []string        // import paths
	builtin bool
}

func parseQuery(patterns []string, cwd string) (query, bool) {
	q := query{named: map[string]bool{}}
	seen := map[string]bool{}
	add := func(files ...string) {
		for _, f := range files {
			if !seen[f] {
				seen[f] = true
				q.files = append(q.files, f)
			}
		}
	}
	for _, p := range patterns {
		switch dir, recursive := strings.CutSuffix(p, "/..."); {
		case p == "builtin":
			q.builtin = true
		case strings.HasPrefix(p, "file="):
			f := absPath(cwd, strings.TrimPrefix(p, "file="))
			q.named[f] = true
			add(f)
		case isPath(p) && strings.HasSuffix(p, ".go"):
			// A standalone script, such as a //go:build ignore program.
			return q, false
		case recursive && isPath(dir):
			add(goFiles(absPath(cwd, dir), true)...)
		case isPath(p):
			add(goFiles(absPath(cwd, p), false)...)
		case !strings.Contains(p, "..."):
			q.paths = append(q.paths, p)
		}
	}
	return q, true
}

func isPath(p string) bool {
	return filepath.IsAbs(p) || p == "." || p == ".." || strings.HasPrefix(p, "./") || strings.HasPrefix(p, "../")
}

func absPath(cwd, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(cwd, p)
}

// goFiles lists the .go files in dir, and with recursive those below it,
// skipping the directories the go command skips (testdata and names that
// start with . or _), buck-out, node_modules, nested Buck projects, and a
// project's work/, which holds jj workspaces and other checkouts. Buck owns
// nothing in buck-out, so a directory there has none to list.
func goFiles(dir string, recursive bool) []string {
	if slices.Contains(strings.Split(filepath.ToSlash(dir), "/"), "buck-out") {
		return nil
	}
	var files []string
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path == dir {
				return nil
			}
			name := d.Name()
			switch {
			case !recursive,
				strings.HasPrefix(name, "."), strings.HasPrefix(name, "_"),
				name == "testdata", name == "buck-out", name == "node_modules",
				exists(filepath.Join(path, ".buckroot")),
				name == "work" && exists(filepath.Join(path, "..", ".buckroot")):
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && d.Type().IsRegular() {
			files = append(files, path)
		}
		return nil
	})
	return files
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func runBuck(cwd string, q query, tests bool) (*buckOutput, error) {
	args := []string{"bxl", "--console=simple", bxl, "--", "--tests", strconv.FormatBool(tests)}
	for _, f := range q.files {
		args = append(args, "--file", f)
	}
	for _, p := range q.paths {
		args = append(args, "--import_path", p)
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("buck2", args...)
	cmd.Dir = cwd
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("buck2 %s: %v\n%s", strings.Join(args, " "), err, stderr.Bytes())
	}
	var out buckOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		return nil, fmt.Errorf("reading %s: %v", bxl, err)
	}
	return &out, nil
}

// overlays keys the editor's unsaved files by absolute path; the request's
// paths are relative to the driver's directory.
func overlays(overlay map[string][]byte, cwd string) map[string][]byte {
	out := make(map[string][]byte, len(overlay))
	for path, content := range overlay {
		out[absPath(cwd, path)] = content
	}
	return out
}

// MARK: Assembly

type assembler struct {
	out     *buckOutput
	overlay map[string][]byte
	pkgs    map[string]*pkg
	stdlib  map[string]*goList // by import path, once read
}

func assemble(out *buckOutput, q query, overlay map[string][]byte) (*response, error) {
	a := &assembler{out: out, overlay: overlay, pkgs: map[string]*pkg{}}
	imp := out.Importable
	if imp == nil {
		return nil, fmt.Errorf("%s gave no stdlib", bxl)
	}
	resp := &response{Compiler: "gc", Arch: imp.GOARCH, GoVersion: goVersion(imp.GOROOT)}

	for _, id := range sortedKeys(out.Packages) {
		t := out.Packages[id]
		if err := a.target(id, t); err != nil {
			return nil, err
		}
		if t.Root {
			resp.Roots = append(resp.Roots, id)
		}
	}

	if q.builtin {
		file := filepath.Join(imp.GOROOT, "src", "builtin", "builtin.go")
		a.pkgs["builtin"] = &pkg{ID: "builtin", Name: "builtin", PkgPath: "builtin", GoFiles: []string{file}, CompiledGoFiles: []string{file}}
		resp.Roots = append(resp.Roots, "builtin")
	}

	// A file= query must answer with some package holding the file, or gopls
	// can only say it found none. The file may be the stdlib's or
	// golang.org/x's, which an editor can ask about directly once it has
	// jumped to a definition there; otherwise, say why Buck gave none.
	held := map[string]bool{}
	for _, p := range a.pkgs {
		for _, f := range slices.Concat(p.GoFiles, p.IgnoredFiles) {
			held[f] = true
		}
	}
	for _, f := range q.files {
		if !q.named[f] || held[f] {
			continue
		}
		id, ok, err := a.dependency(f)
		if err == nil && !ok {
			id, err = a.unowned(f, a.whyUnowned(f))
		}
		if err != nil {
			return nil, err
		}
		resp.Roots = append(resp.Roots, id)
	}

	for _, id := range sortedKeys(a.pkgs) {
		resp.Packages = append(resp.Packages, a.pkgs[id])
	}
	slices.Sort(resp.Roots)
	return resp, nil
}

// target adds a Buck target's package.
func (a *assembler) target(id string, t *target) error {
	p := &pkg{ID: id, PkgPath: t.PkgPath}
	file := func(names ...[]string) []string {
		var out []string
		for _, name := range slices.Concat(names...) {
			if path, ok := t.Files[name]; ok {
				out = append(out, path)
			}
		}
		return out
	}

	var imports []string
	if t.GoList == "" {
		// A go_bootstrap_binary: choose its files and read its imports here.
		imp := a.out.Importable
		ctxt := build.Default
		ctxt.GOOS, ctxt.GOARCH, ctxt.CgoEnabled = imp.GOOS, imp.GOARCH, false
		for _, name := range sortedKeys(t.Files) {
			path := t.Files[name]
			if ok, err := ctxt.MatchFile(filepath.Dir(path), filepath.Base(path)); err != nil || !ok {
				p.IgnoredFiles = append(p.IgnoredFiles, path)
				continue
			}
			p.GoFiles = append(p.GoFiles, path)
			if src, err := a.read(path); err == nil {
				name, fileImports := parseHeader(path, src)
				p.Name = name
				imports = append(imports, fileImports...)
			}
		}
		p.CompiledGoFiles = p.GoFiles
	} else {
		var l goList
		if err := readJSON(t.GoList, &l); err != nil {
			return err
		}
		test := strings.HasPrefix(t.Kind, "go_test")
		p.Name = l.Name
		imports = l.Imports
		goFiles := l.GoFiles
		if test {
			imports = slices.Concat(imports, l.TestImports)
			goFiles = slices.Concat(goFiles, l.TestGoFiles)
			p.EmbedPatterns = slices.Concat(l.EmbedPatterns, l.TestEmbedPatterns)
		} else {
			p.EmbedPatterns = l.EmbedPatterns
		}
		// cgo is off, so a file that imports "C" is among the ignored ones.
		// Buck builds no external test package (XTestGoFiles), so those count
		// as ignored too.
		p.GoFiles = file(goFiles)
		p.CompiledGoFiles = p.GoFiles
		p.OtherFiles = file(l.CFiles, l.CXXFiles, l.HFiles, l.SFiles, l.SysoFiles)
		p.IgnoredFiles = file(l.IgnoredGoFiles, l.IgnoredOtherFiles)
		if test {
			p.IgnoredFiles = append(p.IgnoredFiles, file(l.XTestGoFiles)...)
		}
		if l.Error != nil {
			p.Errors = append(p.Errors, pkgError{Msg: l.Error.Err, Kind: listError})
		}
	}

	// The editor's unsaved imports, so that a new one resolves before the
	// file is saved and Buck analyzes it again.
	for _, path := range p.CompiledGoFiles {
		if src, ok := a.overlay[path]; ok {
			_, fileImports := parseHeader(path, src)
			imports = append(imports, fileImports...)
		}
	}

	deps := map[string]string{}
	for _, dep := range t.Deps {
		if d, ok := a.out.Packages[dep]; ok {
			deps[d.PkgPath] = dep
		}
	}
	p.Imports = map[string]string{}
	for _, path := range imports {
		if id, ok := deps[path]; ok {
			p.Imports[path] = id
		} else if id, ok, err := a.importable(path); err != nil {
			return err
		} else if ok {
			p.Imports[path] = id
		}
	}
	a.pkgs[id] = p
	return nil
}

// unowned adds a package of one file no Go target owns, which can import
// the stdlib and golang.org/x, with an error giving the reason.
func (a *assembler) unowned(file, reason string) (string, error) {
	id := "file=" + file
	p := &pkg{
		ID:              id,
		PkgPath:         a.dirPath(filepath.Dir(file)),
		GoFiles:         []string{file},
		CompiledGoFiles: []string{file},
		Errors:          []pkgError{{Pos: file + ":1:1", Msg: reason, Kind: listError}},
		Imports:         map[string]string{},
	}
	if src, err := a.read(file); err == nil {
		name, imports := parseHeader(file, src)
		p.Name = name
		for _, path := range imports {
			if dep, ok, err := a.importable(path); err != nil {
				return "", err
			} else if ok {
				p.Imports[path] = dep
			}
		}
	}
	a.pkgs[id] = p
	return id, nil
}

func (a *assembler) whyUnowned(file string) string {
	for _, e := range a.out.Errors {
		if e.File == file {
			return "buck2 could not load the package owning this file:\n" + e.Message
		}
	}
	if slices.Contains(a.out.Unowned, file) {
		return "this file is in the srcs of no go_binary, go_library or go_test, so only the standard library and golang.org/x resolve here; " +
			"add it to one in a BUILD file (a file a glob would take needs saving first)"
	}
	var failed []string
	for _, e := range a.out.Errors {
		if e.Target != "" {
			failed = append(failed, e.Target+": "+e.Message)
		}
	}
	if len(failed) > 0 {
		return "buck2 could not analyze the targets owning this file:\n" + strings.Join(failed, "\n")
	}
	return "no Go target owning this file builds on the default platform"
}

// dirPath is a directory's path in the Buck project, the import path a Go
// target there would have.
func (a *assembler) dirPath(dir string) string {
	if rel, err := filepath.Rel(a.out.Root, dir); err == nil && filepath.IsLocal(rel) {
		return filepath.ToSlash(rel)
	}
	return filepath.ToSlash(dir)
}

func (a *assembler) read(path string) ([]byte, error) {
	if src, ok := a.overlay[path]; ok {
		return src, nil
	}
	return os.ReadFile(path)
}

// importable adds the golang.org/x or stdlib package with an import path,
// and those it imports, and returns its ID, the import path; ok is false
// when neither has it.
func (a *assembler) importable(path string) (id string, ok bool, err error) {
	if id, ok, err := a.x(path); err != nil || ok {
		return id, ok, err
	}
	return a.std(path)
}

// dependency adds the golang.org/x or stdlib package in the directory
// holding file, if there is one.
func (a *assembler) dependency(file string) (string, bool, error) {
	dir := filepath.Dir(file)
	for path, loc := range a.out.Importable.X {
		if filepath.Clean(loc[1]) == dir {
			return a.x(path)
		}
	}
	src := filepath.Join(a.out.Importable.GOROOT, "src")
	if rel, err := filepath.Rel(src, dir); err == nil && filepath.IsLocal(rel) {
		return a.std(filepath.ToSlash(rel))
	}
	return "", false, nil
}

func (a *assembler) x(path string) (string, bool, error) {
	loc, ok := a.out.Importable.X[path]
	if !ok {
		return "", false, nil
	}
	if _, done := a.pkgs[path]; done {
		return path, true, nil
	}
	var l goList
	if err := readJSON(loc[0], &l); err != nil {
		return "", false, err
	}
	p := goListPackage(path, loc[1], &l)
	a.pkgs[path] = p
	for _, imp := range l.Imports {
		if dep, ok, err := a.importable(imp); err != nil {
			return "", false, err
		} else if ok {
			p.Imports[imp] = dep
		}
	}
	return path, true, nil
}

func (a *assembler) std(path string) (string, bool, error) {
	if a.stdlib == nil {
		var list []*goList
		if err := readJSON(a.out.Importable.Stdlib, &list); err != nil {
			return "", false, err
		}
		a.stdlib = map[string]*goList{}
		for _, l := range list {
			a.stdlib[l.ImportPath] = l
		}
	}
	l, ok := a.stdlib[path]
	if !ok {
		return "", false, nil
	}
	if _, done := a.pkgs[path]; done {
		return path, true, nil
	}
	p := goListPackage(path, filepath.Join(a.out.Importable.GOROOT, "src", filepath.FromSlash(path)), l)
	a.pkgs[path] = p

	// Imports holds what each import resolved to (vendor/golang.org/x/...),
	// and ImportMap maps back from what the source says.
	written := map[string]string{}
	for from, to := range l.ImportMap {
		written[to] = from
	}
	for _, imp := range l.Imports {
		dep, ok, err := a.std(imp)
		if err != nil {
			return "", false, err
		}
		if !ok {
			continue
		}
		if from, ok := written[imp]; ok {
			imp = from
		}
		p.Imports[imp] = dep
	}
	return path, true, nil
}

// goListPackage is the package `go list` describes in dir, without imports.
func goListPackage(path, dir string, l *goList) *pkg {
	join := func(names ...[]string) []string {
		var out []string
		for _, name := range slices.Concat(names...) {
			out = append(out, filepath.Join(dir, name))
		}
		return out
	}
	p := &pkg{
		ID:              path,
		Name:            l.Name,
		PkgPath:         path,
		GoFiles:         join(l.GoFiles),
		CompiledGoFiles: join(l.GoFiles),
		OtherFiles:      join(l.CFiles, l.CXXFiles, l.HFiles, l.SFiles, l.SysoFiles),
		EmbedFiles:      join(l.EmbedFiles),
		EmbedPatterns:   l.EmbedPatterns,
		IgnoredFiles:    join(l.IgnoredGoFiles, l.IgnoredOtherFiles),
		Imports:         map[string]string{},
	}
	if l.Error != nil {
		p.Errors = append(p.Errors, pkgError{Msg: l.Error.Err, Kind: listError})
	}
	return p
}

// MARK: Helpers

// parseHeader returns a Go file's package name and imports, as far as it
// parses.
func parseHeader(path string, src []byte) (string, []string) {
	f, _ := parser.ParseFile(token.NewFileSet(), path, src, parser.ImportsOnly)
	if f == nil || f.Name == nil {
		return "", nil
	}
	var imports []string
	for _, spec := range f.Imports {
		if path, err := strconv.Unquote(spec.Path.Value); err == nil && path != "C" {
			imports = append(imports, path)
		}
	}
	return f.Name.Name, imports
}

// goVersion is the minor version of the Go in goroot, or 0 if unknown.
func goVersion(goroot string) int {
	b, err := os.ReadFile(filepath.Join(goroot, "VERSION"))
	if err != nil {
		return 0
	}
	line, _, _ := strings.Cut(string(b), "\n")
	parts := strings.Split(strings.TrimPrefix(line, "go"), ".")
	if len(parts) < 2 {
		return 0
	}
	minor, _ := strconv.Atoi(parts[1])
	return minor
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: %v", path, err)
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func write(resp *response) {
	if err := json.MarshalWrite(os.Stdout, resp); err != nil {
		fatalf("%v", err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "gopls driver: "+format+"\n", args...)
	os.Exit(1)
}
