// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// tarBytes returns an uncompressed tar holding the given files.
func tarBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, name := range sortedKeys(files) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(files[name])), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		io.WriteString(tw, files[name])
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func gzipBytes(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(data)
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func writeFile(t *testing.T, path string, data []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// testImage writes a single-platform layout with the given layer tars
// (uncompressed) and config, tagged latest, and returns it.
func testImage(t *testing.T, dir string, config map[string]any, layers ...[]byte) Layout {
	t.Helper()
	l := Layout{dir}
	if err := l.Create(); err != nil {
		t.Fatal(err)
	}
	var descs []Descriptor
	var diffIDs []any
	for _, layer := range layers {
		desc, err := l.WriteBlob(mediaTypeLayer, layer)
		if err != nil {
			t.Fatal(err)
		}
		descs = append(descs, desc)
		diffIDs = append(diffIDs, desc.Digest)
	}
	config["rootfs"] = map[string]any{"type": "layers", "diff_ids": diffIDs}
	configDesc, err := l.WriteBlob(mediaTypeConfig, marshal(config))
	if err != nil {
		t.Fatal(err)
	}
	m, err := l.WriteBlob(mediaTypeManifest, marshal(Manifest{SchemaVersion: 2, MediaType: mediaTypeManifest, Config: configDesc, Layers: descs}))
	if err != nil {
		t.Fatal(err)
	}
	m.Annotations = map[string]string{annotationRefName: "latest"}
	if err := l.WriteIndex(&Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: []Descriptor{m}}); err != nil {
		t.Fatal(err)
	}
	return l
}

func baseConfig(arch string) map[string]any {
	return map[string]any{
		"architecture": arch,
		"os":           "linux",
		"config": map[string]any{
			"Env":    []any{"PATH=/bin", "SHARED=base"},
			"Labels": map[string]any{"keep": "1", "shared": "base"},
		},
		"history":     []any{map[string]any{"created_by": "base"}},
		"future-only": json.Number("12345678901234567890"),
	}
}

func runTool(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr)
	return stdout.String(), stderr.String(), code
}

func mustRun(t *testing.T, args ...string) string {
	t.Helper()
	stdout, stderr, code := runTool(t, args...)
	if code != 0 {
		t.Fatalf("oci %s: exit %d\n%s", strings.Join(args, " "), code, stderr)
	}
	return stdout
}

func readConfig(t *testing.T, l Layout) (*Manifest, map[string]any) {
	t.Helper()
	desc, err := l.Resolve("latest")
	if err != nil {
		t.Fatal(err)
	}
	m, data, err := l.Image(desc)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := decodeJSON(data, &config); err != nil {
		t.Fatal(err)
	}
	return m, config
}

