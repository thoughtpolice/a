// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"net/url"
	"strings"
)

type subjectKind uint8

const (
	genericSubject subjectKind = iota
	rustSubject
	npmSubject
	wolfiSubject
	nugetSubject
)

type osvPackage struct {
	PURL string `json:"purl"`
}

type osvQuery struct {
	Commit    string      `json:"commit,omitempty"`
	Version   string      `json:"version,omitempty"`
	Package   *osvPackage `json:"package,omitempty"`
	PageToken string      `json:"page_token,omitempty"`
}

func (q osvQuery) validate() error {
	hasCommit := q.Commit != ""
	hasPackage := q.Package != nil && q.Package.PURL != ""
	if hasCommit == hasPackage {
		return fmt.Errorf("query must contain exactly one of commit or package purl")
	}
	if hasCommit && q.Version != "" {
		return fmt.Errorf("commit query must not contain a version")
	}
	if hasPackage {
		if q.Version == "" {
			return fmt.Errorf("package query is missing a version")
		}
		if err := validatePURL(q.Package.PURL); err != nil {
			return err
		}
	}
	return nil
}

func validatePURL(purl string) error {
	if !strings.HasPrefix(purl, "pkg:") {
		return fmt.Errorf("invalid purl %q: must start with pkg:", purl)
	}
	base := strings.SplitN(purl, "?", 2)[0]
	base = strings.SplitN(base, "#", 2)[0]
	if strings.Contains(base, "@") {
		return fmt.Errorf("invalid purl %q: version must be supplied separately", purl)
	}
	return nil
}

type subject struct {
	Kind    subjectKind
	Name    string
	Display string
	Query   osvQuery
}

type vulnerabilityRef struct {
	ID       string `json:"id"`
	Modified string `json:"modified,omitempty"`
}

type vulnerability struct {
	ID        string   `json:"id"`
	Aliases   []string `json:"aliases"`
	Summary   string   `json:"summary"`
	Details   string   `json:"details"`
	Withdrawn string   `json:"withdrawn"`
}

type exception struct {
	ID     string
	Reason string
}

// genericExceptions accepts advisories against the packages declared under
// third-party//by-name. Every entry needs a reason and an exit condition, the
// same as the lists below.
var genericExceptions = []exception{
	// Four OSS-Fuzz crashes in wabt that upstream has not fixed. Each OSV range
	// names an introduced commit and no fixed commit, so every release through
	// 1.0.41 is affected and there is no newer tag to bump to. Reaching any of
	// them takes a hostile .wasm, and depot only runs the wabt tools over the
	// .wat inputs checked in next to them. Remove these once upstream closes the
	// reports.
	{
		ID:     "OSV-2022-916",
		Reason: "wabt container-overflow write in interp::BinaryReaderInterp::BeginFunctionBody; OSS-Fuzz 51565 is open with no fix",
	},
	{
		ID:     "OSV-2022-1263",
		Reason: "wabt null-dereference read with no reported crash stack; OSS-Fuzz 54424 is open with no fix",
	},
	{
		ID:     "OSV-2023-346",
		Reason: "wabt out-of-bounds write growing interp::HandlerDesc storage; OSS-Fuzz 58344 is open with no fix",
	},
	{
		ID:     "OSV-2024-398",
		Reason: "wabt use of an uninitialized value in BinaryReaderObjdump::PrintInitExpr; OSS-Fuzz 65975 is open with no fix",
	},
	// The non-blocking gz* support added in zlib 1.3.1.2 lets gz_vacate() copy a
	// stalled external input buffer into the smaller internal one, and only
	// notices the overrun after the memmove(). The OSV range ends at a
	// last-affected commit with no fix: v1.3.2 is both the newest release and
	// upstream master, and the sole post-1.3.2 gzwrite.c commit on develop just
	// guards a NULL pointer add. Reaching it needs gzprintf() on a non-blocking
	// gzFile, and libz has no reverse dependencies in depot at all. Remove this
	// once upstream ships a fixed release.
	{
		ID:     "CVE-2026-85091",
		Reason: "zlib heap buffer overflow in gz_vacate() via gzprintf() after a non-blocking write stall; no fixed release exists and depot links no libz consumers",
	},
}

// NuGet packages under third-party//csharp, scanned from nuget.lock.
var nugetExceptions = []exception{}

