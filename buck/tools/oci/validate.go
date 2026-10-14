// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func runValidate(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("validate", "LAYOUT...", stderr)
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if flags.NArg() == 0 {
		return usagef("name a layout")
	}
	for _, dir := range flags.Args() {
		if err := validateLayout(Layout{dir}, stdout); err != nil {
			return fmt.Errorf("%s: %w", dir, err)
		}
		fmt.Fprintf(stdout, "%s: valid OCI image layout\n", dir)
	}
	return nil
}

// validateLayout checks the layout marker, index.json, and every manifest,
// index, config and layer reachable from it: each blob must be present
// with the digest and size its descriptor gives, and every config must
// list one diff ID per layer.
func validateLayout(layout Layout, log io.Writer) error {
	data, err := os.ReadFile(filepath.Join(layout.Dir, "oci-layout"))
	if err != nil {
		return err
	}
	var marker struct {
		ImageLayoutVersion string `json:"imageLayoutVersion"`
	}
	if err := decodeJSON(data, &marker); err != nil {
		return fmt.Errorf("oci-layout: %w", err)
	}
	if marker.ImageLayoutVersion != "1.0.0" {
		return fmt.Errorf("oci-layout: unsupported imageLayoutVersion %q", marker.ImageLayoutVersion)
	}
	index, err := layout.ReadIndex()
	if err != nil {
		return err
	}
	if err := checkIndex(index, "index.json"); err != nil {
		return err
	}
	v := validator{layout: layout, log: log, seen: map[string]bool{}}
	for _, desc := range index.Manifests {
		if err := v.check(desc); err != nil {
			return err
		}
	}
	return nil
}

func checkIndex(index *Index, what string) error {
	if index.SchemaVersion != 2 {
		return fmt.Errorf("%s: schemaVersion %d, not 2", what, index.SchemaVersion)
	}
	if index.MediaType != "" && !isIndexType(index.MediaType) {
		return fmt.Errorf("%s: mediaType %q is not an index", what, index.MediaType)
	}
	if index.Manifests == nil {
		return fmt.Errorf("%s: no manifests list", what)
	}
	return nil
}

type validator struct {
	layout Layout
	log    io.Writer
	seen   map[string]bool
}

func (v validator) check(desc Descriptor) error {
	if v.seen[desc.Digest] {
		return nil
	}
	v.seen[desc.Digest] = true
	if desc.Size <= 0 {
		return fmt.Errorf("%s: descriptor has no size", desc.Digest)
	}
	switch {
	case isIndexType(desc.MediaType):
		data, err := v.layout.ReadBlob(desc)
		if err != nil {
			return err
		}
		var index Index
		if err := decodeJSON(data, &index); err != nil {
			return fmt.Errorf("index %s: %w", desc.Digest, err)
		}
		if err := checkIndex(&index, "index "+desc.Digest); err != nil {
			return err
		}
		for _, child := range index.Manifests {
			if err := v.check(child); err != nil {
				return err
			}
		}
		fmt.Fprintf(v.log, "index %s: %d manifests\n", desc.Digest, len(index.Manifests))
		return nil
	case isManifestType(desc.MediaType):
		return v.checkManifest(desc)
	default:
		return fmt.Errorf("%s: unexpected media type %q in an index", desc.Digest, desc.MediaType)
	}
}

func (v validator) checkManifest(desc Descriptor) error {
	m, err := v.layout.ReadManifest(desc)
	if err != nil {
		return err
	}
	if m.SchemaVersion != 2 {
		return fmt.Errorf("manifest %s: schemaVersion %d, not 2", desc.Digest, m.SchemaVersion)
	}
	if m.MediaType != "" && m.MediaType != desc.MediaType {
		return fmt.Errorf("manifest %s: mediaType %q, but its descriptor says %q", desc.Digest, m.MediaType, desc.MediaType)
	}
	if m.Config.Size <= 0 {
		return fmt.Errorf("manifest %s: config descriptor has no size", desc.Digest)
	}
	configData, err := v.layout.ReadBlob(m.Config)
	if err != nil {
		return fmt.Errorf("manifest %s: config: %w", desc.Digest, err)
	}
	var config struct {
		RootFS struct {
			DiffIDs []string `json:"diff_ids"`
		} `json:"rootfs"`
	}
	if err := decodeJSON(configData, &config); err != nil {
		return fmt.Errorf("manifest %s: config: %w", desc.Digest, err)
	}
	if len(config.RootFS.DiffIDs) != len(m.Layers) {
		return fmt.Errorf("manifest %s: %d layers, but the config lists %d diff IDs", desc.Digest, len(m.Layers), len(config.RootFS.DiffIDs))
	}
	for i, layer := range m.Layers {
		if err := v.checkBlobFile(layer); err != nil {
			return fmt.Errorf("manifest %s: layer %d: %w", desc.Digest, i, err)
		}
	}
	fmt.Fprintf(v.log, "manifest %s: %d layers\n", desc.Digest, len(m.Layers))
	return nil
}

// checkBlobFile verifies a blob that may be too large to read into memory.
func (v validator) checkBlobFile(desc Descriptor) error {
	path, err := v.layout.blobPath(desc.Digest)
	if err != nil {
		return err
	}
	digest, size, err := fileDigest(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("blob %s is missing", desc.Digest)
	} else if err != nil {
		return err
	}
	if digest != desc.Digest {
		return fmt.Errorf("blob %s has digest %s", desc.Digest, digest)
	}
	if size != desc.Size {
		return fmt.Errorf("blob %s is %d bytes, not %d", desc.Digest, size, desc.Size)
	}
	return nil
}
