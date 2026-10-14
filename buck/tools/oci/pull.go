// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
)

func runPull(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("pull", "--image REF [--digest DIGEST] --platform OS/ARCH --output DIR", stderr)
	image := flags.String("image", "", "image reference, such as docker.io/library/alpine")
	digest := flags.String("digest", "", "digest to pull, if the reference doesn't name one")
	platform := flags.String("platform", "linux/amd64", "platform to pick from a multi-platform image")
	output := flags.String("output", "", "output layout")
	authfile := flags.String("authfile", "", "registry credentials file")
	retries := flags.Int("retry-times", 3, "retries for each failed registry request")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "image", "output"); err != nil {
		return err
	}
	ref, err := parseReference(*image)
	if err != nil {
		return usageError{err.Error()}
	}
	if *digest != "" {
		if ref.digest != "" && ref.digest != *digest {
			return usagef("--image names %s but --digest is %s", ref.digest, *digest)
		}
		if _, _, err := splitDigest(*digest); err != nil {
			return usageError{err.Error()}
		}
		ref.digest = *digest
	}
	want, err := parsePlatform(*platform)
	if err != nil {
		return usageError{err.Error()}
	}
	reg, err := newRegistry(ctx, ref, *authfile, false, *retries, stderr)
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "oci pull: %s for %s\n", ref, want)
	return pull(ctx, reg, ref, want, Layout{*output}, stderr)
}

// pull copies one platform's image into out, tagged latest. A Docker
// schema 2 manifest is rewritten with the equivalent OCI media types, as
// skopeo does when it writes an OCI layout; an OCI manifest is kept byte
// for byte, so its digest stays the registry's.
func pull(ctx context.Context, reg *registry, ref reference, want Platform, out Layout, log io.Writer) error {
	tagOrDigest := ref.digest
	if tagOrDigest == "" {
		tagOrDigest = ref.tag
	}
	if tagOrDigest == "" {
		tagOrDigest = "latest"
	}
	data, mediaType, err := reg.getManifest(ctx, tagOrDigest)
	if err != nil {
		return err
	}
	if isIndexType(mediaType) {
		var index Index
		if err := decodeJSON(data, &index); err != nil {
			return fmt.Errorf("index %s: %w", tagOrDigest, err)
		}
		desc, err := choosePlatform(index.Manifests, want)
		if err != nil {
			return fmt.Errorf("%s: %w", ref, err)
		}
		fmt.Fprintf(log, "oci pull: %s is %s\n", want, desc.Digest)
		if data, mediaType, err = reg.getManifest(ctx, desc.Digest); err != nil {
			return err
		}
	}
	if !isManifestType(mediaType) {
		return fmt.Errorf("%s: unsupported manifest type %q", ref, mediaType)
	}
	var manifest Manifest
	if err := decodeJSON(data, &manifest); err != nil {
		return fmt.Errorf("manifest: %w", err)
	}

	if err := out.Create(); err != nil {
		return err
	}
	if err := reg.fetchBlob(ctx, out, manifest.Config); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if err := checkPlatform(out, manifest.Config, want, log); err != nil {
		return err
	}
	for i, layer := range manifest.Layers {
		fmt.Fprintf(log, "oci pull: layer %d/%d, %s (%d bytes)\n", i+1, len(manifest.Layers), layer.Digest, layer.Size)
		if err := reg.fetchBlob(ctx, out, layer); err != nil {
			return fmt.Errorf("layer %s: %w", layer.Digest, err)
		}
	}

	if mediaType == mediaTypeDockerManifest {
		manifest.MediaType = mediaTypeManifest
		manifest.Config.MediaType = ociMediaType(manifest.Config.MediaType)
		for i := range manifest.Layers {
			manifest.Layers[i].MediaType = ociMediaType(manifest.Layers[i].MediaType)
		}
		data = marshal(manifest)
	}
	desc, err := out.WriteBlob(mediaTypeManifest, data)
	if err != nil {
		return err
	}
	desc.Annotations = map[string]string{annotationRefName: "latest"}
	if err := out.WriteIndex(&Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: []Descriptor{desc}}); err != nil {
		return err
	}
	fmt.Fprintf(log, "oci pull: wrote %s (%s)\n", out.Dir, desc.Digest)
	return nil
}

// choosePlatform picks the first manifest for want's OS and architecture.
// A variant must match when want has one; arm64's only variant, v8, is
// also what an entry without one means.
func choosePlatform(manifests []Descriptor, want Platform) (Descriptor, error) {
	variant := func(p Platform) string {
		if p.Architecture == "arm64" && p.Variant == "" {
			return "v8"
		}
		return p.Variant
	}
	var seen []string
	for _, desc := range manifests {
		if desc.Platform == nil {
			continue
		}
		p := *desc.Platform
		seen = append(seen, p.String())
		if p.OS == want.OS && p.Architecture == want.Architecture &&
			(want.Variant == "" || variant(p) == variant(want)) {
			return desc, nil
		}
	}
	return Descriptor{}, fmt.Errorf("no image for %s; the index has %v", want, seen)
}

// checkPlatform warns when a single-platform image's config is for some
// other platform than the one asked for, which skopeo allowed too.
func checkPlatform(out Layout, config Descriptor, want Platform, log io.Writer) error {
	data, err := out.ReadBlob(config)
	if err != nil {
		return err
	}
	var c struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
	}
	if err := decodeJSON(data, &c); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if c.OS != want.OS || c.Architecture != want.Architecture {
		fmt.Fprintf(log, "oci pull: warning: the image is for %s/%s, not %s\n", c.OS, c.Architecture, want)
	}
	return nil
}