var rustExceptions = []exception{
	{
		ID:     "RUSTSEC-2024-0388",
		Reason: "derivative is unmaintained; pulled in by starlark-rust, awaiting upstream migration",
	},
	{
		ID:     "RUSTSEC-2024-0436",
		Reason: "paste is unmaintained; pulled in by foyer-storage and starlark, awaiting upstream migration",
	},
	{
		ID:     "RUSTSEC-2025-0057",
		Reason: "fxhash is unmaintained; pulled in by starlark_map, awaiting upstream migration",
	},
	{
		ID:     "RUSTSEC-2025-0141",
		Reason: "bincode 1.x is unmaintained; pulled in by foyer, awaiting an upstream bincode 2.x migration",
	},
	{
		ID:     "RUSTSEC-2026-0253",
		Reason: "lru use-after-free in LruCache::pop(); fixed in lru 0.18.2, but sapling-streampager 0.12 (via jj-cli) requires lru 0.16, awaiting an upstream streampager bump",
	},
	// scc enters through dial9-perf-self-profile's memory profiler, which
	// requires scc 2 while the fix landed in 3.8.4. The unsound path is
	// `Array::insert` unwinding out of a user comparison, and dial9 only ever
	// instantiates `scc::HashIndex<u64, (u64, u64), FxBuildHasher>`, whose key
	// comparison is a primitive integer compare that cannot panic. Remove this
	// once dial9-perf-self-profile moves to scc 3.
	{
		ID:     "RUSTSEC-2026-0205",
		Reason: "scc Array::insert double-free if the comparison panics; fixed in scc 3.8.4, but dial9-perf-self-profile requires scc 2, and its only key type is u64",
	},
	// The im-rc stack is unmaintained with no fixed releases -- every version
	// is affected -- and enters through egglog, which builds its persistent
	// data structures on im-rc. Remove these once egglog drops im-rc.
	{
		ID:     "RUSTSEC-2026-0247",
		Reason: "bitmaps is unmaintained; pulled in by egglog via im-rc and sized-chunks, awaiting an upstream egglog migration",
	},
	{
		ID:     "RUSTSEC-2026-0250",
		Reason: "im-rc is unmaintained; pulled in by egglog, awaiting an upstream egglog migration",
	},
	{
		ID:     "RUSTSEC-2026-0251",
		Reason: "sized-chunks is unmaintained; pulled in by egglog via im-rc, awaiting an upstream egglog migration",
	},
	{
		ID:     "RUSTSEC-2026-0255",
		Reason: "sized-chunks panic-safety unsoundness in Chunk/RingBuffer/InlineArray; no fixed release exists, pulled in by egglog via im-rc, awaiting an upstream egglog migration",
	},
}

// npmExceptions accepts advisories against packages in the scanned
// package-lock.json files. Every entry needs a reason and an exit condition,
// the same as the Rust list above.
var npmExceptions []exception

// OSV still reports these two GNU tar vulnerabilities against Wolfi's latest
// 1.35-r12, with no fixed version in either range. Accept them temporarily for
// the minimos development images: avoid incremental restores (-g/-G) with
// untrusted input or local writers, and do not rely on --one-top-level to
// confine hard links. Remove these when a fixed Wolfi version clears OSV.
// https://access.redhat.com/security/cve/CVE-2026-18477
// https://access.redhat.com/security/cve/CVE-2026-18508
// Chainguard publishes separate IDs for x86_64 and aarch64; both are returned
// by OSV's Wolfi package query.
var wolfiExceptions = []exception{
	{
		ID:     "CGA-482f-jcpj-938x",
		Reason: "GNU tar CVE-2026-18508: --one-top-level does not confine hard links; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-g36v-8pg9-6573",
		Reason: "GNU tar CVE-2026-18508: --one-top-level does not confine hard links; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-hgrg-pr2j-rw66",
		Reason: "GNU tar CVE-2026-18477: incremental restore rename race with local writers; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mj3q-7hxc-pp4g",
		Reason: "GNU tar CVE-2026-18477: incremental restore rename race with local writers; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
}

// exceptionSets binds each ecosystem's exception list to the subject kind it
// applies to. An advisory is only excepted for the ecosystem that declared it,
// so an npm entry can never silence the same advisory ID for a crate.
var exceptionSets = []struct {
	Kind  subjectKind
	Label string
	Items []exception
}{
	{Kind: genericSubject, Label: "generic", Items: genericExceptions},
	{Kind: rustSubject, Label: "Rust", Items: rustExceptions},
	{Kind: npmSubject, Label: "npm", Items: npmExceptions},
	{Kind: wolfiSubject, Label: "Wolfi", Items: wolfiExceptions},
	{Kind: nugetSubject, Label: "NuGet", Items: nugetExceptions},
}

func exceptionsFor(kind subjectKind) []exception {
	for _, set := range exceptionSets {
		if set.Kind == kind {
			return set.Items
		}
	}
	return nil
}

func validateGitURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("invalid upstream URL %q: expected an absolute https URL", raw)
	}
	return nil
}
