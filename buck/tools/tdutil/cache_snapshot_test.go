// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const cacheTestCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func testSnapshotCache(t *testing.T, write bool) (*snapshotCache, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "cache")
	store, err := newDirStore(root, 0)
	if err != nil {
		t.Fatal(err)
	}
	return &snapshotCache{
		store:    store,
		identity: identityOf("buck2 test", []string{"depot//..."}, nil, ""),
		write:    write,
		timeout:  10 * time.Second,
		tempDir:  t.TempDir(),
	}, root
}

func cacheTestArgs(cache *snapshotCache) cliArgs {
	location := "unused"
	return cliArgs{cache: &location, cacheWrite: cache.write, buck: "buck2", universe: []string{"depot//..."}}
}

func TestSnapshotCacheRoundTripsADocument(t *testing.T) {
	cache, _ := testSnapshotCache(t, true)
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer

	if _, err := cache.fetch(context.Background(), cacheTestCommit); !errors.Is(err, errCacheMiss) {
		t.Fatalf("cold fetch error = %v, want a miss", err)
	}

	cache.storeSnapshot(context.Background(), &args, "base", cacheTestCommit, true, &collected, &stderr)
	if stderr.Len() != 0 {
		t.Fatalf("storing reported %q", stderr.String())
	}

	document, err := cache.fetch(context.Background(), cacheTestCommit)
	if err != nil {
		t.Fatalf("stored document could not be fetched: %v", err)
	}
	if document.Commit != cacheTestCommit {
		t.Fatalf("fetched commit = %q", document.Commit)
	}
	restored, err := document.toSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.targets) != len(collected.targets) {
		t.Fatalf("%d targets survived, want %d", len(restored.targets), len(collected.targets))
	}
}

// Reads are automatic and writes are opt-in, because a write from a local
// working copy stores a graph keyed by a commit nobody will ever request.
func TestSnapshotCacheDoesNotWriteWithoutOptIn(t *testing.T) {
	cache, root := testSnapshotCache(t, false)
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer

	cache.storeSnapshot(context.Background(), &args, "head", cacheTestCommit, true, &collected, &stderr)
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("a read-only cache created storage: %v", err)
	}

	// A nil cache is the no-cache case and must be equally inert.
	var absent *snapshotCache
	absent.storeSnapshot(context.Background(), &args, "head", cacheTestCommit, true, &collected, &stderr)
	if stderr.Len() != 0 {
		t.Fatalf("an absent cache reported %q", stderr.String())
	}
}

// A reader treats a document's universe as proof that capture queried all of
// it, so a graph collected over fewer patterns is declined rather than stored.
func TestSnapshotCacheDeclinesAPartialUniverse(t *testing.T) {
	cache, _ := testSnapshotCache(t, true)
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer

	cache.storeSnapshot(context.Background(), &args, "base", cacheTestCommit, false, &collected, &stderr)
	if !strings.Contains(stderr.String(), "universe pattern") {
		t.Fatalf("decline reason = %q", stderr.String())
	}
	if _, err := cache.fetch(context.Background(), cacheTestCommit); !errors.Is(err, errCacheMiss) {
		t.Fatalf("a partial graph was stored: %v", err)
	}
}

type failingStore struct{ err error }

func (store failingStore) get(context.Context, string) (io.ReadCloser, error) { return nil, store.err }
func (store failingStore) put(context.Context, string, stagedBlob) error      { return store.err }
func (store failingStore) String() string                                     { return "failing://store" }

// The determined targets are the run's deliverable and a snapshot is only a
// cache, so a write that cannot happen is reported and the run continues.
func TestSnapshotCacheWriteFailureIsReportedNotFatal(t *testing.T) {
	cache, _ := testSnapshotCache(t, true)
	cache.store = failingStore{err: errors.New("bucket is on fire")}
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer

	cache.storeSnapshot(context.Background(), &args, "head", cacheTestCommit, true, &collected, &stderr)
	if !strings.Contains(stderr.String(), "bucket is on fire") {
		t.Fatalf("write failure reported as %q", stderr.String())
	}
}

