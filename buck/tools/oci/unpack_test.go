// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bytes"
	"encoding/json/v2"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type entry struct {
	hdr  tar.Header
	body string
}

func tarFile(name, body string, mode int64) entry {
	return entry{tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: mode, Size: int64(len(body))}, body}
}

func tarDir(name string, mode int64) entry {
	return entry{tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: mode}, ""}
}

func tarSymlink(name, target string) entry {
	return entry{tar.Header{Name: name, Typeflag: tar.TypeSymlink, Linkname: target, Mode: 0o777}, ""}
}

func layerOf(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		hdr := e.hdr
		if err := tw.WriteHeader(&hdr); err != nil {
			t.Fatal(err)
		}
		io.WriteString(tw, e.body)
	}
	tw.Close()
	return buf.Bytes()
}

func readTree(t *testing.T, root string) map[string]string {
	t.Helper()
	tree := map[string]string{}
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || p == root {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, _ := os.Readlink(p)
			tree[rel] = "-> " + target
		case info.IsDir():
			tree[rel] = "dir"
		default:
			data, _ := os.ReadFile(p)
			tree[rel] = string(data)
		}
		return nil
	})
	return tree
}

func layeredImage(t *testing.T, dir string) Layout {
	lower := layerOf(t,
		entry{tar.Header{Name: "etc/", Typeflag: tar.TypeDir, Mode: 0o755}, ""},
		tarFile("etc/passwd", "root:x:0:0::/root:/bin/sh\nnobody:x:65534:65533::/:/sbin/nologin\n", 0o644),
		entry{tar.Header{Name: "etc/secret", Typeflag: tar.TypeReg, Mode: 0o600, Uid: 5, Gid: 6, Size: 6}, "secret"},
		tarFile("bin/sh", "#!shell", 0o755),
		tarDir("usr/lib/", 0o755),
		tarSymlink("lib", "/usr/lib"),
		tarDir("opt/", 0o755),
		tarFile("opt/old", "old", 0o644),
		tarDir("ro/", 0o555),
		tarFile("ro/inside", "x", 0o444),
		entry{tar.Header{Name: "dev/null", Typeflag: tar.TypeChar, Mode: 0o666, Devmajor: 1, Devminor: 3}, ""},
	)
	upper := layerOf(t,
		tarFile("lib/libx.so", "lib", 0o755),
		tarFile("etc/.wh.secret", "", 0o644),
		tarFile("opt/new", "new", 0o644),
		tarFile("opt/.wh..wh..opq", "", 0o644),
		entry{tar.Header{Name: "bin/sh2", Typeflag: tar.TypeLink, Linkname: "bin/sh"}, ""},
		tarSymlink("esc", "../../.."),
		tarFile("esc/pwned", "contained", 0o644),
	)
	config := baseConfig("amd64")
	config["config"].(map[string]any)["User"] = "nobody"
	config["config"].(map[string]any)["Entrypoint"] = []any{"/bin/sh"}
	config["config"].(map[string]any)["Cmd"] = []any{"-c", "true"}
	return testImage(t, dir, config, lower, upper)
}

