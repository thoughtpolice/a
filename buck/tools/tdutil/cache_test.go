// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
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

func stageString(t *testing.T, value string) stagedBlob {
	t.Helper()
	payload, cleanup, err := stageBlob(t.TempDir(), func(output io.Writer) error {
		_, writeErr := io.WriteString(output, value)
		return writeErr
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return payload
}

func storeString(t *testing.T, store blobStore, key, value string) {
	t.Helper()
	if err := store.put(context.Background(), key, stageString(t, value)); err != nil {
		t.Fatal(err)
	}
}

// Staging is one pass which must produce the bytes, their length, and their
// digest together: S3 signs the latter two into a request before the first
// byte goes out, and a retry rereads the file from the start.
func TestStageBlobMeasuresAndDigestsInOnePass(t *testing.T) {
	payload := stageString(t, "Welcome to Amazon S3.")
	if payload.size != 21 {
		t.Errorf("size = %d, want 21", payload.size)
	}
	// The digest AWS publishes for this exact body in its PUT example.
	const want = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
	if payload.sha256 != want {
		t.Errorf("sha256 = %s, want %s", payload.sha256, want)
	}

	file, err := payload.open()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "Welcome to Amazon S3." {
		t.Errorf("staged bytes = %q", data)
	}
}

func TestStageBlobCleansUpAFailedRender(t *testing.T) {
	directory := t.TempDir()
	_, _, err := stageBlob(directory, func(io.Writer) error { return errors.New("render exploded") })
	if err == nil {
		t.Fatal("a failing render staged successfully")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("%d temporary files left behind: %v", len(entries), entries)
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

	unreadable := stagedBlob{path: filepath.Join(t.TempDir(), "absent"), size: 7, sha256: "unused"}
	if err := store.put(context.Background(), "id/commit.json.gz", unreadable); err == nil {
		t.Fatal("an unreadable payload was stored successfully")
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

func testIdentity() snapshotIdentity {
	return snapshotIdentity{
		buckVersion:       "buck2 abc123",
		universe:          []string{"depot//..."},
		buckArgs:          []string{"-c", "ci.depot_gha_ci=true"},
		localConfigDigest: "aa00",
		platform:          "linux/amd64",
	}
}

// The derived key is the whole cache. If it drifts, every cache everywhere
// goes cold at once, and the symptom — a permanent stream of misses — looks
// exactly like a broken backend. Pinning it here makes going cold a deliberate
// act rather than an accident nobody notices for a month.
func TestSnapshotCacheKeyIsPinned(t *testing.T) {
	const want = "v2-2/d868b2576c63285d/deadbeef.json.gz"
	if got := snapshotCacheKey(testIdentity(), "deadbeef"); got != want {
		t.Fatalf("cache key = %q, want %q\nchanging the derivation invalidates every cache; update this only on purpose", got, want)
	}

	// Commits are matched case-insensitively elsewhere, so the key normalizes
	// rather than letting a capitalized revset spelling miss its own object.
	if got := snapshotCacheKey(testIdentity(), "DEADBEEF"); got != want {
		t.Fatalf("uppercase commit key = %q, want %q", got, want)
	}
}

// Concatenating fields plainly would let two genuinely different
// configurations hash alike. mismatchReason would catch the resulting
// document and fall back, so the cost is not a wrong answer -- it is a cache
// which stays permanently cold while looking like a network fault.
func TestSnapshotIdentityDigestIsUnambiguous(t *testing.T) {
	seen := map[string]string{}
	for name, identity := range map[string]snapshotIdentity{
		"base":             testIdentity(),
		"split args":       {buckVersion: "v", buckArgs: []string{"-c", "x=1"}},
		"joined args":      {buckVersion: "v", buckArgs: []string{"-cx=1"}},
		"arg order":        {buckVersion: "v", buckArgs: []string{"x=1", "-c"}},
		"split universe":   {buckVersion: "v", universe: []string{"a//...", "b//..."}},
		"joined universe":  {buckVersion: "v", universe: []string{"a//...b//..."}},
		"version boundary": {buckVersion: "v0", universe: []string{"//..."}},
		"version shifted":  {buckVersion: "v", universe: []string{"0//..."}},
		"other platform":   {buckVersion: "v", platform: "darwin/arm64"},
		"other config":     {buckVersion: "v", localConfigDigest: "ff"},
	} {
		digest := identity.digest()
		if previous, duplicate := seen[digest]; duplicate {
			t.Errorf("%q and %q share digest %s", name, previous, digest)
		}
		seen[digest] = name
		if len(digest) != 16 {
			t.Errorf("%q digest %q is not 16 hex characters", name, digest)
		}
	}
}

func TestSnapshotIdentityDigestIsStableAcrossCalls(t *testing.T) {
	if first, second := testIdentity().digest(), testIdentity().digest(); first != second {
		t.Fatalf("digest is unstable: %q then %q", first, second)
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
