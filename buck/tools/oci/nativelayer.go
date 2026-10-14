// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// An executable from this repository's Nix-backed C/C++ toolchain has an
// ELF interpreter and RUNPATH entries below /nix/store. A container doesn't
// mount the host's Nix store, so those immutable store roots have to be in
// the image at their original absolute paths, or the executable has to be
// repointed at an ABI-compatible base's runtime.
//
// Store roots are copied whole. Besides being simple and robust, that
// keeps glibc's runtime-loaded NSS modules, which DT_NEEDED alone can't
// find.

// storeDir is where the Nix store is; tests move it.
var storeDir = "/nix/store"

const (
	nixHash = "0-9abcdfghijklmnpqrsvwxyz"
	nixName = "0-9A-Za-z+._?=-"
)

func storeRootPattern() *regexp.Regexp {
	return regexp.MustCompile("^(" + regexp.QuoteMeta(storeDir) + "/[" + nixHash + "]{32}-[" + nixName + "]+)")
}

func storeReferencePattern() *regexp.Regexp {
	return regexp.MustCompile(regexp.QuoteMeta(storeDir) + "/[" + nixHash + "]{32}-[" + nixName + "]+")
}

// storeRoot is the store path p is in, or "".
func storeRoot(p string) string {
	if m := storeRootPattern().FindStringSubmatch(p); m != nil {
		return m[1]
	}
	return ""
}

