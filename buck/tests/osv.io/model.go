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
	// gix 0.80.x and its sub-crates are pinned by the jj-lib/jj-cli revision.
	// Remove these after jj is bumped to a revision using gix 0.83 or newer.
	{
		ID:     "GHSA-f26g-jm89-4g65",
		Reason: "gix-submodule command injection in .gitmodules; fixed in gix 0.83, awaiting a jj revision bump",
	},
	{
		ID:     "GHSA-fr8x-3vfx-f45h",
		Reason: "gix submodule-name path traversal; fixed in gix 0.83, awaiting a jj revision bump",
	},
	{
		ID:     "GHSA-p3hw-mv63-rf9w",
		Reason: "gix submodule validation bypass and trust inheritance; fixed in gix 0.83, awaiting a jj revision bump",
	},
	{
		ID:     "GHSA-pg4w-g64p-qwhj",
		Reason: "gix follows a symlinked .gitmodules outside the repository; fixed in gix 0.83, awaiting a jj revision bump",
	},
	{
		ID:     "GHSA-f89h-2fjh-2r9q",
		Reason: "gix-fs worktree escape through symlink prefix reuse; fixed in gix-fs 0.21.1, awaiting a jj revision bump",
	},
	{
		ID:     "GHSA-x494-mj8g-cj27",
		Reason: "gix-pack denial of service from crafted pack data; fixed in gix-pack 0.69.0, awaiting a jj revision bump",
	},
	{
		ID:     "GHSA-9857-6mw7-fq2m",
		Reason: "gix-transport curl backend credential leak on redirect; fixed in gix-transport 0.56.0, awaiting a jj revision bump",
	},
}

// npmExceptions accepts advisories against packages in the scanned
// package-lock.json files. Every entry needs a reason and an exit condition,
// the same as the Rust list above.
var npmExceptions []exception

// exceptionSets binds each ecosystem's exception list to the subject kind it
// applies to. An advisory is only excepted for the ecosystem that declared it,
// so an npm entry can never silence the same advisory ID for a crate.
var exceptionSets = []struct {
	Kind  subjectKind
	Label string
	Items []exception
}{
	{Kind: rustSubject, Label: "Rust", Items: rustExceptions},
	{Kind: npmSubject, Label: "npm", Items: npmExceptions},
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
