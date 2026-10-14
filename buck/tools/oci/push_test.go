// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// testIndexLayout writes one image per architecture into a layout the way
// oci_index does, with one index.json entry per platform.
func testIndexLayout(t *testing.T, dir string, arches ...string) Layout {
	t.Helper()
	l := Layout{dir}
	if err := l.Create(); err != nil {
		t.Fatal(err)
	}
	var manifests []Descriptor
	for _, arch := range arches {
		src := testImage(t, filepath.Join(t.TempDir(), arch), baseConfig(arch), tarBytes(t, map[string]string{"hello.txt": "hello from " + arch}))
		p := Platform{OS: "linux", Architecture: arch}
		desc, err := addPlatformImage(l, src, p)
		if err != nil {
			t.Fatal(err)
		}
		manifests = append(manifests, desc)
	}
	if err := l.WriteIndex(&Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: manifests}); err != nil {
		t.Fatal(err)
	}
	return l
}

func TestDestinations(t *testing.T) {
	for raw, want := range map[string]string{
		"ttl.sh/me:1h":                  "ttl.sh/me@D",
		"localhost:5000/app:v1":         "localhost:5000/app@D",
		"docker://ghcr.io/me/app:v1":    "ghcr.io/me/app@D",
		"alpine:3":                      "alpine@D",
		"oci:/tmp/out:v1":               "oci:/tmp/out:v1 D",
		"docker-archive:/tmp/a.tar:app": "docker-archive:/tmp/a.tar:app D",
	} {
		d, err := parseDestination(raw)
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if got := d.pinned("D"); got != want {
			t.Errorf("%s pinned as %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{"ttl.sh/me", "localhost:5000/app", "docker://ghcr.io/me/app", "ghcr.io/me/app@sha256:" + hex64("0"), "dir:/tmp/app", "docker-archive:/tmp/a.tar"} {
		if _, err := parseDestination(raw); err == nil {
			t.Errorf("%s was accepted", raw)
		}
	}
}

func TestPushSingleImageToLayout(t *testing.T) {
	tmp := t.TempDir()
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	out := filepath.Join(tmp, "out")
	line := strings.TrimSpace(mustRun(t, "push", "--image", l.Dir, "oci:"+out+":pushed"))
	dest, digest, _ := strings.Cut(line, " ")
	if dest != "oci:"+out+":pushed" {
		t.Errorf("printed %q", line)
	}
	mustRun(t, "validate", out)
	got, err := Layout{out}.Resolve("pushed")
	if err != nil || got.Digest != digest {
		t.Errorf("tagged %v, %v; printed %s", got, err, digest)
	}
}

func TestPushIndexAsOneImage(t *testing.T) {
	tmp := t.TempDir()
	l := testIndexLayout(t, filepath.Join(tmp, "index"), "amd64", "arm64")
	out := filepath.Join(tmp, "out")
	line := strings.TrimSpace(mustRun(t, "push", "--image", l.Dir, "oci:"+out+":multi"))
	_, digest, _ := strings.Cut(line, " ")
	mustRun(t, "validate", out)
	top, err := Layout{out}.Resolve("multi")
	if err != nil || top.MediaType != mediaTypeIndex || top.Digest != digest {
		t.Fatalf("tagged %+v, %v", top, err)
	}
	data, err := Layout{out}.ReadBlob(top)
	if err != nil {
		t.Fatal(err)
	}
	var nested Index
	decodeJSON(data, &nested)
	var arches []string
	for _, m := range nested.Manifests {
		arches = append(arches, m.Platform.Architecture)
	}
	sort.Strings(arches)
	if strings.Join(arches, ",") != "amd64,arm64" {
		t.Errorf("nested index has %v", arches)
	}
}

func TestStagedCopySurvivesRebuild(t *testing.T) {
	tmp := t.TempDir()
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	s, err := stage(l)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Buck replaces outputs by deleting and rewriting them.
	entries, _ := os.ReadDir(filepath.Join(l.Dir, "blobs", "sha256"))
	for _, e := range entries {
		path := filepath.Join(l.Dir, "blobs", "sha256", e.Name())
		os.Remove(path)
		os.WriteFile(path, []byte("rebuilt"), 0o644)
	}
	out := Layout{filepath.Join(tmp, "out")}
	if err := pushLayout(s, out, "v1"); err != nil {
		t.Fatal(err)
	}
	if err := validateLayout(out, os.Stderr); err != nil {
		t.Error(err)
	}
}

func TestPushRefusals(t *testing.T) {
	tmp := t.TempDir()
	empty := filepath.Join(tmp, "empty")
	writeFile(t, filepath.Join(empty, "index.json"), []byte(`{"schemaVersion":2,"manifests":[]}`))
	if _, stderr, code := runTool(t, "push", "--image", empty, "oci:"+filepath.Join(tmp, "unused")+":x"); code != 1 || !strings.Contains(stderr, "lists no manifests") {
		t.Errorf("an empty layout gave exit %d: %s", code, stderr)
	}
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	if _, stderr, code := runTool(t, "push", "--image", l.Dir, "--tag", "v1"); code != 2 || !strings.Contains(stderr, "needs a repository") {
		t.Errorf("--tag without a repository gave exit %d: %s", code, stderr)
	}
	if _, stderr, code := runTool(t, "push", "--image", l.Dir); code != 2 || !strings.Contains(stderr, "name a destination") {
		t.Errorf("no destination gave exit %d: %s", code, stderr)
	}
}

func TestPushTagsFromRepository(t *testing.T) {
	l := testImage(t, filepath.Join(t.TempDir(), "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	base := []string{"push", "--image", l.Dir, "--dry-run", "--repository", "ghcr.io/me/app", "--default-tag", "latest"}
	_, stderr, code := runTool(t, base...)
	if code != 0 || !strings.Contains(stderr, "to ghcr.io/me/app:latest") {
		t.Errorf("default tag gave exit %d: %s", code, stderr)
	}
	// --tag replaces the default tags, and may come after a destination.
	_, stderr, code = runTool(t, append(base, "ttl.sh/me:1h", "--tag", "v1")...)
	if code != 0 || !strings.Contains(stderr, "to ttl.sh/me:1h") || !strings.Contains(stderr, "to ghcr.io/me/app:v1") || strings.Contains(stderr, ":latest") {
		t.Errorf("--tag gave exit %d: %s", code, stderr)
	}
}

func TestPushToRegistry(t *testing.T) {
	reg := newFakeRegistry(t)
	tmp := t.TempDir()
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	reg.fail = 1
	line := strings.TrimSpace(mustRun(t, "push", "--image", l.Dir, reg.host()+"/me/app:v1"))
	desc, _ := l.Resolve("latest")
	if line != reg.host()+"/me/app@"+desc.Digest {
		t.Errorf("printed %q", line)
	}
	if got := reg.manifests["me/app"]["v1"].data; sha256Digest(got) != desc.Digest {
		t.Error("the registry's v1 is not the image")
	}
	if len(reg.uploaded) != 2 {
		t.Errorf("uploaded %v, want the config and the layer", reg.uploaded)
	}

	// The registry has every blob now, so a second push uploads nothing.
	reg.uploaded = nil
	mustRun(t, "push", "--image", l.Dir, reg.host()+"/me/app:v2")
	if len(reg.uploaded) != 0 {
		t.Errorf("pushed existing blobs again: %v", reg.uploaded)
	}

	// And it can be pulled back.
	out := filepath.Join(tmp, "pulled")
	mustRun(t, "pull", "--image", reg.host()+"/me/app:v2", "--output", out)
	if got, _ := (Layout{out}).Resolve("latest"); got.Digest != desc.Digest {
		t.Errorf("pulled %s, pushed %s", got.Digest, desc.Digest)
	}
}

func TestPushIndexToRegistry(t *testing.T) {
	reg := newFakeRegistry(t)
	l := testIndexLayout(t, filepath.Join(t.TempDir(), "index"), "amd64", "arm64")
	line := strings.TrimSpace(mustRun(t, "push", "--image", l.Dir, reg.host()+"/me/multi:v1"))
	_, digest, _ := strings.Cut(line, "@")
	top := reg.manifests["me/multi"]["v1"]
	if top.mediaType != mediaTypeIndex || sha256Digest(top.data) != digest {
		t.Fatalf("v1 is %s %s, printed %s", top.mediaType, sha256Digest(top.data), digest)
	}
	out := filepath.Join(t.TempDir(), "arm64")
	mustRun(t, "pull", "--image", reg.host()+"/me/multi:v1", "--platform", "linux/arm64", "--output", out)
	if _, config := readConfig(t, Layout{out}); config["architecture"] != "arm64" {
		t.Errorf("pulled %v", config["architecture"])
	}
}

func TestPushArchive(t *testing.T) {
	tmp := t.TempDir()
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	archive := filepath.Join(tmp, "app.tar")
	mustRun(t, "push", "--image", l.Dir, "docker-archive:"+archive+":app:v1")
	files := untar(t, archive, filepath.Join(tmp, "x"))
	if !strings.Contains(string(files["manifest.json"]), `"app:v1"`) {
		t.Errorf("manifest.json %s", files["manifest.json"])
	}
}
