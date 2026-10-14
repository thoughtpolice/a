// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// checkoutWorkers is how many files are written at once. Beyond a few
// writers, contention in the kernel costs more than they save: checking
// out rust-lang/rust took 0.96 s with 2, 0.61 s with 4, 0.59 s with 8,
// and 0.66 s with 20, which also spent 9 s of system time.
const checkoutWorkers = 4

// indexEntry is a file, symlink or submodule to check out, as git's index
// would list it.
type indexEntry struct {
	path string // slash-separated, relative to the work tree
	mode uint32
	id   oid
}

// checkout writes a commit's tree into workTree, which must be empty, as
// `git checkout` does with no configuration. Submodules become empty
// directories, and empty trees nothing at all, since the index cannot
// hold them.
func checkout(p *pack, commit oid, workTree string) error {
	_, data, err := p.object(commit)
	if err != nil {
		return err
	}
	tree, err := p.format.commitTree(data)
	if err != nil {
		return err
	}
	var entries []indexEntry
	if err := listTree(p, tree, "", &entries); err != nil {
		return err
	}
	attrs, err := loadAttributes(p, entries)
	if err != nil {
		return err
	}
	w := worktree{root: workTree, dirs: map[string]bool{"": true}}
	if err := os.MkdirAll(workTree, 0o777); err != nil {
		return err
	}
	// Directories first, in order, and then the files in parallel.
	for _, e := range entries {
		dir, _ := splitPath(e.path)
		if err := w.mkdirAll(dir); err != nil {
			return fmt.Errorf("checking out %s: %w", e.path, err)
		}
	}
	return forEach(checkoutWorkers, len(entries), func(i int) error {
		if err := w.write(p, attrs, entries[i]); err != nil {
			return fmt.Errorf("checking out %s: %w", entries[i].path, err)
		}
		return nil
	})
}

// listTree appends the tree's entries to out, depth first in tree order,
// which is the order of the index.
func listTree(p *pack, tree oid, prefix string, out *[]indexEntry) error {
	typ, data, err := p.object(tree)
	if err != nil {
		return err
	}
	if typ != typeTree {
		return fmt.Errorf("%s is a %s, not a tree", p.format.hex(tree), typ)
	}
	entries, err := p.format.parseTree(data)
	if err != nil {
		return fmt.Errorf("tree %s: %w", p.format.hex(tree), err)
	}
	for _, e := range entries {
		path := prefix + e.name
		mode, ok := canonMode(e.mode)
		if !ok {
			return fmt.Errorf("%q has unknown mode %o", path, e.mode)
		}
		if err := verifyPathComponent(e.name, mode); err != nil {
			return fmt.Errorf("refusing to check out %q: %w", path, err)
		}
		if mode == modeDir {
			if err := listTree(p, e.id, path+"/", out); err != nil {
				return err
			}
			continue
		}
		*out = append(*out, indexEntry{path, mode, e.id})
	}
	return nil
}

// verifyPathComponent refuses the names git refuses to check out, with its
// defaults on Linux: core.protectNTFS on, core.protectHFS off.
func verifyPathComponent(name string, mode uint32) error {
	switch {
	case name == "":
		return errors.New("empty file name")
	case name == "." || name == "..":
		return errors.New("the name is a relative path")
	case strings.Contains(name, "/"):
		return errors.New("the name contains a slash")
	}
	// .git in any case, or a name NTFS treats as it, anywhere a backslash
	// could start a path component on Windows.
	for part := range strings.SplitSeq(name, `\`) {
		if isNTFSDotGit(part) {
			return errors.New("the name is .git")
		}
		if mode == modeSymlink && isDotGitmodules(part) {
			return errors.New(".gitmodules may not be a symbolic link")
		}
	}
	return nil
}

// isNTFSDotGit reports whether NTFS would open name as .git: ".git" or its
// short name "git~1", in any case, with any trailing dots and spaces, or
// up to a colon, which starts an alternate data stream.
func isNTFSDotGit(name string) bool {
	name, _, _ = strings.Cut(name, ":")
	name = strings.TrimRight(name, ". ")
	return strings.EqualFold(name, ".git") || strings.EqualFold(name, "git~1")
}

func isDotGitmodules(name string) bool {
	name, _, _ = strings.Cut(name, ":")
	return strings.EqualFold(strings.TrimRight(name, ". "), ".gitmodules")
}

// loadAttributes reads every .gitattributes file in the tree, as git does
// from the index while checking out.
func loadAttributes(p *pack, entries []indexEntry) (*attributes, error) {
	attrs := newAttributes()
	for _, e := range entries {
		dir, name := splitPath(e.path)
		if name != ".gitattributes" || e.mode == modeGitlink {
			continue
		}
		_, data, err := p.object(e.id)
		if err != nil {
			return nil, err
		}
		attrs.addFile(dir, data)
	}
	return attrs, nil
}

func splitPath(path string) (dir, name string) {
	i := strings.LastIndexByte(path, '/')
	if i < 0 {
		return "", path
	}
	return path[:i], path[i+1:]
}

type worktree struct {
	root string
	dirs map[string]bool // directories created so far, before any file
}

// write checks out one entry, whose directory must exist.
func (w *worktree) write(p *pack, attrs *attributes, e indexEntry) error {
	full := filepath.Join(w.root, filepath.FromSlash(e.path))
	if e.mode == modeGitlink {
		return collision(os.Mkdir(full, 0o777))
	}
	typ, data, err := p.object(e.id)
	if err != nil {
		return err
	}
	if typ != typeBlob {
		return fmt.Errorf("%s is a %s, not a blob", p.format.hex(e.id), typ)
	}
	if e.mode == modeSymlink {
		return collision(os.Symlink(string(data), full))
	}
	data, err = convertToWorktree(e.path, attrs.lookup(e.path), e.id, p.format, data)
	if err != nil {
		return err
	}
	perm := fs.FileMode(0o666)
	if e.mode == modeExec {
		perm = 0o777
	}
	// O_EXCL never follows a symlink, nor replaces anything, so a path
	// that a case-insensitive file system folds onto another fails here.
	f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return collision(err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// mkdirAll creates dir and its parents, each of which must be new.
func (w *worktree) mkdirAll(dir string) error {
	if w.dirs[dir] {
		return nil
	}
	parent, _ := splitPath(dir)
	if err := w.mkdirAll(parent); err != nil {
		return err
	}
	if err := os.Mkdir(filepath.Join(w.root, filepath.FromSlash(dir)), 0o777); err != nil {
		return collision(err)
	}
	w.dirs[dir] = true
	return nil
}

func collision(err error) error {
	if errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("%w: another path in the tree was checked out there; is the file system case-insensitive?", err)
	}
	return err
}
