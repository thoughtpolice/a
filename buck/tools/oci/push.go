// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// An oci_push target runs this through `buck2 run`:
//
//	buck2 run //pkg:app-push -- ttl.sh/me-app:1h
//	buck2 run //pkg:app-push -- ghcr.io/me/app:v1 ghcr.io/me/app:latest
//	buck2 run //pkg:app-push -- --tag v1     # when the target sets repository
//
// A destination is an image reference with a tag. A bare reference, or one
// with docker://, goes to a registry; oci:PATH[:TAG] and
// docker-archive:PATH:NAME[:TAG] write a layout or an archive instead. For
// each destination the pushed image is printed on stdout once the push
// succeeds, by digest for a registry. Progress goes to stderr.
func runPush(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("push", "[--tag TAG]... [REF]...", stderr)
	image := flags.String("image", "", "image layout to push (set by the target)")
	repository := flags.String("repository", "", "repository that --tag pushes to (set by the target)")
	var defaultTags, tags listFlag
	flags.Var(&defaultTags, "default-tag", "tag pushed when no destination is named (set by the target)")
	flags.Var(&tags, "tag", "push to REPOSITORY:TAG, using the target's repository (repeatable)")
	authfile := flags.String("authfile", "", "registry credentials file")
	retries := flags.Int("retry-times", 3, "retries for each failed registry request")
	dryRun := flags.Bool("dry-run", false, "print what would be pushed instead of pushing it")

	// Flags and destinations may come in any order.
	var refs []string
	for rest := args; ; {
		if err := parseFlags(flags, rest); err != nil {
			return err
		}
		if flags.NArg() == 0 {
			break
		}
		refs = append(refs, flags.Arg(0))
		rest = flags.Args()[1:]
	}
	if err := required(flags, "image"); err != nil {
		return err
	}
	if len(tags) == 0 && len(refs) == 0 {
		tags = defaultTags
	}
	if len(tags) > 0 && *repository == "" {
		return usagef("--tag needs a repository, which this target doesn't set")
	}
	for _, tag := range tags {
		refs = append(refs, *repository+":"+tag)
	}
	if len(refs) == 0 {
		return usagef("name a destination, such as ttl.sh/$USER-image:1h")
	}
	var dests []destination
	for _, ref := range refs {
		d, err := parseDestination(ref)
		if err != nil {
			return usageError{err.Error()}
		}
		dests = append(dests, d)
	}

	staged, err := stage(Layout{*image})
	if err != nil {
		return err
	}
	defer staged.Close()

	var results []string
	for _, d := range dests {
		if *dryRun {
			fmt.Fprintf(stderr, "oci push: would push %s (%s) to %s\n", staged.top.Digest, staged.top.MediaType, d)
			continue
		}
		fmt.Fprintf(stderr, "oci push: pushing %s to %s\n", staged.top.Digest, d)
		var err error
		switch d.kind {
		case "registry":
			err = pushRegistry(ctx, staged, d.ref, *authfile, *retries, stderr)
		case "oci":
			err = pushLayout(staged, Layout{d.path}, d.tag)
		case "docker-archive":
			err = pushArchive(staged, d.path, d.tag)
		}
		if err != nil {
			return fmt.Errorf("pushing to %s: %w", d, err)
		}
		results = append(results, d.pinned(staged.top.Digest))
	}
	for _, line := range results {
		fmt.Fprintln(stdout, line)
	}
	return nil
}

// destination is where one push goes.
type destination struct {
	kind string // registry, oci or docker-archive
	ref  reference
	path string // a layout or archive, or a registry repository as written
	tag  string // a layout's tag, or an archive's NAME:TAG
	raw  string
}

func (d destination) String() string { return d.raw }

// pinned is the line printed for a finished push: the registry reference
// by digest, or the destination and the digest for anything else.
func (d destination) pinned(digest string) string {
	if d.kind != "registry" {
		return d.raw + " " + digest
	}
	return d.path + "@" + digest
}

