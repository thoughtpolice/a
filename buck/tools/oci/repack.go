// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"time"
)

func runRepack(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("repack", "--bundle DIR --output DIR [--tag TAG] [--base LAYOUT]", stderr)
	bundle := flags.String("bundle", "", "bundle from oci_unpack")
	output := flags.String("output", "", "output image layout")
	tag := flags.String("tag", "latest", "tag for the new image")
	base := flags.String("base", "", "the image the bundle was unpacked from, to add only the changes to")
	created := flags.String("created", "1970-01-01T00:00:00Z", "RFC 3339 creation time for the new history entry")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "bundle", "output"); err != nil {
		return err
	}
	return repack(*bundle, *base, Layout{*output}, *tag, *created, stderr)
}

// repack turns a bundle's root filesystem back into an image. With no base
// the whole filesystem becomes the image's one layer. With a base, which
// has to be the image the bundle was unpacked from, the image is the base
// plus one layer of what changed in rootfs/ since then, with whiteouts for
// what was removed. Paths the unpack recorded keep their original owners
// and modes; new and changed ones belong to root. A change of mode alone
// is not seen.
func repack(bundle, base string, out Layout, tag, created string, log io.Writer) error {
	state, err := readState(bundle)
	if err != nil {
		return err
	}
	rootfs := filepath.Join(bundle, "rootfs")
	current, err := scanRootfs(rootfs)
	if err != nil {
		return err
	}

	var baseLayout Layout
	var baseManifest *Manifest
	var entries []layerEntry
	if base != "" {
		baseLayout = Layout{base}
		desc, err := baseLayout.Resolve("")
		if err != nil {
			return fmt.Errorf("base: %w", err)
		}
		if desc.Digest != state.Manifest.Digest {
			return fmt.Errorf("the bundle was unpacked from %s, not the base %s", state.Manifest.Digest, desc.Digest)
		}
		if baseManifest, _, err = baseLayout.Image(desc); err != nil {
			return fmt.Errorf("base: %w", err)
		}
		entries = changes(state.Entries, current)
	} else {
		for _, p := range sortedPaths(current) {
			entries = append(entries, layerEntry{path: p, entry: keepRecorded(state.Entries, p, current[p])})
		}
	}

	var config map[string]any
	if err := decodeJSON(state.Config, &config); err != nil {
		return fmt.Errorf("recorded config: %w", err)
	}
	if err := out.Create(); err != nil {
		return err
	}
	var layers []Descriptor
	var diffIDs []any
	var history []any
	if baseManifest != nil {
		for _, layer := range baseManifest.Layers {
			if err := out.CopyBlob(baseLayout, layer.Digest); err != nil {
				return err
			}
			layer.MediaType = ociMediaType(layer.MediaType)
			layers = append(layers, layer)
		}
		rootfsConfig, err := object(config, "rootfs")
		if err != nil {
			return err
		}
		if diffIDs, err = list(rootfsConfig, "diff_ids"); err != nil {
			return err
		}
		if history, err = list(config, "history"); err != nil {
			return err
		}
	}
	if baseManifest == nil || len(entries) > 0 {
		desc, diffID, err := writeLayer(out, rootfs, entries)
		if err != nil {
			return err
		}
		layers = append(layers, desc)
		diffIDs = append(diffIDs, diffID)
		history = append(history, map[string]any{"created": created, "created_by": "buck2 oci_repack"})
		fmt.Fprintf(log, "oci repack: new layer %s with %d entries\n", desc.Digest, len(entries))
	} else {
		fmt.Fprintln(log, "oci repack: nothing changed, so no layer was added")
	}
	config["rootfs"] = map[string]any{"type": "layers", "diff_ids": diffIDs}
	config["history"] = history
	config["created"] = created

	configDesc, err := out.WriteBlob(mediaTypeConfig, marshal(config))
	if err != nil {
		return err
	}
	manifestDesc, err := out.WriteBlob(mediaTypeManifest, marshal(Manifest{SchemaVersion: 2, MediaType: mediaTypeManifest, Config: configDesc, Layers: layers}))
	if err != nil {
		return err
	}
	manifestDesc.Annotations = map[string]string{annotationRefName: tag}
	return out.WriteIndex(&Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: []Descriptor{manifestDesc}})
}

// scanRootfs records each path below rootfs as it is on disk now.
func scanRootfs(rootfs string) (map[string]rootfsEntry, error) {
	entries := map[string]rootfsEntry{}
	err := filepath.WalkDir(rootfs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(rootfs, p)
		if rel == "." {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		e := rootfsEntry{Mode: int64(info.Mode().Perm())}
		if info.Mode()&os.ModeSetuid != 0 {
			e.Mode |= 0o4000
		}
		if info.Mode()&os.ModeSetgid != 0 {
			e.Mode |= 0o2000
		}
		if info.Mode()&os.ModeSticky != 0 {
			e.Mode |= 0o1000
		}
		switch {
		case info.IsDir():
			e.Type = "dir"
		case info.Mode()&os.ModeSymlink != 0:
			e.Type = "symlink"
			if e.Link, err = os.Readlink(p); err != nil {
				return err
			}
		case info.Mode().IsRegular():
			e.Type = "file"
			if e.Digest, e.Size, err = fileDigest(p); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s: cannot repack a %s", p, info.Mode().Type())
		}
		entries[filepath.ToSlash(rel)] = e
		return nil
	})
	return entries, err
}