func TestUnpack(t *testing.T) {
	tmp := t.TempDir()
	l := layeredImage(t, filepath.Join(tmp, "image"))
	bundle := filepath.Join(tmp, "bundle")
	mustRun(t, "unpack", "--image", l.Dir, "--output", bundle)

	want := map[string]string{
		"etc":             "dir",
		"etc/passwd":      "root:x:0:0::/root:/bin/sh\nnobody:x:65534:65533::/:/sbin/nologin\n",
		"bin":             "dir",
		"bin/sh":          "#!shell",
		"bin/sh2":         "#!shell",
		"usr":             "dir",
		"usr/lib":         "dir",
		"usr/lib/libx.so": "lib",
		"lib":             "-> /usr/lib",
		"opt":             "dir",
		"opt/new":         "new",
		"ro":              "dir",
		"ro/inside":       "x",
		"esc":             "-> ../../..",
		"pwned":           "contained",
	}
	if got := readTree(t, filepath.Join(bundle, "rootfs")); !reflect.DeepEqual(got, want) {
		t.Errorf("rootfs\n got %v\nwant %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(tmp, "pwned")); err == nil {
		t.Error("a layer wrote outside the root filesystem")
	}

	var spec struct {
		Process struct {
			User struct {
				UID int `json:"uid"`
				GID int `json:"gid"`
			} `json:"user"`
			Args []string `json:"args"`
		} `json:"process"`
		Root struct {
			Path string `json:"path"`
		} `json:"root"`
	}
	data, _ := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.Process.User.UID != 65534 || spec.Process.User.GID != 65533 || strings.Join(spec.Process.Args, " ") != "/bin/sh -c true" || spec.Root.Path != "rootfs" {
		t.Errorf("config.json %s", data)
	}
	state, err := readState(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if e := state.Entries["ro"]; e.Mode != 0o555 {
		t.Errorf("recorded ro as %+v", e)
	}

	escape := layerOf(t, tarFile("../evil", "x", 0o644))
	bad := testImage(t, filepath.Join(tmp, "bad"), baseConfig("amd64"), escape)
	if _, stderr, code := runTool(t, "unpack", "--image", bad.Dir, "--output", filepath.Join(tmp, "bad-bundle")); code != 1 || !strings.Contains(stderr, "leaves the root") {
		t.Errorf("an escaping entry gave exit %d: %s", code, stderr)
	}
}

func TestRepackRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	l := layeredImage(t, filepath.Join(tmp, "image"))
	bundle := filepath.Join(tmp, "bundle")
	mustRun(t, "unpack", "--image", l.Dir, "--output", bundle)
	repacked := filepath.Join(tmp, "repacked")
	mustRun(t, "repack", "--bundle", bundle, "--output", repacked, "--tag", "again")
	mustRun(t, "validate", repacked)
	m, _ := (Layout{repacked}).Resolve("again")
	manifest, _, _ := (Layout{repacked}).Image(m)
	if len(manifest.Layers) != 1 {
		t.Errorf("a repack without a base has %d layers", len(manifest.Layers))
	}
	again := filepath.Join(tmp, "again")
	mustRun(t, "unpack", "--image", repacked, "--tag", "again", "--output", again)
	if a, b := readTree(t, filepath.Join(bundle, "rootfs")), readTree(t, filepath.Join(again, "rootfs")); !reflect.DeepEqual(a, b) {
		t.Errorf("round trip changed the tree:\n%v\n%v", a, b)
	}
	first, _ := readState(bundle)
	second, _ := readState(again)
	for p, e := range first.Entries {
		if s := second.Entries[p]; s.Mode != e.Mode || s.UID != e.UID || s.GID != e.GID {
			t.Errorf("%s was %+v, repacked as %+v", p, e, s)
		}
	}
}

func TestRepackChangesOnly(t *testing.T) {
	tmp := t.TempDir()
	l := layeredImage(t, filepath.Join(tmp, "image"))
	bundle := filepath.Join(tmp, "bundle")
	mustRun(t, "unpack", "--image", l.Dir, "--output", bundle)
	rootfs := filepath.Join(bundle, "rootfs")
	os.WriteFile(filepath.Join(rootfs, "opt", "new"), []byte("changed"), 0o644)
	os.Remove(filepath.Join(rootfs, "bin", "sh2"))
	writeFile(t, filepath.Join(rootfs, "added"), []byte("added"))

	out := filepath.Join(tmp, "out")
	mustRun(t, "repack", "--bundle", bundle, "--base", l.Dir, "--output", out)
	mustRun(t, "validate", out)
	m, _ := readConfig(t, Layout{out})
	if len(m.Layers) != 3 {
		t.Fatalf("%d layers, want the base's 2 and one more", len(m.Layers))
	}
	path, _ := Layout{out}.blobPath(m.Layers[2].Digest)
	var names []string
	for _, e := range readTar(t, path) {
		names = append(names, e.name)
	}
	if strings.Join(names, " ") != "added opt/new bin/.wh.sh2" {
		t.Errorf("the new layer holds %v", names)
	}

	unpacked := filepath.Join(tmp, "unpacked")
	mustRun(t, "unpack", "--image", out, "--output", unpacked)
	tree := readTree(t, filepath.Join(unpacked, "rootfs"))
	if tree["opt/new"] != "changed" || tree["added"] != "added" || tree["bin/sh2"] != "" {
		t.Errorf("unpacked %v", tree)
	}

	other := testImage(t, filepath.Join(tmp, "other"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	if _, stderr, code := runTool(t, "repack", "--bundle", bundle, "--base", other.Dir, "--output", filepath.Join(tmp, "x")); code != 1 || !strings.Contains(stderr, "was unpacked from") {
		t.Errorf("the wrong base gave exit %d: %s", code, stderr)
	}
}
