// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	// A miss costs one full base collection, which is minutes. Waiting longer
	// than that for a download is never the better trade, so the default bound
	// is well inside it.
	defaultCacheTimeout = 60 * time.Second

	// Only a local cache directory prunes itself; object stores have lifecycle
	// rules and ignore this.
	defaultCacheMaxAge = 14 * 24 * time.Hour
)

// snapshotCache is the run's cache: a place to keep documents, the identity
// every key derives from, and whether this run may write.
//
// Reads are automatic and writes are opt-in, because the two are not
// symmetric. A cache hit helps whoever runs next, but a write from a local
// working copy stores a graph keyed by a commit that changes on every jj
// snapshot and that nobody will ever request.
type snapshotCache struct {
	store    blobStore
	identity snapshotIdentity
	write    bool
	timeout  time.Duration
	tempDir  string
}

// resolveSnapshotIdentity gathers everything a snapshot's contents depend on
// besides the commit. This costs one `buck2 --version`, which does not start a
// daemon; the current code defers that subprocess until the cheaper checks
// pass, but a derived key needs it before there is a key to check anything
// against.
func resolveSnapshotIdentity(
	ctx context.Context,
	runner processRunner,
	buck, repository string,
	universe, buckArgs []string,
	config tdutilConfig,
) (snapshotIdentity, error) {
	version, err := buckVersionString(ctx, runner, buck)
	if err != nil {
		return snapshotIdentity{}, err
	}
	digest, err := localBuckConfigDigest(repository)
	if err != nil {
		return snapshotIdentity{}, err
	}
	return identityOf(version, universe, buckArgs, digest, config), nil
}

// mismatchAgainst is mismatchReason plus the buck2 version, which the document
// records but which the caller used to check separately so it could defer the
// subprocess. An identity has already paid for that, so both are checked here.
func (document *snapshotDocument) mismatchAgainst(identity snapshotIdentity, baseCommit string) string {
	if reason := document.mismatchReason(baseCommit, identity.universe, identity.buckArgs, identity.localConfigDigest, identity.configDigest); reason != "" {
		return reason
	}
	if document.BuckVersion != identity.buckVersion {
		return fmt.Sprintf(
			"snapshot was made by buck2 %q but the current buck2 is %q",
			document.BuckVersion,
			identity.buckVersion,
		)
	}
	return ""
}

func buildSnapshotDocumentFor(identity snapshotIdentity, commit string, collected *snapshot) *snapshotDocument {
	return buildSnapshotDocument(
		identity.buckVersion,
		commit,
		identity.universe,
		identity.buckArgs,
		identity.localConfigDigest,
		identity.configDigest,
		collected,
	)
}

// fetch returns the stored graph for a commit. A miss reports errCacheMiss,
// which is the ordinary cold-cache case and not a fault; every other error
// means the backend could not answer.
//
// Either way the caller falls back to full collection, so a cache can cost a
// run time and never its answer. The document is still validated against the
// identity it was keyed by, because a key proving what a document contains is
// a property worth checking rather than assuming.
func (cache *snapshotCache) fetch(ctx context.Context, commit string) (*snapshotDocument, error) {
	key := snapshotCacheKey(cache.identity, commit)
	ctx, cancel := context.WithTimeout(ctx, cache.timeout)
	defer cancel()

	reader, err := cache.store.get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()

	document, err := decodeSnapshotDocument(bufio.NewReaderSize(reader, 64*1024))
	if err != nil {
		return nil, err
	}
	if reason := document.mismatchAgainst(cache.identity, commit); reason != "" {
		return nil, errors.New(reason)
	}
	return document, nil
}

// put stores a document under the commit it describes, so the key and the
// contents cannot disagree.
func (cache *snapshotCache) put(ctx context.Context, document *snapshotDocument) error {
	payload, cleanup, err := stageBlob(cache.tempDir, func(output io.Writer) error {
		return encodeSnapshotDocumentTo(output, document)
	})
	if err != nil {
		return err
	}
	defer cleanup()

	ctx, cancel := context.WithTimeout(ctx, cache.timeout)
	defer cancel()
	return cache.store.put(ctx, snapshotCacheKey(cache.identity, document.Commit), payload)
}