func TestImage(t *testing.T) {
	tmp := t.TempDir()
	base := testImage(t, filepath.Join(tmp, "base"), baseConfig("amd64"), tarBytes(t, map[string]string{"etc/base": "base\n"}))
	newLayer := tarBytes(t, map[string]string{"app/run": "#!/bin/sh\n"})
	gz := writeFile(t, filepath.Join(tmp, "layer.tar.gz"), gzipBytes(t, newLayer))
	plain := writeFile(t, filepath.Join(tmp, "layer.tar"), newLayer)
	out := filepath.Join(tmp, "out")

	mustRun(t, "image", "--base", base.Dir, "--output", out,
		"--layer", gz, "--layer", plain,
		"--env", "SHARED=new", "--env", "ADDED=a=b",
		"--label", "shared=new", "--label", "added=1",
		"--entrypoint", `["/bin/sh","-c"]`, "--cmd", `["echo a,b"]`,
		"--workdir", "/app", "--user", "nobody",
		"--exposed-port", "8080/tcp", "--volume", "/data")
	mustRun(t, "validate", out)

	m, config := readConfig(t, Layout{out})
	if len(m.Layers) != 3 || m.Layers[1].MediaType != mediaTypeLayerGzip || m.Layers[2].MediaType != mediaTypeLayer {
		t.Fatalf("layers %+v", m.Layers)
	}
	c := config["config"].(map[string]any)
	want := map[string]any{
		"Env":          []any{"PATH=/bin", "SHARED=new", "ADDED=a=b"},
		"Labels":       map[string]any{"keep": "1", "shared": "new", "added": "1"},
		"Entrypoint":   []any{"/bin/sh", "-c"},
		"Cmd":          []any{"echo a,b"},
		"WorkingDir":   "/app",
		"User":         "nobody",
		"ExposedPorts": map[string]any{"8080/tcp": map[string]any{}},
		"Volumes":      map[string]any{"/data": map[string]any{}},
	}
	if !reflect.DeepEqual(c, want) {
		t.Errorf("config %#v\nwant %#v", c, want)
	}
	diffIDs := config["rootfs"].(map[string]any)["diff_ids"].([]any)
	if len(diffIDs) != 3 || diffIDs[1] != sha256Digest(newLayer) || diffIDs[2] != sha256Digest(newLayer) {
		t.Errorf("diff_ids %v", diffIDs)
	}
	if history := config["history"].([]any); len(history) != 3 {
		t.Errorf("history %v", history)
	}
	if config["created"] != "1970-01-01T00:00:00Z" {
		t.Errorf("created %v", config["created"])
	}
	if config["future-only"] != json.Number("12345678901234567890") {
		t.Errorf("an unknown config field did not round-trip: %v", config["future-only"])
	}

	// The same inputs give the same image.
	again := filepath.Join(tmp, "again")
	mustRun(t, "image", "--base", base.Dir, "--output", again,
		"--layer", gz, "--layer", plain,
		"--env", "SHARED=new", "--env", "ADDED=a=b",
		"--label", "shared=new", "--label", "added=1",
		"--entrypoint", `["/bin/sh","-c"]`, "--cmd", `["echo a,b"]`,
		"--workdir", "/app", "--user", "nobody",
		"--exposed-port", "8080/tcp", "--volume", "/data")
	for _, name := range []string{"index.json", "oci-layout"} {
		a, _ := os.ReadFile(filepath.Join(out, name))
		b, _ := os.ReadFile(filepath.Join(again, name))
		if !bytes.Equal(a, b) {
			t.Errorf("%s differs between identical builds", name)
		}
	}
}

func TestImageMetadataOnly(t *testing.T) {
	tmp := t.TempDir()
	base := testImage(t, filepath.Join(tmp, "base"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	out := filepath.Join(tmp, "out")
	mustRun(t, "image", "--base", base.Dir, "--output", out, "--env", "ONLY=1")
	m, config := readConfig(t, Layout{out})
	if len(m.Layers) != 1 {
		t.Errorf("layers %v", m.Layers)
	}
	if got := config["config"].(map[string]any)["Labels"]; !reflect.DeepEqual(got, map[string]any{"keep": "1", "shared": "base"}) {
		t.Errorf("labels changed: %v", got)
	}
	if history := config["history"].([]any); len(history) != 1 {
		t.Errorf("history %v", history)
	}
}

func TestIndex(t *testing.T) {
	tmp := t.TempDir()
	amd := testImage(t, filepath.Join(tmp, "amd64"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "amd64"}))
	arm := testImage(t, filepath.Join(tmp, "arm64"), baseConfig("arm64"), tarBytes(t, map[string]string{"a": "arm64"}))
	out := filepath.Join(tmp, "out")
	mustRun(t, "index", "--output", out, "--image", "linux/amd64="+amd.Dir, "--image", "linux/arm64/v8="+arm.Dir)
	mustRun(t, "validate", out)
	index, err := Layout{out}.ReadIndex()
	if err != nil {
		t.Fatal(err)
	}
	if len(index.Manifests) != 2 {
		t.Fatalf("manifests %v", index.Manifests)
	}
	if p := index.Manifests[1].Platform; p == nil || p.String() != "linux/arm64/v8" {
		t.Errorf("platform %v", p)
	}

	if _, stderr, code := runTool(t, "index", "--output", filepath.Join(tmp, "bad"), "--image", "linux/arm64="+amd.Dir); code != 1 || !strings.Contains(stderr, "not linux/arm64") {
		t.Errorf("a mismatched platform gave exit %d: %s", code, stderr)
	}
}

func TestValidateRejectsCorruption(t *testing.T) {
	tmp := t.TempDir()
	l := testImage(t, filepath.Join(tmp, "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	mustRun(t, "validate", l.Dir)
	m, _ := readConfig(t, l)
	path, _ := l.blobPath(m.Layers[0].Digest)
	os.Chmod(path, 0o644)
	writeFile(t, path, []byte("rebuilt"))
	if _, stderr, code := runTool(t, "validate", l.Dir); code != 1 || !strings.Contains(stderr, "has digest") {
		t.Errorf("a corrupt layer gave exit %d: %s", code, stderr)
	}
}
