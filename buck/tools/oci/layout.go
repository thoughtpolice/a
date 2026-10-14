// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	mediaTypeIndex          = "application/vnd.oci.image.index.v1+json"
	mediaTypeManifest       = "application/vnd.oci.image.manifest.v1+json"
	mediaTypeConfig         = "application/vnd.oci.image.config.v1+json"
	mediaTypeLayer          = "application/vnd.oci.image.layer.v1.tar"
	mediaTypeLayerGzip      = "application/vnd.oci.image.layer.v1.tar+gzip"
	mediaTypeLayerZstd      = "application/vnd.oci.image.layer.v1.tar+zstd"
	mediaTypeDockerList     = "application/vnd.docker.distribution.manifest.list.v2+json"
	mediaTypeDockerManifest = "application/vnd.docker.distribution.manifest.v2+json"
	mediaTypeDockerConfig   = "application/vnd.docker.container.image.v1+json"
	mediaTypeDockerLayer    = "application/vnd.docker.image.rootfs.diff.tar.gzip"
	mediaTypeDockerForeign  = "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip"

	annotationRefName = "org.opencontainers.image.ref.name"
)

// Descriptor points at a blob by digest.
type Descriptor struct {
	MediaType    string            `json:"mediaType"`
	Digest       string            `json:"digest"`
	Size         int64             `json:"size"`
	URLs         []string          `json:"urls,omitempty"`
	Annotations  map[string]string `json:"annotations,omitempty"`
	Platform     *Platform         `json:"platform,omitempty"`
	ArtifactType string            `json:"artifactType,omitempty"`
}

type Platform struct {
	Architecture string   `json:"architecture"`
	OS           string   `json:"os"`
	OSVersion    string   `json:"os.version,omitempty"`
	OSFeatures   []string `json:"os.features,omitempty"`
	Variant      string   `json:"variant,omitempty"`
}

func (p Platform) String() string {
	s := p.OS + "/" + p.Architecture
	if p.Variant != "" {
		s += "/" + p.Variant
	}
	return s
}

// parsePlatform reads OS/ARCH[/VARIANT].
func parsePlatform(s string) (Platform, error) {
	parts := strings.Split(s, "/")
	if len(parts) < 2 || len(parts) > 3 || parts[0] == "" || parts[1] == "" {
		return Platform{}, fmt.Errorf("platform %q is not OS/ARCH[/VARIANT]", s)
	}
	p := Platform{OS: parts[0], Architecture: parts[1]}
	if len(parts) == 3 {
		p.Variant = parts[2]
	}
	return p, nil
}

type Manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType,omitempty"`
	ArtifactType  string            `json:"artifactType,omitempty"`
	Config        Descriptor        `json:"config"`
	Layers        []Descriptor      `json:"layers"`
	Subject       *Descriptor       `json:"subject,omitempty"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

type Index struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType,omitempty"`
	ArtifactType  string            `json:"artifactType,omitempty"`
	Manifests     []Descriptor      `json:"manifests"`
	Subject       *Descriptor       `json:"subject,omitempty"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

func isIndexType(mediaType string) bool {
	return mediaType == mediaTypeIndex || mediaType == mediaTypeDockerList
}

func isManifestType(mediaType string) bool {
	return mediaType == mediaTypeManifest || mediaType == mediaTypeDockerManifest
}

// ociMediaType maps a Docker schema 2 media type to its OCI equivalent, as
// skopeo does when it writes an OCI layout. Others pass through.
func ociMediaType(mediaType string) string {
	switch mediaType {
	case mediaTypeDockerList:
		return mediaTypeIndex
	case mediaTypeDockerManifest:
		return mediaTypeManifest
	case mediaTypeDockerConfig:
		return mediaTypeConfig
	case mediaTypeDockerLayer:
		return mediaTypeLayerGzip
	case mediaTypeDockerForeign:
		return "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"
	}
	return mediaType
}

func sha256Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// splitDigest checks a digest and returns its algorithm and hex encoding.
func splitDigest(digest string) (string, string, error) {
	algorithm, encoded, ok := strings.Cut(digest, ":")
	if !ok || algorithm != "sha256" || len(encoded) != 64 {
		return "", "", fmt.Errorf("unsupported digest %q", digest)
	}
	if _, err := hex.DecodeString(encoded); err != nil || strings.ToLower(encoded) != encoded {
		return "", "", fmt.Errorf("malformed digest %q", digest)
	}
	return algorithm, encoded, nil
}

// marshal encodes JSON the same way every time: Go sorts map keys, and
// struct fields keep their declared order.
func marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

// decodeJSON decodes data, keeping numbers exact so that configs written by
// other tools round-trip unchanged.
func decodeJSON(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data after JSON value")
	}
	return nil
}

// Layout is an OCI image layout directory.
type Layout struct{ Dir string }

func (l Layout) blobPath(digest string) (string, error) {
	algorithm, encoded, err := splitDigest(digest)
	if err != nil {
		return "", err
	}
	return filepath.Join(l.Dir, "blobs", algorithm, encoded), nil
}

// ReadIndex reads index.json.
func (l Layout) ReadIndex() (*Index, error) {
	data, err := os.ReadFile(filepath.Join(l.Dir, "index.json"))
	if err != nil {
		return nil, fmt.Errorf("%s is not an OCI image layout: %w", l.Dir, err)
	}
	var index Index
	if err := decodeJSON(data, &index); err != nil {
		return nil, fmt.Errorf("%s/index.json: %w", l.Dir, err)
	}
	return &index, nil
}

// ReadBlob reads a blob and checks its digest, and its size when the
// descriptor gives one.
func (l Layout) ReadBlob(desc Descriptor) ([]byte, error) {
	path, err := l.blobPath(desc.Digest)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if got := sha256Digest(data); got != desc.Digest {
		return nil, fmt.Errorf("blob %s has digest %s", desc.Digest, got)
	}
	if desc.Size != 0 && int64(len(data)) != desc.Size {
		return nil, fmt.Errorf("blob %s is %d bytes, not %d", desc.Digest, len(data), desc.Size)
	}
	return data, nil
}

func (l Layout) ReadManifest(desc Descriptor) (*Manifest, error) {
	data, err := l.ReadBlob(desc)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := decodeJSON(data, &m); err != nil {
		return nil, fmt.Errorf("manifest %s: %w", desc.Digest, err)
	}
	return &m, nil
}

// Resolve picks the index.json entry tagged ref, or the only entry when the
// layout has one and ref is empty.
func (l Layout) Resolve(ref string) (Descriptor, error) {
	index, err := l.ReadIndex()
	if err != nil {
		return Descriptor{}, err
	}
	if ref == "" {
		if len(index.Manifests) != 1 {
			return Descriptor{}, fmt.Errorf("%s lists %d manifests; name one by tag", l.Dir, len(index.Manifests))
		}
		return index.Manifests[0], nil
	}
	for _, desc := range index.Manifests {
		if desc.Annotations[annotationRefName] == ref {
			return desc, nil
		}
	}
	// An untagged single-image layout still answers to the default tag.
	if len(index.Manifests) == 1 && index.Manifests[0].Annotations[annotationRefName] == "" && ref == "latest" {
		return index.Manifests[0], nil
	}
	return Descriptor{}, fmt.Errorf("%s has no image tagged %q", l.Dir, ref)
}

// Image reads the single-platform image that desc names.
func (l Layout) Image(desc Descriptor) (*Manifest, []byte, error) {
	if !isManifestType(desc.MediaType) {
		return nil, nil, fmt.Errorf("%s is a %s, not a single-platform image manifest", desc.Digest, desc.MediaType)
	}
	m, err := l.ReadManifest(desc)
	if err != nil {
		return nil, nil, err
	}
	config, err := l.ReadBlob(m.Config)
	if err != nil {
		return nil, nil, fmt.Errorf("config: %w", err)
	}
	return m, config, nil
}

// Create starts a layout at l.Dir, which may already exist.
func (l Layout) Create() error {
	if err := os.MkdirAll(filepath.Join(l.Dir, "blobs", "sha256"), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(l.Dir, "oci-layout"), []byte(`{"imageLayoutVersion":"1.0.0"}`), 0o644)
}

func (l Layout) WriteIndex(index *Index) error {
	return os.WriteFile(filepath.Join(l.Dir, "index.json"), marshal(index), 0o644)
}

// WriteBlob stores data and returns its descriptor.
func (l Layout) WriteBlob(mediaType string, data []byte) (Descriptor, error) {
	desc := Descriptor{MediaType: mediaType, Digest: sha256Digest(data), Size: int64(len(data))}
	path, err := l.blobPath(desc.Digest)
	if err != nil {
		return desc, err
	}
	return desc, os.WriteFile(path, data, 0o644)
}

// CopyBlob copies a blob from src into l, unless l already has it.
func (l Layout) CopyBlob(src Layout, digest string) error {
	from, err := src.blobPath(digest)
	if err != nil {
		return err
	}
	to, err := l.blobPath(digest)
	if err != nil {
		return err
	}
	return copyFile(from, to)
}

// AddFile stores the file at path as a blob, returning its digest and size.
func (l Layout) AddFile(path string) (string, int64, error) {
	digest, size, err := fileDigest(path)
	if err != nil {
		return "", 0, err
	}
	to, err := l.blobPath(digest)
	if err != nil {
		return "", 0, err
	}
	return digest, size, copyFile(path, to)
}

func fileDigest(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), n, nil
}

// copyFile copies a regular file, sharing its extents with a reflink where
// the filesystem can. Image layers are large, and the copy is immutable
// once Buck has the output. An existing destination is left alone, since
// blobs are content-addressed.
func copyFile(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return nil
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(to), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if unix.IoctlFileClone(int(tmp.Fd()), int(src.Fd())) != nil {
		if _, err := io.Copy(tmp, src); err != nil {
			tmp.Close()
			return err
		}
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), to)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
