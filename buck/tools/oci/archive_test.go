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
	"testing"
)

// untar extracts a flat archive of regular files and directories.
func untar(t *testing.T, archive, dir string) map[string][]byte {
	t.Helper()
	f, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	files := map[string][]byte{}
	tr := tar.NewReader(f)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return files
		} else if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, hdr.Name)
		if hdr.Typeflag == tar.TypeDir {
			os.MkdirAll(path, 0o755)
			continue
		}
		data, _ := io.ReadAll(tr)
		files[hdr.Name] = data
		writeFile(t, path, data)
	}
}

func TestArchive(t *testing.T) {
	tmp := t.TempDir()
	layer := gzipBytes(t, tarBytes(t, map[string]string{"hello": "world"}))
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), layer)
	out := filepath.Join(tmp, "image.tar")
	mustRun(t, "archive", "--image", l.Dir, "--output", out, "--name", "app", "--tag", "v1")

	extracted := filepath.Join(tmp, "extracted")
	files := untar(t, out, extracted)
	mustRun(t, "validate", extracted)

	var legacy []struct {
		Config   string
		RepoTags []string
		Layers   []string
	}
	if err := json.Unmarshal(files["manifest.json"], &legacy); err != nil {
		t.Fatal(err)
	}
	m, _ := readConfig(t, l)
	want := "blobs/sha256/" + m.Layers[0].Digest[len("sha256:"):]
	if len(legacy) != 1 || !reflect.DeepEqual(legacy[0].RepoTags, []string{"app:v1"}) || !reflect.DeepEqual(legacy[0].Layers, []string{want}) {
		t.Fatalf("manifest.json %+v", legacy)
	}
	if _, ok := files[legacy[0].Config]; !ok {
		t.Errorf("manifest.json names config %s, which isn't in the archive", legacy[0].Config)
	}
	if !bytes.Equal(files[want], layer) {
		t.Error("the layer was not copied as it is")
	}
	desc, err := Layout{extracted}.Resolve("v1")
	if err != nil {
		t.Fatal(err)
	}
	if desc.Annotations["io.containerd.image.name"] != "docker.io/library/app:v1" {
		t.Errorf("annotations %v", desc.Annotations)
	}

	again := filepath.Join(tmp, "again.tar")
	mustRun(t, "archive", "--image", l.Dir, "--output", again, "--name", "app", "--tag", "v1")
	a, _ := os.ReadFile(out)
	b, _ := os.ReadFile(again)
	if !bytes.Equal(a, b) {
		t.Error("identical inputs gave different archives")
	}
}