// openSnapshotCache resolves the cache a run was asked for. Both failures here
// are fatal: an unusable location or an unusable buck2 are deterministic
// properties of the invocation which no retry can fix, and reporting them as
// warnings would leave a run quietly paying full collection on every
// invocation with nothing to say why.
func openSnapshotCache(
	ctx context.Context,
	runner processRunner,
	args *cliArgs,
	repository, tempDir string,
	config tdutilConfig,
) (*snapshotCache, error) {
	if args.cache == nil {
		return nil, nil
	}
	store, err := openBlobStore(*args.cache, args.cacheMaxAge)
	if err != nil {
		return nil, err
	}
	identity, err := resolveSnapshotIdentity(ctx, runner, args.buck, repository, args.universe, args.buckArgs, config)
	if err != nil {
		return nil, err
	}
	return &snapshotCache{
		store:    store,
		identity: identity,
		write:    args.cacheWrite,
		timeout:  args.cacheTimeout,
		tempDir:  tempDir,
	}, nil
}

// obtainBaseDocument resolves the base endpoint from a recorded document: the
// local file first because it is free, then the cache. Every way this can fail
// — a missing file, a cold cache, a backend that will not answer, a document
// whose recorded inputs do not match — leaves the caller collecting the base
// graph itself, so a cache costs a run time and never its answer.
//
// A cold cache is reported only under --verbose, because a cache nobody has
// written to yet is the ordinary first run rather than a fault. Anything else
// is reported unconditionally, because it is one.
func obtainBaseDocument(
	ctx context.Context,
	runner processRunner,
	args *cliArgs,
	cache *snapshotCache,
	repository, baseCommit string,
	config tdutilConfig,
	stderr io.Writer,
) *snapshotDocument {
	if args.baseSnapshot == nil && cache == nil {
		return nil
	}

	identity := snapshotIdentity{}
	if cache != nil {
		identity = cache.identity
	} else {
		resolved, err := resolveSnapshotIdentity(ctx, runner, args.buck, repository, args.universe, args.buckArgs, config)
		if err != nil {
			_, _ = fmt.Fprintf(
				stderr,
				"tdutil: base snapshot %s ignored (%v); collecting the base graph instead\n",
				*args.baseSnapshot, err,
			)
			return nil
		}
		identity = resolved
	}

	if args.baseSnapshot != nil {
		document, reason := loadBaseSnapshot(*args.baseSnapshot, identity, baseCommit)
		if document != nil {
			logProgress(stderr, args, "using base snapshot %s for %s (%d targets)", *args.baseSnapshot, baseCommit, len(document.Targets))
			return document
		}
		next := "collecting the base graph instead"
		if cache != nil {
			next = "trying the cache"
		}
		_, _ = fmt.Fprintf(stderr, "tdutil: base snapshot %s ignored (%s); %s\n", *args.baseSnapshot, reason, next)
	}

	if cache == nil {
		return nil
	}

	key := snapshotCacheKey(cache.identity, baseCommit)
	document, err := cache.fetch(ctx, baseCommit)
	switch {
	case err == nil:
		logProgress(stderr, args, "using cached base snapshot %s for %s (%d targets)", key, baseCommit, len(document.Targets))
		return document
	case errors.Is(err, errCacheMiss):
		logProgress(stderr, args, "snapshot cache miss for %s (%s); collecting the base graph", baseCommit, key)
	default:
		_, _ = fmt.Fprintf(
			stderr,
			"tdutil: snapshot cache %s unusable (%v); collecting the base graph instead\n",
			cache.store, err,
		)
	}
	return nil
}

// storeSnapshot records a collected graph under a commit, reporting rather
// than failing. The determined targets are the run's deliverable and a
// snapshot is only a cache, which is the same bargain the local capture makes.
//
// A graph collected over fewer patterns than were requested is declined
// outright: a reader treats a document's universe as proof that capture
// queried all of it, and a partial graph would quietly break that.
func (cache *snapshotCache) storeSnapshot(
	ctx context.Context,
	args *cliArgs,
	which, commit string,
	universeIsComplete bool,
	collected *snapshot,
	stderr io.Writer,
) {
	if cache == nil || !cache.write {
		return
	}
	decline := func(reason string) {
		_, _ = fmt.Fprintf(stderr, "tdutil: %s snapshot not cached (%s)\n", which, reason)
	}
	if !universeIsComplete {
		decline("the " + which + " graph does not cover every requested universe pattern")
		return
	}
	document := buildSnapshotDocumentFor(cache.identity, commit, collected)
	if err := cache.put(ctx, document); err != nil {
		decline(err.Error())
		return
	}
	logProgress(
		stderr, args,
		"cached the %s snapshot for %s (%d targets) at %s",
		which, commit, len(collected.targets), snapshotCacheKey(cache.identity, commit),
	)
}