func parseDestination(raw string) (destination, error) {
	d := destination{raw: raw}
	switch {
	case strings.HasPrefix(raw, "oci:"):
		d.kind = "oci"
		d.path, d.tag = raw[len("oci:"):], ""
		if i := strings.LastIndex(d.path, ":"); i >= 0 {
			d.path, d.tag = d.path[:i], d.path[i+1:]
		}
		if d.path == "" {
			return d, fmt.Errorf("%s: name a directory", raw)
		}
		return d, nil
	case strings.HasPrefix(raw, "docker-archive:"):
		d.kind = "docker-archive"
		path, name, ok := strings.Cut(raw[len("docker-archive:"):], ":")
		if !ok || path == "" || name == "" {
			return d, fmt.Errorf("%s: write docker-archive:PATH:NAME[:TAG]", raw)
		}
		d.path, d.tag = path, name
		return d, nil
	}
	for _, transport := range []string{"containers-storage:", "dir:", "docker-daemon:", "oci-archive:"} {
		if strings.HasPrefix(raw, transport) {
			return d, fmt.Errorf("%s: the %s transport is not supported; push to a registry, oci: or docker-archive:", raw, strings.TrimSuffix(transport, ":"))
		}
	}
	name := strings.TrimPrefix(raw, "docker://")
	ref, err := parseReference(name)
	if err != nil {
		return d, err
	}
	if ref.digest != "" {
		return d, fmt.Errorf("%s: push to a tag, not a digest. The digest is printed after the push.", raw)
	}
	if ref.tag == "" {
		return d, fmt.Errorf("%s: name a tag, such as %s:v1. Pushing an implicit :latest is easy to miss, and registries and exe.dev cache it.", raw, name)
	}
	// The result is printed with the repository spelled the way it was
	// written, so ttl.sh/me stays ttl.sh/me and alpine stays alpine.
	d.ref, d.path = ref, strings.TrimSuffix(name, ":"+ref.tag)
	d.kind = "registry"
	return d, nil
}

// staged is a layout's image opened for a push: the manifests in memory and
// every blob held open, so a rebuild that replaces the layout's files while
// the push runs can't change what gets pushed.
type staged struct {
	top       Descriptor
	manifests map[string][]byte   // digest -> manifest or index
	blobs     map[string]*os.File // digest -> config or layer
}

func (s *staged) Close() {
	for _, f := range s.blobs {
		f.Close()
	}
}