// A document is keyed by an identity, but the key proving what the document
// contains is a property worth checking rather than assuming.
func TestSnapshotCacheRevalidatesWhatItFetched(t *testing.T) {
	cache, _ := testSnapshotCache(t, true)
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer
	cache.storeSnapshot(context.Background(), &args, "base", cacheTestCommit, true, &collected, &stderr)

	// Same key, different buck2: the object is where this identity looks, but
	// it no longer describes the graph this run would collect.
	drifted := *cache
	drifted.identity.buckVersion = "buck2 different"
	object := filepath.Join(cache.store.(*dirStore).root, snapshotCacheKey(cache.identity, cacheTestCommit))
	moved := filepath.Join(cache.store.(*dirStore).root, snapshotCacheKey(drifted.identity, cacheTestCommit))
	if err := os.MkdirAll(filepath.Dir(moved), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(object, moved); err != nil {
		t.Fatal(err)
	}

	if _, err := drifted.fetch(context.Background(), cacheTestCommit); err == nil {
		t.Fatal("a document which does not match its identity was accepted")
	} else if !strings.Contains(err.Error(), "buck2") {
		t.Fatalf("rejection reason = %v", err)
	}
}

// The local file is free and the cache is not, so the file is tried first and
// a hit there means the cache is never consulted.
func TestObtainBaseDocumentPrefersTheLocalFile(t *testing.T) {
	cache, _ := testSnapshotCache(t, true)
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer

	path := filepath.Join(t.TempDir(), "base.json")
	document := buildSnapshotDocumentFor(cache.identity, cacheTestCommit, &collected)
	if err := writeSnapshotDocument(path, document); err != nil {
		t.Fatal(err)
	}
	args.baseSnapshot = &path
	cache.store = failingStore{err: errors.New("the cache must not be consulted")}

	got := obtainBaseDocument(context.Background(), nil, &args, cache, t.TempDir(), cacheTestCommit, &stderr)
	if got == nil {
		t.Fatalf("the local file was not used: %s", stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("a clean local hit reported %q", stderr.String())
	}
}

// A file which cannot stand in falls through to the cache rather than ending
// the attempt, so a stale local copy costs nothing.
func TestObtainBaseDocumentFallsThroughToTheCache(t *testing.T) {
	cache, _ := testSnapshotCache(t, true)
	collected := snapshotTestGraph(t)
	args := cacheTestArgs(cache)
	var stderr bytes.Buffer
	cache.storeSnapshot(context.Background(), &args, "base", cacheTestCommit, true, &collected, &stderr)
	stderr.Reset()

	absent := filepath.Join(t.TempDir(), "absent.json")
	args.baseSnapshot = &absent

	got := obtainBaseDocument(context.Background(), nil, &args, cache, t.TempDir(), cacheTestCommit, &stderr)
	if got == nil {
		t.Fatalf("the cache was not consulted after the file missed: %s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "no snapshot file present") {
		t.Fatalf("the file miss was not reported: %q", stderr.String())
	}
}

// A cold cache is the ordinary first run rather than a fault, so it stays
// quiet unless asked; a backend which will not answer is reported either way.
func TestObtainBaseDocumentReportsFaultsButNotColdMisses(t *testing.T) {
	cache, _ := testSnapshotCache(t, false)
	args := cacheTestArgs(cache)

	var quiet bytes.Buffer
	if got := obtainBaseDocument(context.Background(), nil, &args, cache, t.TempDir(), cacheTestCommit, &quiet); got != nil {
		t.Fatal("a cold cache produced a document")
	}
	if quiet.Len() != 0 {
		t.Fatalf("a cold miss reported %q at default verbosity", quiet.String())
	}

	verbose := args
	verbose.verbose = true
	var loud bytes.Buffer
	obtainBaseDocument(context.Background(), nil, &verbose, cache, t.TempDir(), cacheTestCommit, &loud)
	if !strings.Contains(loud.String(), "cache miss") {
		t.Fatalf("--verbose did not explain the miss: %q", loud.String())
	}

	broken, _ := testSnapshotCache(t, false)
	broken.store = failingStore{err: errors.New("bucket is on fire")}
	var reported bytes.Buffer
	if got := obtainBaseDocument(context.Background(), nil, &args, broken, t.TempDir(), cacheTestCommit, &reported); got != nil {
		t.Fatal("a broken backend produced a document")
	}
	if !strings.Contains(reported.String(), "bucket is on fire") {
		t.Fatalf("a backend fault was not reported: %q", reported.String())
	}
}
