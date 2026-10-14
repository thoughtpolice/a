// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type tarEntry struct {
	name, link, body string
	typ              byte
	mode             int64
}

func readTar(t *testing.T, path string) []tarEntry {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var r io.Reader = bytes.NewReader(data)
	if compressionOf(data) == "gzip" {
		zr, err := gzip.NewReader(r)
		if err != nil {
			t.Fatal(err)
		}
		r = zr
	}
	var entries []tarEntry
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return entries
		} else if err != nil {
			t.Fatal(err)
		}
		if hdr.Uid != 0 || hdr.Gid != 0 || hdr.Uname != "" || hdr.Gname != "" || hdr.ModTime.Unix() != 0 {
			t.Errorf("%s: owner %d:%d %q:%q, time %v", hdr.Name, hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname, hdr.ModTime)
		}
		body, _ := io.ReadAll(tr)
		entries = append(entries, tarEntry{hdr.Name, hdr.Linkname, string(body), hdr.Typeflag, hdr.Mode})
	}
}

func TestTar(t *testing.T) {
	tmp := t.TempDir()
	tree := filepath.Join(tmp, "tree")
	writeFile(t, filepath.Join(tree, "b.txt"), []byte("b"))
	writeFile(t, filepath.Join(tree, "sub", "run.sh"), []byte("#!/bin/sh\n"))
	os.Chmod(filepath.Join(tree, "sub", "run.sh"), 0o700)
	os.Symlink("b.txt", filepath.Join(tree, "link"))
	file := writeFile(t, filepath.Join(tmp, "real", "file.txt"), []byte("hello\n"))
	// Buck hands a source over as a symlink to the real file.
	farm := filepath.Join(tmp, "farm", "file.txt")
	os.MkdirAll(filepath.Dir(farm), 0o755)
	os.Symlink(file, farm)

	srcs := writeFile(t, filepath.Join(tmp, "srcs.txt"), []byte(farm+"\n"+tree+"\n"))
	out := filepath.Join(tmp, "out.tar.gz")
	mustRun(t, "tar", "--srcs", srcs, "--output", out, "--compress", "--prefix", "/usr/local/")

	want := []tarEntry{
		{name: "usr/local/file.txt", body: "hello\n", typ: tar.TypeReg, mode: 0o644},
		{name: "usr/local/tree/", typ: tar.TypeDir, mode: 0o755},
		{name: "usr/local/tree/b.txt", body: "b", typ: tar.TypeReg, mode: 0o644},
		{name: "usr/local/tree/link", link: "b.txt", typ: tar.TypeSymlink, mode: 0o777},
		{name: "usr/local/tree/sub/", typ: tar.TypeDir, mode: 0o755},
		{name: "usr/local/tree/sub/run.sh", body: "#!/bin/sh\n", typ: tar.TypeReg, mode: 0o755},
	}
	if got := readTar(t, out); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	data, _ := os.ReadFile(out)
	if data[3]&0x08 != 0 || !bytes.Equal(data[4:8], []byte{0, 0, 0, 0}) {
		t.Errorf("gzip header has a name or a time: % x", data[:10])
	}

	// Equal inputs give equal archives.
	again := filepath.Join(tmp, "again.tar.gz")
	mustRun(t, "tar", "--srcs", srcs, "--output", again, "--compress", "--prefix", "/usr/local/")
	if b, _ := os.ReadFile(again); !bytes.Equal(b, data) {
		t.Error("identical inputs gave different archives")
	}

	missing := writeFile(t, filepath.Join(tmp, "missing.txt"), []byte(filepath.Join(tmp, "nope")+"\n"))
	if _, stderr, code := runTool(t, "tar", "--srcs", missing, "--output", filepath.Join(tmp, "x.tar")); code != 1 || !strings.Contains(stderr, "not found") {
		t.Errorf("a missing path gave exit %d: %s", code, stderr)
	}
}