// stage opens the image a layout names. A layout that lists one manifest
// per platform, as oci_index writes, becomes a single image index, so it
// is pushed as one multi-platform image.
func stage(layout Layout) (*staged, error) {
	index, err := layout.ReadIndex()
	if err != nil {
		return nil, err
	}
	if len(index.Manifests) == 0 {
		return nil, fmt.Errorf("%s/index.json lists no manifests", layout.Dir)
	}
	s := &staged{manifests: map[string][]byte{}, blobs: map[string]*os.File{}}
	var add func(desc Descriptor) error
	add = func(desc Descriptor) error {
		if _, ok := s.manifests[desc.Digest]; ok {
			return nil
		}
		data, err := layout.ReadBlob(desc)
		if err != nil {
			return err
		}
		s.manifests[desc.Digest] = data
		if isIndexType(desc.MediaType) {
			var index Index
			if err := decodeJSON(data, &index); err != nil {
				return fmt.Errorf("index %s: %w", desc.Digest, err)
			}
			for _, child := range index.Manifests {
				if err := add(child); err != nil {
					return err
				}
			}
			return nil
		}
		var m Manifest
		if err := decodeJSON(data, &m); err != nil {
			return fmt.Errorf("manifest %s: %w", desc.Digest, err)
		}
		for _, blob := range append([]Descriptor{m.Config}, m.Layers...) {
			if _, ok := s.blobs[blob.Digest]; ok {
				continue
			}
			path, err := layout.blobPath(blob.Digest)
			if err != nil {
				return err
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			s.blobs[blob.Digest] = f
		}
		return nil
	}
	if len(index.Manifests) == 1 {
		s.top = index.Manifests[0]
		s.top.Annotations = nil
	} else {
		data := marshal(Index{SchemaVersion: 2, MediaType: mediaTypeIndex, Manifests: index.Manifests})
		s.top = Descriptor{MediaType: mediaTypeIndex, Digest: sha256Digest(data), Size: int64(len(data))}
		s.manifests[s.top.Digest] = data
		for _, desc := range index.Manifests {
			if err := add(desc); err != nil {
				s.Close()
				return nil, err
			}
		}
		return s, nil
	}
	if err := add(s.top); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// children lists the manifests an index names, or nothing for a manifest.
func (s *staged) children(desc Descriptor) []Descriptor {
	if !isIndexType(desc.MediaType) {
		return nil
	}
	var index Index
	decodeJSON(s.manifests[desc.Digest], &index)
	return index.Manifests
}

func (s *staged) blobsOf(desc Descriptor) []Descriptor {
	var m Manifest
	decodeJSON(s.manifests[desc.Digest], &m)
	return append([]Descriptor{m.Config}, m.Layers...)
}

// open returns a reader over a staged blob from its start, which fails if
// the content does not match the digest.
func (s *staged) open(desc Descriptor) (io.ReadCloser, error) {
	f, ok := s.blobs[desc.Digest]
	if !ok {
		return nil, fmt.Errorf("blob %s is not staged", desc.Digest)
	}
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	return io.NopCloser(&verifyingReader{
		r:      io.NewSectionReader(f, 0, info.Size()),
		h:      sha256.New(),
		digest: desc.Digest,
	}), nil
}

type verifyingReader struct {
	r      io.Reader
	h      hash.Hash
	digest string
}

func (v *verifyingReader) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	v.h.Write(p[:n])
	if err == io.EOF {
		if got := "sha256:" + hex.EncodeToString(v.h.Sum(nil)); got != v.digest {
			return n, fmt.Errorf("%w: blob %s now has digest %s", errDigestMismatch, v.digest, got)
		}
	}
	return n, err
}

func pushRegistry(ctx context.Context, s *staged, ref reference, authfile string, retries int, log io.Writer) error {
	reg, err := newRegistry(ctx, ref, authfile, true, retries, log)
	if err != nil {
		return err
	}
	var pushManifest func(desc Descriptor, tag string) error
	pushManifest = func(desc Descriptor, tag string) error {
		for _, child := range s.children(desc) {
			if err := pushManifest(child, child.Digest); err != nil {
				return err
			}
		}
		if !isIndexType(desc.MediaType) {
			for _, blob := range s.blobsOf(desc) {
				exists, err := reg.blobExists(ctx, blob.Digest)
				if err != nil {
					return err
				}
				if exists {
					fmt.Fprintf(log, "oci push: %s already exists\n", blob.Digest)
					continue
				}
				fmt.Fprintf(log, "oci push: uploading %s (%d bytes)\n", blob.Digest, blob.Size)
				if err := reg.uploadBlob(ctx, blob.Digest, blob.Size, func() (io.ReadCloser, error) { return s.open(blob) }); err != nil {
					return err
				}
			}
		}
		return reg.putManifest(ctx, tag, desc.MediaType, s.manifests[desc.Digest])
	}
	return pushManifest(s.top, ref.tag)
}

// pushLayout writes the image into a layout, which may already hold other
// images, and tags it, replacing whatever had the tag before.
func pushLayout(s *staged, out Layout, tag string) error {
	if err := out.Create(); err != nil {
		return err
	}
	for digest, data := range s.manifests {
		path, err := out.blobPath(digest)
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
	}
	for digest := range s.blobs {
		if err := copyStaged(s, Descriptor{Digest: digest}, out); err != nil {
			return err
		}
	}
	index := &Index{SchemaVersion: 2, MediaType: mediaTypeIndex}
	if existing, err := out.ReadIndex(); err == nil {
		index = existing
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	top := s.top
	var kept []Descriptor
	for _, desc := range index.Manifests {
		if tag == "" || desc.Annotations[annotationRefName] != tag {
			kept = append(kept, desc)
		}
	}
	if tag != "" {
		top.Annotations = map[string]string{annotationRefName: tag}
	}
	index.Manifests = append(kept, top)
	return out.WriteIndex(index)
}

func copyStaged(s *staged, desc Descriptor, out Layout) error {
	dest, err := out.blobPath(desc.Digest)
	if err != nil {
		return err
	}
	r, err := s.open(desc)
	if err != nil {
		return err
	}
	defer r.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".push-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dest)
}

// pushArchive writes a single-platform image as a docker load archive.
func pushArchive(s *staged, path, repoTag string) error {
	if isIndexType(s.top.MediaType) {
		return errors.New("a docker archive holds one platform's image, not a multi-platform index")
	}
	dir, err := os.MkdirTemp("", "oci-push-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	tmp := Layout{dir}
	if err := pushLayout(s, tmp, "latest"); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	if err := writeArchive(w, tmp, "latest", repoTag); err != nil {
		return err
	}
	if err := w.Flush(); err != nil {
		return err
	}
	return f.Close()
}
