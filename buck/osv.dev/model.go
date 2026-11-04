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
	// Three OSS-Fuzz crashes in QEMU's device models, open upstream. As with
	// wabt, each range names an introduced commit and no fixed one, so every
	// release since is affected. third-party//by-name/qe/qemu builds neither
	// the MegaRAID SAS nor the SD host controller model, and virtio-gpu, which
	// it does build, can only be driven there by the guest: the emulators are
	// for local firmware and OS development on guests the developer controls.
	// Remove these once upstream closes the reports.
	{
		ID:     "OSV-2021-820",
		Reason: "QEMU virtio-gpu out-of-bounds read in virtio_gpu_disable_scanout, reachable only from the guest; OSS-Fuzz 34831 is open with no fix",
	},
	{
		ID:     "OSV-2022-581",
		Reason: "QEMU megasas heap overflow in megasas_map_sgl, a device the depot's QEMU does not build; OSS-Fuzz 49086 is open with no fix",
	},
	{
		ID:     "OSV-2023-390",
		Reason: "QEMU sdhci heap overflow in sdhci_write, a device the depot's QEMU does not build; OSS-Fuzz 58813 is open with no fix",
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
	// unsafe-libyaml is archived upstream, with 0.2.11 as its last release. It
	// arrives through slatedb, which turns on figment's yaml provider
	// (serde_yaml) unconditionally for loading Settings from files. The cache
	// server, slatedb's only user, builds its Settings in code, so the YAML
	// parser never runs. Remove this once slatedb or figment drops serde_yaml.
	{
		ID:     "RUSTSEC-2024-0449",
		Reason: "unsafe-libyaml is unmaintained; pulled in by slatedb via figment and serde_yaml for settings files the cache server never loads, awaiting slatedb/figment moving off serde_yaml",
	},
	// GHSA-qwgh-2vcv-g2f7 covers every block-buffer release before 0.12.1,
	// but the bug is in the inline cursor that 0.11 introduced: EagerBuffer
	// keeps its position in the block's last byte and ReadBuffer in its
	// first, so a panicking callback can leave input bytes there. 0.10.4,
	// which the whole digest 0.10 stack (sha1, sha2, sha3, blake2, jj-lib,
	// argon2) still requires, keeps the position in a separate `pos: u8`
	// field that no callback can reach and that is only ever assigned a
	// valid value, so a panic leaves the previous position intact. Remove
	// this once nothing depends on digest 0.10.
	{
		ID:     "GHSA-qwgh-2vcv-g2f7",
		Reason: "block-buffer inline cursor corrupted by a panicking callback; 0.10.4 (digest 0.10) stores the cursor in a separate field callbacks cannot write, awaiting the digest 0.10 users moving to digest 0.11",
	},
	// zstd 0.14.3 / zstd-safe 8.2.0 fix these, and depot's own zstd uses
	// them, but foyer-storage 0.22.6 (via slatedb), the newest release, still
	// requires zstd 0.13, which has no fixed release; neither has zstd-safe 7.
	// foyer only calls zstd::Encoder::new and zstd::Decoder::new (the
	// stream::write encoder and the stream::read decoder, each on a fresh
	// context) over cache entries it wrote itself, and the build enables
	// neither the experimental, zstdmt nor seekable feature. That path reaches
	// none of the APIs below: no context reuse via with_context, no one-shot
	// calls, no dictionaries or training, no try_clone, no around_pos, and the
	// legacy-frame bug is in the write-side decoder only. Remove these once
	// foyer moves to zstd 0.14.3+.
	{
		ID:     "RUSTSEC-2026-0391",
		Reason: "zstd 0.13 with_context leaks an abandoned stream into the next; foyer-storage (via slatedb) pins 0.13 and only uses fresh contexts, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0395",
		Reason: "zstd-safe 7 use-after-free with CParameter::StableInBuffer, an experimental-feature parameter; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0396",
		Reason: "zstd-safe 7 Seekable reads a NULL or out-of-bounds seek table; seekable feature; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0397",
		Reason: "zstd-safe 7 OutBuffer::around_pos exposes uninitialized memory; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0398",
		Reason: "zstd-safe 7 Seekable::decompress over-long Vec length; seekable feature; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0399",
		Reason: "zstd-safe 7 use-after-free through init_using_cdict/init_using_ddict, experimental feature; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0400",
		Reason: "zstd-safe 7 dictionary use-after-free after a one-shot call on a context with an open stream; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0401",
		Reason: "zstd-safe 7 out-of-bounds read in train_from_buffer with overflowing sample sizes; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0402",
		Reason: "zstd-safe 7 heap overflow in CCtx::try_clone on a multithreaded context, experimental and zstdmt features; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0403",
		Reason: "zstd-safe 7 uninitialized memory from stream::write::Decoder after a failed legacy frame; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0404",
		Reason: "zstd-safe 7 double free in DCtx::try_clone, experimental feature; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0405",
		Reason: "zstd-safe 7 out-of-bounds read with an out-of-range InBuffer::pos in SeekableCStream; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
	{
		ID:     "RUSTSEC-2026-0406",
		Reason: "zstd-safe 7 use-after-free changing a multithreaded context with an unfinished frame, zstdmt feature; foyer-storage's zstd 0.13 stream encoder/decoder never reach it, awaiting a foyer release on zstd 0.14.3+",
	},
}

// npmExceptions accepts advisories against packages in a package-lock.json
// passed with -npm-lock. Every entry needs a reason and an exit condition,
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
	// Wolfi's newest build (2.44-r13) and no newer glibc stream exists. Remove
	// these when Chainguard marks them fixed or the pins move to a new stream.
	{
		ID:     "CGA-fjmw-f657-w678",
		Reason: "glibc-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-84qm-pxw8-f58f",
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
		ID:     "CGA-4gmv-8mr7-5pxx",
		Reason: "glibc-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3p64-pj6v-586c",
		Reason: "glibc-2.44-locale-posix CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
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
		ID:     "CGA-fv27-p839-6fm7",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
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
		ID:     "CGA-4pmj-8wjv-7647",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-w94f-2g4r-22gc",
		Reason: "posix-libc-utils-bin-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	// libexpat 2.9.0 has two denial-of-service bugs: billion-laughs
	// protection that detects amplification too late (CVE-2026-115506), and
	// XML_ParserReset leaving tracked allocations behind (CVE-2026-113351).
	// The fixes merged upstream on 2026-10-23 (libexpat PRs 1433 and 1431)
	// but are unreleased, and 2.9.0-r0 is Wolfi's newest build. minimos
	// ships libexpat1 only as a DT_NEEDED library of dbus, which parses its
	// own root-owned configuration with it, never XML from a peer. Remove
	// these when a Wolfi build with the fixes clears OSV.
	{
		ID:     "CGA-32gf-5529-3pvx",
		Reason: "libexpat1 CVE-2026-115506: late billion-laughs detection (CPU DoS); fixed upstream but unreleased, and dbus only parses its root-owned configuration, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-683h-gf3c-jgc8",
		Reason: "libexpat1 CVE-2026-115506: late billion-laughs detection (CPU DoS); fixed upstream but unreleased, and dbus only parses its root-owned configuration, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-6mq2-cc4m-px38",
		Reason: "libexpat1 CVE-2026-113351: XML_ParserReset keeps allocation accounting (memory DoS); fixed upstream but unreleased, and dbus only parses its root-owned configuration, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-gxcg-r99q-jjvj",
		Reason: "libexpat1 CVE-2026-113351: XML_ParserReset keeps allocation accounting (memory DoS); fixed upstream but unreleased, and dbus only parses its root-owned configuration, accepted until a fixed Wolfi version clears OSV",
	},
	// Chainguard's advisory page lists this cni-plugins stdlib finding
	// (CVE-2026-78669, GO-2026-6611 in the dhcp plugin) as fixed in 1.9.1-r16,
	// the pinned build, but OSV's copy has no fixed event yet. Remove this
	// once the check reports it unused.
	// https://images.chainguard.dev/security/CGA-8j2h-p468-v3g6
	{
		ID:     "CGA-8j2h-p468-v3g6",
		Reason: "cni-plugins CVE-2026-78669: Chainguard marks it fixed in 1.9.1-r16, the pinned version, but OSV's record lacks the fixed event; accepted until OSV catches up",
	},
	// glibc-2.44-dev, the devcontainer's libc headers, carries the same
	// unfixed glibc advisories as the glibc-2.44 runtime above, and moves with
	// that stream.
	{
		ID:     "CGA-q98f-x5gg-77jq",
		Reason: "glibc-2.44-dev CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vxj5-vgq2-w95g",
		Reason: "glibc-2.44-dev CVE-2026-86805: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9jhh-7whq-9r98",
		Reason: "glibc-2.44-dev CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-85j7-p5fv-48pq",
		Reason: "glibc-2.44-dev CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-pq49-vpwf-9c5h",
		Reason: "glibc-2.44-dev CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	// binutils advisories with no fixed version. Wolfi's 2.47-r2 is its newest
	// build. The devcontainer runs binutils only on objects its own build
	// produced, never on untrusted files. Remove these when Chainguard marks
	// them fixed.
	{
		ID:     "CGA-9gj8-gjxv-82qf",
		Reason: "binutils CVE-2026-6844: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-fp47-6j6h-hj89",
		Reason: "binutils CVE-2026-6844: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-g89r-r3vh-pg54",
		Reason: "binutils CVE-2026-6845: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vm64-rhrg-jq27",
		Reason: "binutils CVE-2026-6845: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3x96-2xqq-vjp6",
		Reason: "binutils CVE-2026-90801: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9rcc-j9xg-72hj",
		Reason: "binutils CVE-2026-90801: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-52cx-9f2g-9fj3",
		Reason: "binutils CVE-2026-90802: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-fw29-622p-rcr2",
		Reason: "binutils CVE-2026-90802: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9c6v-m8x8-j3fw",
		Reason: "binutils CVE-2026-90803: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rfj3-3xpp-75fh",
		Reason: "binutils CVE-2026-90803: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-5gv6-97hw-c99g",
		Reason: "binutils CVE-2026-90804: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mxhv-p599-37pj",
		Reason: "binutils CVE-2026-90804: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-7cxq-52mv-wf27",
		Reason: "binutils CVE-2026-90828: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-m742-4p9j-3f58",
		Reason: "binutils CVE-2026-90828: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-59px-82vq-wxf5",
		Reason: "binutils CVE-2026-90829: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-fxmw-q594-mwr3",
		Reason: "binutils CVE-2026-90829: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-654r-h3j3-cp6j",
		Reason: "binutils CVE-2026-90830: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-793r-8w27-7cpx",
		Reason: "binutils CVE-2026-90830: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-2v63-758j-xjm7",
		Reason: "binutils CVE-2026-90831: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-qpvq-hw46-jg8f",
		Reason: "binutils CVE-2026-90831: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-84q2-7229-4h7w",
		Reason: "binutils CVE-2026-91779: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rqgg-6xvr-c6q9",
		Reason: "binutils CVE-2026-91779: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3gg8-98rw-pxh5",
		Reason: "binutils CVE-2026-91780: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rcxm-9cq6-m5fx",
		Reason: "binutils CVE-2026-91780: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-2wfw-w4p7-55x5",
		Reason: "binutils CVE-2026-91781: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-4pq8-rj3p-hwfh",
		Reason: "binutils CVE-2026-91781: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-59hv-jrxx-977f",
		Reason: "binutils CVE-2026-91782: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-r4h9-8rmm-9h9q",
		Reason: "binutils CVE-2026-91782: no fixed Wolfi version; the devcontainer only runs binutils on its own build outputs, accepted until a fixed Wolfi version clears OSV",
	},
	// GNU tar's advisories, filed again against gnutar-rmt, the remote tape
	// server that comes with it. gnutar's own entries are above; nothing in
	// the devcontainer runs rmt.
	{
		ID:     "CGA-hw3x-x556-3rqr",
		Reason: "gnutar-rmt CVE-2026-18477: no fixed Wolfi version; rmt is installed with GNU tar and never run, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vqm8-jx54-c2cp",
		Reason: "gnutar-rmt CVE-2026-18477: no fixed Wolfi version; rmt is installed with GNU tar and never run, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-f98f-wjrv-6qj4",
		Reason: "gnutar-rmt CVE-2026-18508: no fixed Wolfi version; rmt is installed with GNU tar and never run, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-r254-q9vp-5wqf",
		Reason: "gnutar-rmt CVE-2026-18508: no fixed Wolfi version; rmt is installed with GNU tar and never run, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-582v-r7g5-w5rq",
		Reason: "gnutar-rmt CVE-2026-5704: no fixed Wolfi version; rmt is installed with GNU tar and never run, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-x5hq-xw39-hh38",
		Reason: "gnutar-rmt CVE-2026-5704: no fixed Wolfi version; rmt is installed with GNU tar and never run, accepted until a fixed Wolfi version clears OSV",
	},
	// python-3.13 advisories with no fixed version, in Wolfi's newest build.
	// The devcontainer's python3 runs only check.py and doctor.py; Buck2's
	// Python toolchain downloads its own interpreter.
	{
		ID:     "CGA-8fx3-25f8-fh5x",
		Reason: "python-3.13 CVE-2025-15367: no fixed Wolfi version; the devcontainer runs only the repository's own scripts with it, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-ffmr-pm2v-8xqw",
		Reason: "python-3.13 CVE-2025-15367: no fixed Wolfi version; the devcontainer runs only the repository's own scripts with it, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-4jf6-rmh4-vqjj",
		Reason: "python-3.13 CVE-2026-103995: no fixed Wolfi version; the devcontainer runs only the repository's own scripts with it, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vq33-cv22-hgvv",
		Reason: "python-3.13 CVE-2026-103995: no fixed Wolfi version; the devcontainer runs only the repository's own scripts with it, accepted until a fixed Wolfi version clears OSV",
	},
	// Wolfi stopped publishing podman-6.0 after 6.0.2-r2, the build the
	// devcontainer pins. These advisories are Go standard library and
	// module findings in its binaries: some are fixed in later builds that
	// only Chainguard's own repository has, the rest have no fix yet.
	// The devcontainer only runs podman to start the repository's own
	// test images, in CI's privileged job container.
	{
		ID:     "CGA-2mfc-xg87-22pg",
		Reason: "podman-6.0 CVE-2026-116587: fixed in 6.0.2-r15, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-36mh-p5xf-h7j3",
		Reason: "podman-6.0 CVE-2026-116587: fixed in 6.0.2-r15, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rjpf-9q27-7qrp",
		Reason: "podman-6.0 CVE-2026-116587: fixed in 6.0.2-r15, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-w9wh-33qf-xpjr",
		Reason: "podman-6.0 CVE-2026-116587: fixed in 6.0.2-r15, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9p94-3xx8-82gg",
		Reason: "podman-6.0 CVE-2026-17106: fixed in 6.0.2-r4, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-c9v4-xxw2-qrxf",
		Reason: "podman-6.0 CVE-2026-17106: fixed in 6.0.2-r4, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-r6jc-9x73-82gh",
		Reason: "podman-6.0 CVE-2026-17106: fixed in 6.0.2-r4, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vjf3-rgx5-jwmg",
		Reason: "podman-6.0 CVE-2026-17106: fixed in 6.0.2-r4, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-45c8-48hf-g288",
		Reason: "podman-6.0 CVE-2026-56855: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-776j-g447-pvf5",
		Reason: "podman-6.0 CVE-2026-56855: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-pggx-j9hj-99gh",
		Reason: "podman-6.0 CVE-2026-56855: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rx76-v667-fw36",
		Reason: "podman-6.0 CVE-2026-56855: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-48vp-wm6v-26mc",
		Reason: "podman-6.0 CVE-2026-61711: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-55hx-246h-27pp",
		Reason: "podman-6.0 CVE-2026-61711: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-hh3j-4vxv-9fgj",
		Reason: "podman-6.0 CVE-2026-61711: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jqp6-xx8w-377w",
		Reason: "podman-6.0 CVE-2026-61711: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-79gx-ggc8-mhjx",
		Reason: "podman-6.0 CVE-2026-61712: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jh5h-gvj7-3cr8",
		Reason: "podman-6.0 CVE-2026-61712: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-m69p-xfhj-6x38",
		Reason: "podman-6.0 CVE-2026-61712: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-w3hf-j2gm-mjm7",
		Reason: "podman-6.0 CVE-2026-61712: fixed in 6.0.2-r5, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-5jrw-2jpj-6mfp",
		Reason: "podman-6.0 CVE-2026-78659: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rrx2-h6rf-gvm5",
		Reason: "podman-6.0 CVE-2026-78659: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rwm8-r7pq-gpfr",
		Reason: "podman-6.0 CVE-2026-78659: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-v6gj-6rhr-2jqq",
		Reason: "podman-6.0 CVE-2026-78659: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-4748-73j9-v763",
		Reason: "podman-6.0 CVE-2026-78662: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-c644-m44r-r6pg",
		Reason: "podman-6.0 CVE-2026-78662: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-cxj7-vxr3-rhx3",
		Reason: "podman-6.0 CVE-2026-78662: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vg58-cwhm-7wvx",
		Reason: "podman-6.0 CVE-2026-78662: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3f38-hm8c-jwx3",
		Reason: "podman-6.0 CVE-2026-78663: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-66j6-85jc-h6m5",
		Reason: "podman-6.0 CVE-2026-78663: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-8rv7-hj3m-95q6",
		Reason: "podman-6.0 CVE-2026-78663: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-h2m8-q6gf-5wr5",
		Reason: "podman-6.0 CVE-2026-78663: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-25qr-5pr6-rwmr",
		Reason: "podman-6.0 CVE-2026-78669: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3gc6-wrc2-v4f4",
		Reason: "podman-6.0 CVE-2026-78669: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9gm4-9wcf-rj3j",
		Reason: "podman-6.0 CVE-2026-78669: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-hcgq-8ww6-7535",
		Reason: "podman-6.0 CVE-2026-78669: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-277w-j353-fxfw",
		Reason: "podman-6.0 CVE-2026-81870: fixed in 6.0.2-r9, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-hhrv-g8r3-2q4f",
		Reason: "podman-6.0 CVE-2026-81870: fixed in 6.0.2-r9, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-pg7w-m2h9-mxpj",
		Reason: "podman-6.0 CVE-2026-81870: fixed in 6.0.2-r9, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-rjr3-vvhh-f58g",
		Reason: "podman-6.0 CVE-2026-81870: fixed in 6.0.2-r9, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3x28-3gxf-gq7p",
		Reason: "podman-6.0 CVE-2026-84303: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-j8pp-x8v5-93cq",
		Reason: "podman-6.0 CVE-2026-84303: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jp99-wh7x-g5mv",
		Reason: "podman-6.0 CVE-2026-84303: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vm22-3r25-439v",
		Reason: "podman-6.0 CVE-2026-84303: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-cg88-pgqw-76hv",
		Reason: "podman-6.0 CVE-2026-84304: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-j3v4-v6fq-q2rw",
		Reason: "podman-6.0 CVE-2026-84304: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mjmp-jrw6-ff8r",
		Reason: "podman-6.0 CVE-2026-84304: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-vqc8-9jp5-h2rc",
		Reason: "podman-6.0 CVE-2026-84304: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-3436-f7j9-hw6f",
		Reason: "podman-6.0 CVE-2026-84445: fixed in 6.0.2-r8, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-5j34-hj83-82p7",
		Reason: "podman-6.0 CVE-2026-84445: fixed in 6.0.2-r8, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-x5qj-5c35-fw44",
		Reason: "podman-6.0 CVE-2026-84445: fixed in 6.0.2-r8, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-xxrx-wvm9-52xx",
		Reason: "podman-6.0 CVE-2026-84445: fixed in 6.0.2-r8, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-5h5r-mwg5-m25q",
		Reason: "podman-6.0 CVE-2026-85747: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9vch-cfwq-f5hx",
		Reason: "podman-6.0 CVE-2026-85747: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9x6j-hmq9-m7mp",
		Reason: "podman-6.0 CVE-2026-85747: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-r4pc-m9q9-q6gw",
		Reason: "podman-6.0 CVE-2026-85747: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-2h3r-f4vx-3cpq",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9494-pm5r-23pj",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-f5cv-w5w6-gw9v",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-grqp-px63-ghpx",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-mxfj-hfh4-h97q",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-p6xq-2782-cc36",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-qh23-76mw-6p2g",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-xvmf-m3pv-mpqf",
		Reason: "podman-6.0 CVE-2026-94603: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-2438-f3jm-2w85",
		Reason: "podman-6.0 CVE-2026-97032: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-9cpw-9m22-4869",
		Reason: "podman-6.0 CVE-2026-97032: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-fvxc-c4pf-88fx",
		Reason: "podman-6.0 CVE-2026-97032: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-j565-9vxm-4v2q",
		Reason: "podman-6.0 CVE-2026-97032: fixed in 6.0.2-r11, which Wolfi hasn't published; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-7w4v-rw3h-v76w",
		Reason: "podman-6.0 GO-2026-5932: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jrw4-rx6f-rx45",
		Reason: "podman-6.0 GO-2026-5932: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-qhvx-w39h-jh8j",
		Reason: "podman-6.0 GO-2026-5932: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-r8jc-34mg-jc52",
		Reason: "podman-6.0 GO-2026-5932: no fixed Wolfi version; podman only starts the repository's own test images in CI's devcontainer, accepted until a fixed Wolfi version clears OSV",
	},
	// libcrypt1-2.44, which linux-pam brings into the devcontainer, carries
	// the same unfixed glibc advisories as the glibc-2.44 runtime above, and
	// moves with that stream.
	{
		ID:     "CGA-6cv2-mm79-q3h6",
		Reason: "libcrypt1-2.44 CVE-2026-8674: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-5273-pf8c-cg4v",
		Reason: "libcrypt1-2.44 CVE-2026-89092: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-jr99-f6q8-945r",
		Reason: "libcrypt1-2.44 CVE-2026-95818: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
	},
	{
		ID:     "CGA-xqrp-7jh5-56v7",
		Reason: "libcrypt1-2.44 CVE-2026-97399: no fixed Wolfi version; temporarily accepted for development images until a fixed Wolfi version clears OSV",
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
