// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readAllFrom(t *testing.T, reader io.ReadCloser) string {
	t.Helper()
	defer func() { _ = reader.Close() }()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func storeString(t *testing.T, store blobStore, key, value string) {
	t.Helper()
	if err := store.put(context.Background(), key, strings.NewReader(value), int64(len(value))); err != nil {
		t.Fatal(err)
	}
}

func TestDirStoreRoundTripsAndReportsMisses(t *testing.T) {
	store, err := newDirStore(filepath.Join(t.TempDir(), "cache"), 0)
	if err != nil {
		t.Fatal(err)
	}

	// A cold cache is a miss rather than an error: the root does not exist yet.
	if _, err := store.get(context.Background(), "a/b/c.json.gz"); !errors.Is(err, errCacheMiss) {
		t.Fatalf("cold get error = %v, want a miss", err)
	}

	storeString(t, store, "a/b/c.json.gz", "payload")
	reader, err := store.get(context.Background(), "a/b/c.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	if got := readAllFrom(t, reader); got != "payload" {
		t.Fatalf("round trip = %q, want %q", got, "payload")
	}
	if _, err := store.get(context.Background(), "a/b/absent.json.gz"); !errors.Is(err, errCacheMiss) {
		t.Fatalf("absent get error = %v, want a miss", err)
	}

	// Overwriting is how a re-run refreshes an object it already stored.
	storeString(t, store, "a/b/c.json.gz", "replacement")
	reader, err = store.get(context.Background(), "a/b/c.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	if got := readAllFrom(t, reader); got != "replacement" {
		t.Fatalf("overwritten round trip = %q, want %q", got, "replacement")
	}
}

// A partially written object must never be readable as a whole one: a reader
// which decoded a truncated document would report a corrupt snapshot rather
// than a miss, which reads as a fault instead of as a cold cache.
func TestDirStoreLeavesNoPartialObjects(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	store, err := newDirStore(root, 0)
	if err != nil {
		t.Fatal(err)
	}
	storeString(t, store, "id/commit.json.gz", "original")

	failing := io.MultiReader(strings.NewReader("partial"), errorReader{})
	if err := store.put(context.Background(), "id/commit.json.gz", failing, 0); err == nil {
		t.Fatal("a failing body was stored successfully")
	}

	reader, err := store.get(context.Background(), "id/commit.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	if got := readAllFrom(t, reader); got != "original" {
		t.Fatalf("after a failed write the object read %q, want the previous %q", got, "original")
	}
	entries, err := os.ReadDir(filepath.Join(root, "id"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("%d entries left behind, want just the object: %v", len(entries), entries)
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New("body exploded") }

// A cache directory has no lifecycle service behind it, so it prunes itself.
// Under --cache-write every run stores a head snapshot keyed by a working-copy
// commit that no later run asks for, and unpruned that grows without bound.
func TestDirStorePrunesPastItsMaxAge(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	store, err := newDirStore(root, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	storeString(t, store, "old-identity/stale.json.gz", "stale")
	storeString(t, store, "identity/fresh.json.gz", "fresh")

	stale := filepath.Join(root, "old-identity", "stale.json.gz")
	aged := time.Now().Add(-24 * time.Hour)
	if err := os.Chtimes(stale, aged, aged); err != nil {
		t.Fatal(err)
	}

	// Pruning happens on write, and reaches the whole tree rather than only
	// the directory written, so an identity retired wholesale is collected.
	storeString(t, store, "identity/second.json.gz", "second")

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale object survived pruning: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old-identity")); !os.IsNotExist(err) {
		t.Fatalf("emptied identity directory survived pruning: %v", err)
	}
	for _, key := range []string{"identity/fresh.json.gz", "identity/second.json.gz"} {
		if _, err := store.get(context.Background(), key); err != nil {
			t.Fatalf("fresh object %s was pruned: %v", key, err)
		}
	}
}

func TestDirStoreDoesNotPruneWithoutAMaxAge(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	store, err := newDirStore(root, 0)
	if err != nil {
		t.Fatal(err)
	}
	storeString(t, store, "identity/ancient.json.gz", "ancient")
	ancient := filepath.Join(root, "identity", "ancient.json.gz")
	aged := time.Now().Add(-10000 * time.Hour)
	if err := os.Chtimes(ancient, aged, aged); err != nil {
		t.Fatal(err)
	}
	storeString(t, store, "identity/new.json.gz", "new")
	if _, err := os.Stat(ancient); err != nil {
		t.Fatalf("object pruned with pruning disabled: %v", err)
	}
}

// A directory backend turns keys into paths, so a key which could address
// anything outside the namespace is refused rather than joined.
func TestCacheKeysCannotEscapeTheirNamespace(t *testing.T) {
	for _, key := range []string{
		"",
		"/absolute/key",
		"../escape",
		"identity/../../escape",
		"identity/./key",
		"identity//key",
		`identity\key`,
	} {
		if err := validateCacheKey(key); err == nil {
			t.Errorf("key %q was accepted", key)
		}
	}
	if err := validateCacheKey("tdutil/v2-2/abcdef0123456789/deadbeef.json.gz"); err != nil {
		t.Errorf("derived key rejected: %v", err)
	}
}

func TestOpenBlobStoreDispatchesOnScheme(t *testing.T) {
	directory := t.TempDir()
	store, err := openBlobStore(directory, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if store.String() != directory {
		t.Fatalf("directory store described as %q, want %q", store.String(), directory)
	}

	// A misconfigured location is fatal rather than a warning: it is a
	// deterministic property of the caller's own configuration which cannot
	// heal on a retry, and warning would leave a cache that never works.
	for _, location := range []string{"gs://bucket/prefix", "https://example.com/x", "file:///tmp/cache"} {
		if _, err := openBlobStore(location, time.Hour); err == nil {
			t.Errorf("location %q was accepted", location)
		}
	}
}
