// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
	"strings"
)

func runIndex(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("index", "--output DIR --image OS/ARCH[/VARIANT]=LAYOUT...", stderr)
	output := flags.String("output", "", "output layout")
	var images listFlag
	flags.Var(&images, "image", "PLATFORM=LAYOUT, a single-platform image and the platform it runs on (repeatable)")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "output"); err != nil {
		return err
	}
	if len(images) == 0 {
		return usagef("name at least one --image")
	}
	type entry struct {
		platform Platform
		layout   Layout
	}
	var entries []entry
	for _, image := range images {
		platform, path, ok := strings.Cut(image, "=")
		if !ok {
			return usagef("--image %q is not PLATFORM=LAYOUT", image)
		}
		p, err := parsePlatform(platform)
		if err != nil {
			return usageError{err.Error()}
		}
		entries = append(entries, entry{p, Layout{path}})
	}

	out := Layout{*output}
	if err := out.Create(); err != nil {
		return err
	}
	index := Index{SchemaVersion: 2, MediaType: mediaTypeIndex}
	for _, e := range entries {
		desc, err := addPlatformImage(out, e.layout, e.platform)
		if err != nil {
			return fmt.Errorf("%s: %w", e.layout.Dir, err)
		}
		index.Manifests = append(index.Manifests, desc)
		fmt.Fprintf(stderr, "oci index: %s is %s\n", e.platform, desc.Digest)
	}
	// One entry per platform, the way oci_push expects to find them.
	return out.WriteIndex(&index)
}

// addPlatformImage copies one image into out and returns its manifest
// descriptor, labeled with the platform, which its config has to agree with.
func addPlatformImage(out, src Layout, platform Platform) (Descriptor, error) {
	desc, err := src.Resolve("")
	if err != nil {
		return Descriptor{}, err
	}
	manifest, configData, err := src.Image(desc)
	if err != nil {
		return Descriptor{}, err
	}
	var config struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
	}
	if err := decodeJSON(configData, &config); err != nil {
		return Descriptor{}, fmt.Errorf("config: %w", err)
	}
	if config.OS != platform.OS || config.Architecture != platform.Architecture {
		return Descriptor{}, fmt.Errorf("image is for %s/%s, not %s", config.OS, config.Architecture, platform)
	}
	blobs := []string{desc.Digest, manifest.Config.Digest}
	for _, layer := range manifest.Layers {
		blobs = append(blobs, layer.Digest)
	}
	for _, digest := range blobs {
		if err := out.CopyBlob(src, digest); err != nil {
			return Descriptor{}, err
		}
	}
	return Descriptor{
		MediaType: desc.MediaType,
		Digest:    desc.Digest,
		Size:      desc.Size,
		Platform:  &platform,
	}, nil
}