// embeddedStorePaths returns the store paths that appear anywhere in a
// file, reading it a chunk at a time. A match that reaches the end of a
// chunk may continue in the next one, so it waits for the next read.
func embeddedStorePaths(p string) ([]string, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	pattern := storeReferencePattern()
	found := map[string]bool{}
	const chunk, overlap = 1 << 20, 4096
	buf := make([]byte, 0, chunk+overlap)
	read := make([]byte, chunk)
	for {
		n, err := f.Read(read)
		buf = append(buf, read[:n]...)
		eof := err == io.EOF
		if err != nil && !eof {
			return nil, err
		}
		for _, loc := range pattern.FindAllIndex(buf, -1) {
			if loc[1] < len(buf) || eof {
				found[string(buf[loc[0]:loc[1]])] = true
			}
		}
		if eof {
			break
		}
		if len(buf) > overlap {
			buf = append(buf[:0], buf[len(buf)-overlap:]...)
		}
	}
	paths := make([]string, 0, len(found))
	for p := range found {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths, nil
}

// storeClosure follows embedded store paths and cross-store symlinks from
// the initial roots to a fixed point.
func storeClosure(initial []string) ([]string, error) {
	pending := append([]string{}, initial...)
	sort.Strings(pending)
	seen := map[string]bool{}
	for len(pending) > 0 {
		root := pending[0]
		pending = pending[1:]
		if seen[root] {
			continue
		}
		if _, err := os.Lstat(root); err != nil {
			return nil, fmt.Errorf("the ELF references Nix store root %s, but it is unavailable", root)
		}
		seen[root] = true
		add := func(p string) {
			if r := storeRoot(p); r != "" && !seen[r] {
				pending = append(pending, r)
			}
		}
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			switch {
			case d.Type()&fs.ModeSymlink != 0:
				target, err := os.Readlink(p)
				if err != nil {
					return err
				}
				if !filepath.IsAbs(target) {
					target = filepath.Join(filepath.Dir(p), target)
				}
				add(filepath.Clean(target))
			case d.Type().IsRegular():
				refs, err := embeddedStorePaths(p)
				if err != nil {
					return err
				}
				for _, r := range refs {
					add(r)
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	roots := make([]string, 0, len(seen))
	for r := range seen {
		roots = append(roots, r)
	}
	sort.Strings(roots)
	return roots, nil
}

func runNativeLayer(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("native-layer", "--binary FILE --output FILE --destination PATH [--include-nix-store=false] [--interpreter PATH] [--rpath PATH]", stderr)
	binary := flags.String("binary", "", "native ELF executable")
	output := flags.String("output", "", "gzipped layer tar to write")
	destination := flags.String("destination", "", "absolute path of the executable in the image")
	includeStore := flags.Bool("include-nix-store", true, "copy the Nix store roots the executable needs into the layer")
	patchelf := flags.String("patchelf", "patchelf", "patchelf, which --interpreter and --rpath run")
	var interp, rpath optionalString
	flags.Var(&interp, "interpreter", "replacement ELF interpreter, for an ABI-compatible base")
	flags.Var(&rpath, "rpath", "replacement RUNPATH, for an ABI-compatible base")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "binary", "output", "destination"); err != nil {
		return err
	}
	dest := path.Clean(*destination)
	if !path.IsAbs(*destination) || dest == "/" {
		return usagef("destination must be an absolute file path: %q", *destination)
	}
	for _, part := range strings.Split(*destination, "/") {
		if part == ".." {
			return usagef("destination cannot contain '..': %q", *destination)
		}
	}

	packaged := *binary
	if interp.set || rpath.set {
		dir, err := os.MkdirTemp("", "native-binary-layer-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		packaged = filepath.Join(dir, "binary")
		if err := copyExecutable(*binary, packaged); err != nil {
			return err
		}
		args := []string{}
		if interp.set {
			args = append(args, "--set-interpreter", interp.value)
		}
		if rpath.set {
			args = append(args, "--set-rpath", rpath.value)
		}
		cmd := exec.CommandContext(ctx, *patchelf, append(args, packaged)...)
		cmd.Stdout, cmd.Stderr = stderr, stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("cannot patch the ELF runtime with %s: %w", *patchelf, err)
		}
	}
	data, err := os.ReadFile(packaged)
	if err != nil {
		return err
	}
	e, err := readELF(data)
	if err != nil {
		return fmt.Errorf("%s: %w", *binary, err)
	}
	interpreter, search, needed, err := e.runtimePaths()
	if err != nil {
		return fmt.Errorf("%s: %w", *binary, err)
	}
	initial := map[string]bool{}
	for _, p := range append(append([]string{interpreter}, search...), needed...) {
		if r := storeRoot(p); r != "" {
			initial[r] = true
		}
	}
	if !*includeStore && len(initial) > 0 {
		return fmt.Errorf("include-nix-store=false, but the packaged ELF still references: %s", strings.Join(sortedKeys(initial), ", "))
	}
	var roots []string
	if *includeStore {
		if roots, err = storeClosure(sortedKeys(initial)); err != nil {
			return err
		}
	}
	fmt.Fprintf(stderr, "oci native-layer: %s -> %s\n", *binary, dest)
	if interpreter == "" {
		interpreter = "<static>"
	}
	fmt.Fprintf(stderr, "oci native-layer: interpreter: %s\n", interpreter)
	for _, r := range roots {
		fmt.Fprintf(stderr, "oci native-layer: including %s\n", r)
	}
	if err := writeNativeLayer(packaged, *output, dest, roots); err != nil {
		return err
	}
	fmt.Fprintf(stderr, "oci native-layer: wrote %s with %d Nix store root(s)\n", *output, len(roots))
	return nil
}

// copyExecutable copies a file and its mode, writable so it can be patched.
func copyExecutable(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, info.Mode().Perm()|0o200)
}

// optionalString is a string flag that knows whether it was given, so an
// empty value can still be set.
type optionalString struct {
	value string
	set   bool
}

func (o *optionalString) String() string { return o.value }

func (o *optionalString) Set(v string) error {
	o.value, o.set = v, true
	return nil
}

// writeNativeLayer writes the executable at dest and the store roots at
// their own paths, with owners and times cleared. Files are archived as
// data, never as hardlinks: Nix can optimize identical store files into
// hardlinks without changing the store's contents, so inode sharing is not
// a stable input.
func writeNativeLayer(binary, output, dest string, roots []string) error {
	f, err := os.Create(output)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := bufio.NewWriterSize(f, 1<<20)
	zw, _ := gzip.NewWriterLevel(buf, 6)
	tw := tar.NewWriter(zw)
	write := func(hdr *tar.Header, body io.Reader) error {
		hdr.Format = tar.FormatGNU
		hdr.ModTime = time.Unix(0, 0)
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if body != nil {
			_, err := io.Copy(tw, body)
			return err
		}
		return nil
	}
	dirEntry := func(name string) error {
		return write(&tar.Header{Name: name + "/", Typeflag: tar.TypeDir, Mode: 0o755}, nil)
	}

	var parents []string
	for p := path.Dir(dest); p != "/"; p = path.Dir(p) {
		parents = append([]string{strings.TrimPrefix(p, "/")}, parents...)
	}
	for _, p := range parents {
		if err := dirEntry(p); err != nil {
			return err
		}
	}
	if len(roots) > 0 {
		store := strings.TrimPrefix(storeDir, "/")
		for p, parts := "", strings.Split(store, "/"); len(parts) > 0; parts = parts[1:] {
			p = path.Join(p, parts[0])
			if err := dirEntry(p); err != nil {
				return err
			}
		}
	}

	info, err := os.Stat(binary)
	if err != nil {
		return err
	}
	src, err := os.Open(binary)
	if err != nil {
		return err
	}
	mode := (int64(info.Mode().Perm()) | 0o111)
	err = write(&tar.Header{Name: strings.TrimPrefix(dest, "/"), Typeflag: tar.TypeReg, Mode: mode, Size: info.Size()}, src)
	src.Close()
	if err != nil {
		return err
	}

	for _, root := range roots {
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			name := strings.TrimPrefix(filepath.ToSlash(p), "/")
			hdr := &tar.Header{Name: name, Mode: storeMode(info.Mode())}
			switch {
			case d.IsDir():
				hdr.Typeflag, hdr.Name = tar.TypeDir, name+"/"
				return write(hdr, nil)
			case d.Type()&fs.ModeSymlink != 0:
				target, err := os.Readlink(p)
				if err != nil {
					return err
				}
				hdr.Typeflag, hdr.Linkname = tar.TypeSymlink, target
				return write(hdr, nil)
			case d.Type().IsRegular():
				f, err := os.Open(p)
				if err != nil {
					return err
				}
				defer f.Close()
				hdr.Typeflag, hdr.Size = tar.TypeReg, info.Size()
				return write(hdr, f)
			default:
				return fmt.Errorf("%s: cannot archive a %s", p, d.Type())
			}
		})
		if err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := buf.Flush(); err != nil {
		return err
	}
	return f.Close()
}

// storeMode keeps a store file's permissions, without setuid or setgid,
// which the Nix store never has.
func storeMode(m fs.FileMode) int64 {
	mode := int64(m.Perm())
	if m&fs.ModeSticky != 0 {
		mode |= 0o1000
	}
	return mode
}
