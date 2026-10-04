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
}

// NuGet packages under third-party//csharp, scanned from nuget.lock.
var nugetExceptions = []exception{}

var rustExceptions = []exception{
	// Two unmaintained crates the iroh libraries bring in, with no release to
	// move to: postcard 1.1.3, the newest, takes heapless 0.7 with its `cas`
	// feature, and genawaiter 0.99.1, the newest, which bao-tree and
	// iroh-blobs build on, takes proc-macro-error for its macros. heapless
	// only uses atomic-polyfill on targets without atomic compare-and-swap,
	// which depot never builds for (no rule exists for it), and
	// proc-macro-error only runs at build time. Remove these once postcard
	// moves to heapless 0.8+ and bao-tree/iroh-blobs drop genawaiter.
	{
		ID:     "RUSTSEC-2023-0089",
		Reason: "atomic-polyfill is unmaintained; a cfg(no atomic CAS) dependency of heapless 0.7 via postcard 1.1.3 (iroh), never built for depot's targets, awaiting a postcard release on heapless 0.8+",
	},
	{
		ID:     "RUSTSEC-2024-0370",
		Reason: "proc-macro-error is unmaintained; a build-time dependency of genawaiter's macros via bao-tree and iroh-blobs, awaiting their move off genawaiter",
	},
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
	// GO-2026-5932 declares golang.org/x/crypto/openpgp unsafe by design and
	// covers every version of the module with no fix, so it fires on any Go
	// binary that links x/crypto at all. Chainguard files it against the
	// container-host packages as "pending upstream fix". The pins are already
	// Wolfi's newest builds, and neither containerd nor nerdctl speaks OpenPGP;
	// the module arrives transitively. Remove these when the binaries stop
	// linking x/crypto/openpgp or Chainguard marks the advisories fixed.
	// https://osv.dev/vulnerability/GO-2026-5932
	{
		ID:     "CGA-9r9j-62j2-9gp8",
		Reason: "containerd-2 GO-2026-5932: x/crypto/openpgp is unmaintained and has no fixed version; the package does not use OpenPGP, accepted until Chainguard marks it fixed",
	},
	{
		ID:     "CGA-m2hc-4chw-x5vv",
		Reason: "containerd-2 GO-2026-5932: x/crypto/openpgp is unmaintained and has no fixed version; the package does not use OpenPGP, accepted until Chainguard marks it fixed",
	},
	{
		ID:     "CGA-fmx9-qp76-j672",
		Reason: "nerdctl GO-2026-5932: x/crypto/openpgp is unmaintained and has no fixed version; the package does not use OpenPGP, accepted until Chainguard marks it fixed",
	},
	{
		ID:     "CGA-jwh8-4j76-c7cc",
		Reason: "nerdctl GO-2026-5932: x/crypto/openpgp is unmaintained and has no fixed version; the package does not use OpenPGP, accepted until Chainguard marks it fixed",
	},
	// glibc-2.44 advisories with no fixed version. The -2.44 pins are already
	// Wolfi's newest build (2.44-r7) and no newer glibc stream exists. Remove
	// these when Chainguard marks them fixed or the pins move to a new stream.
	{
		ID:     "CGA-fjmw-f657-w678",
		Reason: "glibc-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jm93-f4m9-rgvp",
		Reason: "glibc-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-84qm-pxw8-f58f",
		Reason: "glibc-2.44 CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-xjxq-jmjw-7rj2",
		Reason: "glibc-2.44 CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-2727-9j94-3x3p",
		Reason: "glibc-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-4mgp-78rw-5337",
		Reason: "glibc-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jgmh-74vj-wrg2",
		Reason: "glibc-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mjgh-p45f-mvfg",
		Reason: "glibc-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-4gmv-8mr7-5pxx",
		Reason: "glibc-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-wcq5-wxj2-j9rp",
		Reason: "glibc-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3p64-pj6v-586c",
		Reason: "glibc-2.44-locale-posix CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-fv7m-5pp8-x296",
		Reason: "glibc-2.44-locale-posix CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-g8xj-42hr-jc3p",
		Reason: "glibc-2.44-locale-posix CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mc39-989g-jgjq",
		Reason: "glibc-2.44-locale-posix CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-5w45-f7wm-grx2",
		Reason: "glibc-2.44-locale-posix CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-6px6-pp92-76hc",
		Reason: "glibc-2.44-locale-posix CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-h5x5-q5m8-wjmv",
		Reason: "glibc-2.44-locale-posix CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-hqr3-vw5h-72j2",
		Reason: "glibc-2.44-locale-posix CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-8wmh-vmch-wfc4",
		Reason: "glibc-2.44-locale-posix CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-p7p9-m5xm-f387",
		Reason: "glibc-2.44-locale-posix CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-q52v-g232-2h9m",
		Reason: "ld-linux-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-qh6f-vvgw-cjc9",
		Reason: "ld-linux-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-m5c2-m8fc-gvwj",
		Reason: "ld-linux-2.44 CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-xv8p-mh32-whm2",
		Reason: "ld-linux-2.44 CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-8h6p-6495-cwhr",
		Reason: "ld-linux-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-p698-26h2-8jh4",
		Reason: "ld-linux-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-37wc-rr96-hm3f",
		Reason: "ld-linux-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-87j2-rf55-jc3p",
		Reason: "ld-linux-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mppp-qcxg-vfqx",
		Reason: "ld-linux-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-v4q4-j4c8-88m4",
		Reason: "ld-linux-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-455w-rj3g-q384",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-fv27-p839-6fm7",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-ffcw-vc6v-cpwp",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-j44h-q4h6-v9gx",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-gvf6-5784-4mvf",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-r6gr-c6w7-cxgf",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-q7vx-xg2j-789q",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-w3h6-x3hh-x82x",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-4pmj-8wjv-7647",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-w94f-2g4r-22gc",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
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
