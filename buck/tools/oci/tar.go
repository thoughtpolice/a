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
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

func runTar(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("tar", "--srcs FILE --output FILE [--compress] [--prefix DIR]", stderr)
	srcs := flags.String("srcs", "", "file listing the paths to archive, one per line")
	output := flags.String("output", "", "archive to write")
	compress := flags.Bool("compress", false, "gzip the archive")
	prefix := flags.String("prefix", "", "directory inside the archive to put every path under")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "srcs", "output"); err != nil {
		return err
	}
	data, err := os.ReadFile(*srcs)
	if err != nil {
		return err
	}
	var paths []string
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			paths = append(paths, line)
		}
	}
	return writeTarFile(*output, paths, *prefix, *compress)
}

// writeTarFile archives each path under prefix by its base name, with every
// entry's owner, time and mode normalized, so equal inputs give equal bytes.
func writeTarFile(output string, paths []string, prefix string, compress bool) error {
	f, err := os.Create(output)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := bufio.NewWriterSize(f, 1<<20)
	var w io.Writer = buf
	var zw *gzip.Writer
	if compress {
		// No name and a zero time, so the gzip header is reproducible too.
		zw, _ = gzip.NewWriterLevel(buf, gzip.BestCompression)
		w = zw
	}
	tw := tar.NewWriter(w)
	prefix = strings.Trim(prefix, "/")
	for _, p := range paths {
		// Buck presents source artifacts through a symlink farm. Resolve only
		// that top-level link so the archive holds the declared artifact,
		// not an absolute link back into the workspace.
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			return fmt.Errorf("path not found: %s", p)
		}
		name := filepath.Base(p)
		if prefix != "" {
			name = prefix + "/" + name
		}
		if err := addTree(tw, real, name); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if zw != nil {
		if err := zw.Close(); err != nil {
			return err
		}
	}
	if err := buf.Flush(); err != nil {
		return err
	}
	return f.Close()
}

// addTree adds src as name, and a directory's contents below it in name
// order. Symlinks below the top are archived as links, not followed.
func addTree(tw *tar.Writer, src, name string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	hdr := &tar.Header{Name: name, ModTime: time.Unix(0, 0)}
	switch mode := info.Mode(); {
	case mode.IsDir():
		hdr.Typeflag = tar.TypeDir
		hdr.Name += "/"
		hdr.Mode = 0o755
	case mode&os.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		hdr.Typeflag = tar.TypeSymlink
		hdr.Linkname = target
		hdr.Mode = 0o777
	case mode.IsRegular():
		hdr.Typeflag = tar.TypeReg
		hdr.Size = info.Size()
		hdr.Mode = 0o644
		if mode&0o111 != 0 {
			hdr.Mode = 0o755
		}
	default:
		return fmt.Errorf("%s: cannot archive a %s", src, mode.Type())
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	switch hdr.Typeflag {
	case tar.TypeReg:
		f, err := os.Open(src)
		if err != nil {
			return err
		}
		_, err = io.Copy(tw, f)
		f.Close()
		return err
	case tar.TypeDir:
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := addTree(tw, filepath.Join(src, e.Name()), path.Join(name, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
