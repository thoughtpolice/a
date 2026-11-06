// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// One compile_commands.json entry.
type entry struct {
	Directory string   `json:"directory"`
	File      string   `json:"file"`
	Arguments []string `json:"arguments"`
}

// database turns Buck's compile commands into what clangd reads.
type database struct {
	root string
	// The directories that stand for each header tree.
	trees map[string][]string
	// The tokens of each argument file, its own argument files expanded.
	argfiles  map[string][]string
	compilers map[string]bool
}

func newDatabase(root string) *database {
	return &database{root: root, trees: map[string][]string{}, argfiles: map[string][]string{}, compilers: map[string]bool{}}
}

// entries makes one entry of each command, running in the project root as
// Buck runs it. A source's own command comes before any for a header, which
// clangd would otherwise prefer for a file in both.
func (db *database) entries(in []buckEntry) ([]entry, error) {
	in = slices.Clone(in)
	slices.SortStableFunc(in, func(a, b buckEntry) int {
		switch {
		case a.Header == b.Header:
			return 0
		case a.Header:
			return 1
		}
		return -1
	})
	out := make([]entry, 0, len(in))
	for _, e := range in {
		if len(e.Arguments) == 0 {
			continue
		}
		args := db.expand(e.Arguments, 0)
		args[0] = db.compiler(args[0])
		out = append(out, entry{
			Directory: db.root,
			File:      db.abs(e.File),
			Arguments: db.searchPaths(args),
		})
	}
	return out, nil
}

func (db *database) drivers() []string {
	var out []string
	for c := range db.compilers {
		out = append(out, c)
	}
	return sortedUnique(out)
}

func (db *database) abs(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(db.root, path)
}

// compiler is the absolute path of the compiler a command runs, which
// clangd matches against --query-driver.
func (db *database) compiler(name string) string {
	path := name
	if !strings.ContainsRune(name, filepath.Separator) {
		if found, err := exec.LookPath(name); err == nil {
			path = found
		}
	} else {
		path = db.abs(name)
	}
	db.compilers[path] = true
	return path
}

// expand replaces each @FILE argument with the arguments in FILE. The
// prelude passes most of a command's flags in argument files, which nest.
// clangd would expand them itself, but searchPaths has to see the include
// path inside them to rewrite it. A nested file is named relative to the
// project root, where Buck runs the compiler, or else to the file naming
// it, as clang looks for it.
func (db *database) expand(args []string, depth int) []string {
	var out []string
	for _, arg := range args {
		name, ok := strings.CutPrefix(arg, "@")
		if !ok || depth > 16 {
			out = append(out, arg)
			continue
		}
		path := db.abs(name)
		if tokens, ok := db.argfiles[path]; ok {
			out = append(out, tokens...)
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			// Not an argument file after all; clang leaves it alone too.
			out = append(out, arg)
			continue
		}
		var tokens []string
		for _, t := range tokenize(string(data)) {
			if nested, ok := strings.CutPrefix(t, "@"); ok && !filepath.IsAbs(nested) {
				if _, err := os.Stat(db.abs(nested)); err != nil {
					t = "@" + filepath.Join(filepath.Dir(path), nested)
				}
			}
			tokens = append(tokens, t)
		}
		tokens = db.expand(tokens, depth+1)
		db.argfiles[path] = tokens
		out = append(out, tokens...)
	}
	return out
}

// tokenize splits an argument file the way clang does on Unix (GNU
// quoting), at whitespace outside quotes, with a backslash escaping the
// character after it except within single quotes.
func tokenize(s string) []string {
	var tokens []string
	var cur strings.Builder
	in := false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			in = true
		case c == '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				end = len(s) - i - 1
			}
			cur.WriteString(s[i+1 : i+1+end])
			i += end + 1
			in = true
		case c == '"':
			for i++; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) {
					i++
				}
				cur.WriteByte(s[i])
			}
			in = true
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if in {
				tokens = append(tokens, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteByte(c)
			in = true
		}
	}
	if in {
		tokens = append(tokens, cur.String())
	}
	return tokens
}

var includeFlags = []string{"-I", "-isystem", "-iquote", "-idirafter"}

// searchPaths replaces each header tree on the include path with the
// directories its headers are in.
func (db *database) searchPaths(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		flag, dir, joined := "", "", false
		for _, f := range includeFlags {
			if arg == f && i+1 < len(args) {
				flag, dir = f, args[i+1]
				break
			}
			if strings.HasPrefix(arg, f) && len(arg) > len(f) {
				flag, dir, joined = f, arg[len(f):], true
				break
			}
		}
		if flag == "" {
			out = append(out, arg)
			continue
		}
		if !joined {
			i++
		}
		for _, d := range db.tree(dir) {
			if joined {
				out = append(out, flag+d)
			} else {
				out = append(out, flag, d)
			}
		}
	}
	return out
}

// tree is what stands for an include directory. The prelude puts a
// target's headers on the include path as a tree of links under buck-out
// (buck-headers), each at the path code includes it by. clangd names a
// header by the path it found it at, so a definition in a header would be
// in buck-out, which editors treat as some other file, and some (Claude
// Code) drop as ignored by git. Where a link's target ends with the link's
// path in the tree, the directory above that path finds the header too, at
// its own path. A tree with headers that no such directory finds stays as
// well, after those directories.
func (db *database) tree(dir string) []string {
	abs := db.abs(dir)
	if rel, err := filepath.Rel(db.root, abs); err != nil || !(rel == "buck-out" || strings.HasPrefix(rel, "buck-out"+string(filepath.Separator))) {
		return []string{dir}
	}
	if dirs, ok := db.trees[abs]; ok {
		return dirs
	}

	var bases []string
	unmatched := false
	filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			unmatched = true
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(abs, path)
		if d.Type()&fs.ModeSymlink == 0 {
			unmatched = true
			return nil
		}
		real, err := filepath.EvalSymlinks(path)
		base, ok := strings.CutSuffix(real, string(filepath.Separator)+rel)
		if err != nil || !ok {
			unmatched = true
			return nil
		}
		if !slices.Contains(bases, base) {
			bases = append(bases, base)
		}
		return nil
	})
	if unmatched || len(bases) == 0 {
		bases = append(bases, dir)
	}
	db.trees[abs] = bases
	return bases
}
