// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

func runArchive(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("archive", "--image LAYOUT --output FILE --name NAME [--tag TAG] [--source-tag TAG]", stderr)
	image := flags.String("image", "", "image layout")
	output := flags.String("output", "", "archive to write")
	name := flags.String("name", "", "repository name to load the image as")
	tag := flags.String("tag", "latest", "tag to load the image as")
	sourceTag := flags.String("source-tag", "latest", "tag of the image in the layout")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "image", "output", "name"); err != nil {
		return err
	}
	f, err := os.Create(*output)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	if err := writeArchive(w, Layout{*image}, *sourceTag, *name+":"+*tag); err != nil {
		return err
	}
	if err := w.Flush(); err != nil {
		return err
	}
	return f.Close()
}

// writeArchive writes the image tagged sourceTag as a tar that is both an
// OCI image layout and a legacy Docker archive, with a manifest.json that
// names the same blobs. That is what docker save writes since Docker 25.
// docker load reads either half, and decompresses gzipped layers itself,
// so the blobs go in as they are.
func writeArchive(w io.Writer, layout Layout, sourceTag, repoTag string) error {
	desc, err := layout.Resolve(sourceTag)
	if err != nil {
		return err
	}
	manifest, _, err := layout.Image(desc)
	if err != nil {
		return err
	}
	name, tag := repoTag, "latest"
	if i := strings.LastIndex(repoTag, ":"); i > strings.LastIndex(repoTag, "/") {
		name, tag = repoTag[:i], repoTag[i+1:]
	}
	fullName := name
	if ref, err := parseReference(repoTag); err == nil {
		fullName = ref.name()
	}

	tw := tar.NewWriter(w)
	header := func(name string, size int64, dir bool) *tar.Header {
		h := &tar.Header{Name: name, Size: size, Mode: 0o644, Typeflag: tar.TypeReg, ModTime: time.Unix(0, 0)}
		if dir {
			h.Mode, h.Typeflag = 0o755, tar.TypeDir
		}
		return h
	}
	addBytes := func(name string, data []byte) error {
		if err := tw.WriteHeader(header(name, int64(len(data)), false)); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	addBlob := func(d Descriptor) error {
		path, err := layout.blobPath(d.Digest)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		_, encoded, _ := splitDigest(d.Digest)
		if err := tw.WriteHeader(header("blobs/sha256/"+encoded, info.Size(), false)); err != nil {
			return err
		}
		_, err = io.Copy(tw, f)
		return err
	}
	blobName := func(digest string) string {
		_, encoded, _ := splitDigest(digest)
		return "blobs/sha256/" + encoded
	}

	if err := addBytes("oci-layout", []byte(`{"imageLayoutVersion":"1.0.0"}`)); err != nil {
		return err
	}
	for _, dir := range []string{"blobs/", "blobs/sha256/"} {
		if err := tw.WriteHeader(header(dir, 0, true)); err != nil {
			return err
		}
	}
	layers := make([]string, 0, len(manifest.Layers))
	written := map[string]bool{}
	for _, d := range append(append([]Descriptor{}, manifest.Layers...), manifest.Config, desc) {
		if !written[d.Digest] {
			written[d.Digest] = true
			if err := addBlob(d); err != nil {
				return err
			}
		}
	}
	for _, layer := range manifest.Layers {
		layers = append(layers, blobName(layer.Digest))
	}
	top := Descriptor{
		MediaType: desc.MediaType,
		Digest:    desc.Digest,
		Size:      desc.Size,
		Annotations: map[string]string{
			"io.containerd.image.name": fullName + ":" + tag,
			annotationRefName:          tag,
		},
	}
	if err := addBytes("index.json", marshal(Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: []Descriptor{top}})); err != nil {
		return err
	}
	legacy := []map[string]any{{
		"Config":   blobName(manifest.Config.Digest),
		"RepoTags": []string{name + ":" + tag},
		"Layers":   layers,
	}}
	if err := addBytes("manifest.json", marshal(legacy)); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return fmt.Errorf("writing the archive: %w", err)
	}
	return nil
}
