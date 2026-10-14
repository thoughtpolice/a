// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"fmt"
	"io"
	"os"
	"strings"
)

// imageOptions are the configuration changes oci_image applies to its base.
// A nil slice or pointer leaves the base's value alone.
type imageOptions struct {
	layers       []string
	env          [][2]string
	labels       [][2]string
	entrypoint   []string
	cmd          []string
	workingDir   *string
	user         *string
	exposedPorts []string
	volumes      []string
	created      string
}

func runImage(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("image", "--base LAYOUT --output DIR [--layer TAR]... [config flags]", stderr)
	base := flags.String("base", "", "base image layout")
	output := flags.String("output", "", "output image layout")
	var layers, env, labels, ports, volumes listFlag
	flags.Var(&layers, "layer", "tar or gzipped tar to add as a layer (repeatable)")
	flags.Var(&env, "env", "KEY=VALUE environment variable, replacing the base's KEY (repeatable)")
	flags.Var(&labels, "label", "KEY=VALUE label, replacing the base's KEY (repeatable)")
	flags.Var(&ports, "exposed-port", "port to expose, such as 8080/tcp (repeatable)")
	flags.Var(&volumes, "volume", "volume mount point (repeatable)")
	entrypoint := flags.String("entrypoint", "", "entrypoint as a JSON array of strings")
	cmd := flags.String("cmd", "", "command as a JSON array of strings")
	workdir := flags.String("workdir", "", "working directory")
	user := flags.String("user", "", "user to run as")
	created := flags.String("created", "1970-01-01T00:00:00Z", "RFC 3339 creation time for the image and its new history entries")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "base", "output"); err != nil {
		return err
	}

	opts := imageOptions{
		layers:       layers,
		exposedPorts: ports,
		volumes:      volumes,
		created:      *created,
	}
	var err error
	if opts.env, err = keyValues("env", env); err != nil {
		return err
	}
	if opts.labels, err = keyValues("label", labels); err != nil {
		return err
	}
	if opts.entrypoint, err = jsonArgv("entrypoint", *entrypoint); err != nil {
		return err
	}
	if opts.cmd, err = jsonArgv("cmd", *cmd); err != nil {
		return err
	}
	if *workdir != "" {
		opts.workingDir = workdir
	}
	if *user != "" {
		opts.user = user
	}
	return buildImage(Layout{*base}, Layout{*output}, opts, stderr)
}

func jsonArgv(name, value string) ([]string, error) {
	if value == "" {
		return nil, nil
	}
	var argv []string
	if err := json.Unmarshal([]byte(value), &argv); err != nil {
		return nil, usagef("--%s must be a JSON array of strings: %v", name, err)
	}
	return argv, nil
}

func buildImage(base, out Layout, opts imageOptions, log io.Writer) error {
	baseDesc, err := base.Resolve("")
	if err != nil {
		return fmt.Errorf("base: %w", err)
	}
	baseManifest, baseConfig, err := base.Image(baseDesc)
	if err != nil {
		return fmt.Errorf("base: %w", err)
	}
	var config map[string]any
	if err := decodeJSON(baseConfig, &config); err != nil {
		return fmt.Errorf("base config: %w", err)
	}

	if err := out.Create(); err != nil {
		return err
	}
	fmt.Fprintf(log, "oci image: %d base layers, %d new\n", len(baseManifest.Layers), len(opts.layers))
	layers := make([]Descriptor, 0, len(baseManifest.Layers)+len(opts.layers))
	for _, layer := range baseManifest.Layers {
		if err := out.CopyBlob(base, layer.Digest); err != nil {
			return fmt.Errorf("copying base layer %s: %w", layer.Digest, err)
		}
		layer.MediaType = ociMediaType(layer.MediaType)
		layers = append(layers, layer)
	}

	var diffIDs []string
	for _, path := range opts.layers {
		desc, diffID, err := addLayer(out, path)
		if err != nil {
			return fmt.Errorf("layer %s: %w", path, err)
		}
		layers = append(layers, desc)
		diffIDs = append(diffIDs, diffID)
	}

	if err := applyConfig(config, diffIDs, opts); err != nil {
		return err
	}
	configDesc, err := out.WriteBlob(mediaTypeConfig, marshal(config))
	if err != nil {
		return err
	}
	manifest := Manifest{
		SchemaVersion: 2,
		MediaType:     mediaTypeManifest,
		Config:        configDesc,
		Layers:        layers,
	}
	manifestDesc, err := out.WriteBlob(mediaTypeManifest, marshal(manifest))
	if err != nil {
		return err
	}
	manifestDesc.Annotations = map[string]string{annotationRefName: "latest"}
	if err := out.WriteIndex(&Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: []Descriptor{manifestDesc}}); err != nil {
		return err
	}
	fmt.Fprintf(log, "oci image: wrote %s (%s)\n", out.Dir, manifestDesc.Digest)
	return nil
}

