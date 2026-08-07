// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// errCacheMiss reports that a backend answered honestly and the object is not
// there. Every other error means the backend could not answer at all, and the
// two are kept apart because a miss is the ordinary cold-cache case while
// anything else deserves the operator's attention.
var errCacheMiss = errors.New("cache miss")

// blobStore is the whole of what a snapshot cache backend must do: fetch an
// object by key, and store one. Nothing here knows what a snapshot is, so a
// backend can be tested against bytes alone, and the key derivation which does
// know is shared by every backend rather than reimplemented per backend.
//
// Deletion is deliberately absent. Retention belongs to whoever owns the
// storage — an object lifecycle rule for a bucket, and age pruning for a local
// directory, which has no such service behind it. A backend which cannot
// delete cannot destroy anything an operator did not ask it to.
type blobStore interface {
	get(ctx context.Context, key string) (io.ReadCloser, error)
	put(ctx context.Context, key string, body io.Reader, size int64) error
	String() string
}

// openBlobStore resolves a --cache location. A value containing `://` is a URL
// and dispatches on its scheme; anything else is a local directory, so the
// common local case is spelled `--cache ~/.cache/tdutil` rather than made to
// carry a `file://` ceremony.
//
// Every failure here is fatal to the run rather than a warning. These are
// deterministic properties of the caller's own configuration — a
// misspelled scheme, absent credentials — which cannot heal on a retry, and
// warning would leave a cache that silently never works and a run that
// silently pays full collection forever.
func openBlobStore(location string, maxAge time.Duration) (blobStore, error) {
	if !strings.Contains(location, "://") {
		return newDirStore(location, maxAge)
	}
	scheme, _, _ := strings.Cut(location, "://")
	switch scheme {
	case "file":
		return nil, fmt.Errorf(
			"cache location `%s`: spell a local directory as a plain path, not a file:// URL",
			location,
		)
	default:
		return nil, fmt.Errorf("cache location `%s`: unsupported scheme `%s` (expected a local directory)", location, scheme)
	}
}

// validateCacheKey rejects a key which could address anything outside the
// namespace it was given. Keys are derived by tdutil rather than supplied, so
// this cannot fire today; it is here because a directory backend turns keys
// into paths, and that is exactly the sort of thing which stops being true
// quietly.
func validateCacheKey(key string) error {
	if key == "" {
		return fmt.Errorf("empty cache key")
	}
	if strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return fmt.Errorf("malformed cache key %q", key)
	}
	for _, element := range strings.Split(key, "/") {
		if element == "" || element == "." || element == ".." {
			return fmt.Errorf("malformed cache key %q", key)
		}
	}
	return nil
}

// dirStore keeps snapshots in a local directory. It is the backend for
// repeated local runs, where the base revision is stable across runs and the
// cache turns every run after the first into a head-only collection, and it is
// the substrate the other backends' tests run against.
type dirStore struct {
	root   string
	maxAge time.Duration
}

func newDirStore(root string, maxAge time.Duration) (blobStore, error) {
	if root == "" {
		return nil, fmt.Errorf("cache directory is empty")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolving cache directory `%s`: %w", root, err)
	}
	return &dirStore{root: absolute, maxAge: maxAge}, nil
}

func (store *dirStore) String() string { return store.root }

func (store *dirStore) path(key string) (string, error) {
	if err := validateCacheKey(key); err != nil {
		return "", err
	}
	return filepath.Join(store.root, filepath.FromSlash(key)), nil
}

func (store *dirStore) get(_ context.Context, key string) (io.ReadCloser, error) {
	path, err := store.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errCacheMiss
		}
		return nil, err
	}
	return file, nil
}

func (store *dirStore) put(_ context.Context, key string, body io.Reader, _ int64) error {
	path, err := store.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	err = writeFileAtomically(path, 0o644, func(output io.Writer) error {
		_, copyErr := io.Copy(output, body)
		return copyErr
	})
	if err != nil {
		return err
	}
	store.prune()
	return nil
}

// prune drops objects past their age. A bucket has lifecycle rules for this; a
// cache directory has nothing, and left alone it grows without bound, because
// under --cache-write every run stores a head snapshot keyed by a working-copy
// commit which changes on every jj snapshot and which no later run will ever
// ask for.
//
// The whole tree is walked rather than just the directory written, so that
// entries orphaned wholesale — every key under an identity which a buck2
// upgrade or a configuration change has retired — are collected too. That
// tree holds a handful of objects per identity, so walking it on each write
// costs nothing worth measuring.
//
// Failures are ignored throughout. This is opportunistic housekeeping on a
// cache, and a run must not fail over it.
func (store *dirStore) prune() {
	if store.maxAge <= 0 {
		return
	}
	cutoff := time.Now().Add(-store.maxAge)
	var directories []string
	_ = filepath.WalkDir(store.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path != store.root {
				directories = append(directories, path)
			}
			return nil
		}
		if info, err := entry.Info(); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(path)
		}
		return nil
	})
	// Deepest first, so a directory whose children were just removed is itself
	// empty by the time it is reached. Remove refuses a non-empty directory,
	// which is what keeps this from taking anything still in use.
	sort.Strings(directories)
	for index := len(directories) - 1; index >= 0; index-- {
		_ = os.Remove(directories[index])
	}
}