func sameContent(recorded, now rootfsEntry) bool {
	return recorded.Type == now.Type && recorded.Digest == now.Digest && recorded.Link == now.Link
}

// keepRecorded uses the unpack's metadata for a path whose content is as
// unpack left it, and the file's own mode, owned by root, for anything
// else. Modes on disk are not compared: Buck normalizes the modes of the
// outputs it materializes, so a bundle's rootfs/ seldom keeps them.
func keepRecorded(recorded map[string]rootfsEntry, p string, now rootfsEntry) rootfsEntry {
	if r, ok := recorded[p]; ok && sameContent(r, now) {
		return r
	}
	now.UID, now.GID = 0, 0
	return now
}

type layerEntry struct {
	path     string
	entry    rootfsEntry
	whiteout bool
}

// changes lists what differs between the unpacked state and rootfs now:
// new and modified paths, and a whiteout for each removed path whose
// parent is still there.
func changes(recorded, current map[string]rootfsEntry) []layerEntry {
	var out []layerEntry
	for _, p := range sortedPaths(current) {
		now := current[p]
		if r, ok := recorded[p]; ok && sameContent(r, now) {
			continue
		}
		out = append(out, layerEntry{path: p, entry: keepRecorded(recorded, p, now)})
	}
	for _, p := range sortedPaths(recorded) {
		if _, ok := current[p]; ok {
			continue
		}
		if parent := path.Dir(p); parent != "." {
			if _, ok := current[parent]; !ok {
				continue
			}
		}
		out = append(out, layerEntry{path: path.Join(path.Dir(p), ".wh."+path.Base(p)), whiteout: true})
	}
	return out
}

// writeLayer writes entries from rootfs as a gzipped layer and returns its
// descriptor and diff ID.
func writeLayer(out Layout, rootfs string, entries []layerEntry) (Descriptor, string, error) {
	tmp, err := os.CreateTemp(filepath.Join(out.Dir, "blobs", "sha256"), ".layer-")
	if err != nil {
		return Descriptor{}, "", err
	}
	defer os.Remove(tmp.Name())
	compressed := sha256.New()
	buf := bufio.NewWriterSize(io.MultiWriter(tmp, compressed), 1<<20)
	zw, _ := gzip.NewWriterLevel(buf, gzip.DefaultCompression)
	uncompressed := sha256.New()
	tw := tar.NewWriter(io.MultiWriter(zw, uncompressed))
	for _, le := range entries {
		hdr := &tar.Header{Name: le.path, ModTime: time.Unix(0, 0), Mode: le.entry.Mode, Uid: le.entry.UID, Gid: le.entry.GID}
		switch {
		case le.whiteout:
			hdr.Typeflag, hdr.Mode = tar.TypeReg, 0o644
		case le.entry.Type == "dir":
			hdr.Typeflag, hdr.Name = tar.TypeDir, le.path+"/"
		case le.entry.Type == "symlink":
			hdr.Typeflag, hdr.Linkname = tar.TypeSymlink, le.entry.Link
		default:
			hdr.Typeflag, hdr.Size = tar.TypeReg, le.entry.Size
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return Descriptor{}, "", err
		}
		if hdr.Typeflag == tar.TypeReg && !le.whiteout {
			f, err := os.Open(filepath.Join(rootfs, le.path))
			if err != nil {
				return Descriptor{}, "", err
			}
			_, err = io.Copy(tw, f)
			f.Close()
			if err != nil {
				return Descriptor{}, "", err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return Descriptor{}, "", err
	}
	if err := zw.Close(); err != nil {
		return Descriptor{}, "", err
	}
	if err := buf.Flush(); err != nil {
		return Descriptor{}, "", err
	}
	info, err := tmp.Stat()
	if err != nil {
		return Descriptor{}, "", err
	}
	if err := tmp.Chmod(0o644); err != nil {
		return Descriptor{}, "", err
	}
	if err := tmp.Close(); err != nil {
		return Descriptor{}, "", err
	}
	digest := "sha256:" + hex.EncodeToString(compressed.Sum(nil))
	dest, _ := out.blobPath(digest)
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return Descriptor{}, "", err
	}
	diffID := "sha256:" + hex.EncodeToString(uncompressed.Sum(nil))
	return Descriptor{MediaType: mediaTypeLayerGzip, Digest: digest, Size: info.Size()}, diffID, nil
}