// addLayer stores a layer tar and returns its descriptor and diff ID, the
// digest of its uncompressed contents.
func addLayer(out Layout, path string) (Descriptor, string, error) {
	compression, err := sniffCompression(path)
	if err != nil {
		return Descriptor{}, "", err
	}
	mediaType := mediaTypeLayer
	switch compression {
	case "gzip":
		mediaType = mediaTypeLayerGzip
	case "zstd":
		return Descriptor{}, "", fmt.Errorf("zstd layers are not supported; use gzip or none")
	}
	digest, size, err := out.AddFile(path)
	if err != nil {
		return Descriptor{}, "", err
	}
	diffID := digest
	if compression == "gzip" {
		if diffID, err = gunzipDigest(path); err != nil {
			return Descriptor{}, "", err
		}
	}
	return Descriptor{MediaType: mediaType, Digest: digest, Size: size}, diffID, nil
}

// sniffCompression reports "gzip", "zstd" or "" from a file's magic number.
func sniffCompression(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	magic := make([]byte, 4)
	n, _ := io.ReadFull(f, magic)
	return compressionOf(magic[:n]), nil
}

func compressionOf(magic []byte) string {
	switch {
	case len(magic) >= 2 && magic[0] == 0x1f && magic[1] == 0x8b:
		return "gzip"
	case len(magic) >= 4 && magic[0] == 0x28 && magic[1] == 0xb5 && magic[2] == 0x2f && magic[3] == 0xfd:
		return "zstd"
	}
	return ""
}

func gunzipDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	zr, err := gzip.NewReader(bufio.NewReaderSize(f, 1<<20))
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(h, zr); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// object returns parent[key] as a JSON object, creating it if it is absent
// or null.
func object(parent map[string]any, key string) (map[string]any, error) {
	switch v := parent[key].(type) {
	case map[string]any:
		return v, nil
	case nil:
		m := map[string]any{}
		parent[key] = m
		return m, nil
	default:
		return nil, fmt.Errorf("base config's %q is a %T, not an object", key, v)
	}
}

// list returns parent[key] as a JSON array; absent and null are empty.
func list(parent map[string]any, key string) ([]any, error) {
	switch v := parent[key].(type) {
	case []any:
		return v, nil
	case nil:
		return nil, nil
	default:
		return nil, fmt.Errorf("base config's %q is a %T, not an array", key, v)
	}
}

func applyConfig(config map[string]any, diffIDs []string, opts imageOptions) error {
	rootfs, err := object(config, "rootfs")
	if err != nil {
		return err
	}
	if _, ok := rootfs["type"]; !ok {
		rootfs["type"] = "layers"
	}
	ids, err := list(rootfs, "diff_ids")
	if err != nil {
		return err
	}
	for _, id := range diffIDs {
		ids = append(ids, id)
	}
	rootfs["diff_ids"] = ids

	c, err := object(config, "config")
	if err != nil {
		return err
	}
	if opts.env != nil {
		existing, err := list(c, "Env")
		if err != nil {
			return err
		}
		// Merge by name. Base variables keep their places, and new ones
		// follow in the order given.
		var order []string
		values := map[string]string{}
		set := func(key, value string) {
			if _, ok := values[key]; !ok {
				order = append(order, key)
			}
			values[key] = value
		}
		for _, e := range existing {
			s, _ := e.(string)
			if key, value, ok := strings.Cut(s, "="); ok {
				set(key, value)
			}
		}
		for _, kv := range opts.env {
			set(kv[0], kv[1])
		}
		env := make([]any, 0, len(order))
		for _, key := range order {
			env = append(env, key+"="+values[key])
		}
		c["Env"] = env
	}
	if opts.entrypoint != nil {
		c["Entrypoint"] = opts.entrypoint
	}
	if opts.cmd != nil {
		c["Cmd"] = opts.cmd
	}
	if opts.workingDir != nil {
		c["WorkingDir"] = *opts.workingDir
	}
	if opts.user != nil {
		c["User"] = *opts.user
	}
	if len(opts.labels) > 0 {
		labels, err := object(c, "Labels")
		if err != nil {
			return err
		}
		for _, kv := range opts.labels {
			labels[kv[0]] = kv[1]
		}
	}
	for key, values := range map[string][]string{"ExposedPorts": opts.exposedPorts, "Volumes": opts.volumes} {
		if len(values) == 0 {
			continue
		}
		set, err := object(c, key)
		if err != nil {
			return err
		}
		for _, v := range values {
			set[v] = map[string]any{}
		}
	}

	config["created"] = opts.created
	history, err := list(config, "history")
	if err != nil {
		return err
	}
	for i := range diffIDs {
		history = append(history, map[string]any{
			"created":    opts.created,
			"created_by": fmt.Sprintf("buck2 oci_image (layer %d/%d)", i+1, len(diffIDs)),
		})
	}
	if history != nil {
		config["history"] = history
	}
	return nil
}
