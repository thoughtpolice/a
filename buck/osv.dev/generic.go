// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"os/exec"
	"path"
	"sort"
	"strings"
)

type buckAuditor struct {
	path         string
	isolationDir string
}

// thirdPartyPackages is every package of the third-party cell. The generic
// scan covers the ones whose PACKAGE gives pkg.info an osv_info, so a new
// package is scanned without being listed anywhere else: a list in the cell's
// root PACKAGE would be inherited by every package below it, and so make
// target determination select all of them, and their users, whenever it
// changed.
const thirdPartyPackages = "third-party//..."

type packageAuditor interface {
	read(context.Context, ...string) (auditResponse, error)
	listPackages(context.Context) ([]string, error)
}

type packageValues map[string]jsontext.Value
type auditResponse map[string]packageValues

func (b buckAuditor) read(ctx context.Context, targets ...string) (auditResponse, error) {
	args := []string{"--isolation-dir", b.isolationDir, "audit", "package-values"}
	args = append(args, targets...)
	cmd := exec.CommandContext(ctx, b.path, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("buck audit package-values failed: %s", message)
	}

	var response auditResponse
	if err := json.UnmarshalRead(&stdout, &response); err != nil {
		return nil, fmt.Errorf("decode buck package metadata: %w", err)
	}
	if len(response) == 0 {
		return nil, fmt.Errorf("buck returned no package metadata")
	}
	return response, nil
}

// listPackages returns the packages of thirdPartyPackages that have targets,
// as "third-party//path".
func (b buckAuditor) listPackages(ctx context.Context) ([]string, error) {
	cmd := exec.CommandContext(ctx, b.path, "--isolation-dir", b.isolationDir, "uquery", thirdPartyPackages)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("buck uquery third-party packages failed: %s", message)
	}
	return packagesOfTargets(strings.Fields(stdout.String()))
}

// packagesOfTargets maps target labels, cell-qualified however Buck spells the
// cell, to the sorted set of their packages as "third-party//path".
func packagesOfTargets(labels []string) ([]string, error) {
	seen := make(map[string]struct{})
	for _, label := range labels {
		separator := strings.Index(label, "//")
		colon := strings.LastIndex(label, ":")
		if separator < 0 || colon < separator {
			return nil, fmt.Errorf("unexpected target label %q", label)
		}
		seen["third-party//"+label[separator+2:colon]] = struct{}{}
	}
	packages := make([]string, 0, len(seen))
	for pkg := range seen {
		packages = append(packages, pkg)
	}
	sort.Strings(packages)
	return packages, nil
}

func findPackageValues(response auditResponse, requested string) (packageValues, error) {
	separator := strings.Index(requested, "//")
	if separator < 0 {
		return nil, fmt.Errorf("invalid package label %q", requested)
	}
	wantedPath := requested[separator+2:]
	var match packageValues
	var matchedKey string
	for key, values := range response {
		keySeparator := strings.Index(key, "//")
		if keySeparator >= 0 && key[keySeparator+2:] == wantedPath {
			if match != nil {
				return nil, fmt.Errorf("buck returned ambiguous metadata for %q (%q and %q)", requested, matchedKey, key)
			}
			match = values
			matchedKey = key
		}
	}
	if match == nil {
		return nil, fmt.Errorf("buck did not return metadata for %q", requested)
	}
	return match, nil
}

type genericMetadata struct {
	Type    string `json:"type"`
	PURL    string `json:"purl"`
	Version string `json:"version"`
	URL     string `json:"url"`
	Commit  string `json:"commit"`
}

func collectGenericSubjects(ctx context.Context, auditor packageAuditor) ([]subject, error) {
	packages, err := auditor.listPackages(ctx)
	if err != nil {
		return nil, err
	}
	if len(packages) == 0 {
		return nil, fmt.Errorf("buck returned no third-party packages")
	}
	response, err := auditor.read(ctx, packages...)
	if err != nil {
		return nil, err
	}
	values := make(map[string]packageValues, len(packages))
	for _, pkg := range packages {
		if values[pkg], err = findPackageValues(response, pkg); err != nil {
			return nil, err
		}
	}

	var targets []string
	for _, pkg := range packages {
		_, hasOSV := values[pkg]["meta.osv"]
		_, hasVersion := values[pkg]["meta.version"]
		// Neither: no pkg.info names an upstream release here (the cell's
		// root, the Rust and C# trees, Wolfi's own pins). Only a version: a
		// package that forgot its osv_info, which the checks below report.
		if !hasOSV && !hasVersion {
			continue
		}
		if inheritsMetadata(pkg, values) {
			continue
		}
		targets = append(targets, pkg)
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no third-party package declares osv_info")
	}

	subjects := make([]subject, 0, len(targets))
	var problems []string
	for _, target := range targets {
		values := values[target]
		var packageVersion string
		if err := decodeRequired(values, "meta.version", &packageVersion); err != nil {
			problems = append(problems, target+": "+err.Error())
			continue
		}
		var metadata genericMetadata
		if err := decodeRequired(values, "meta.osv", &metadata); err != nil {
			problems = append(problems, target+": "+err.Error())
			continue
		}

		item := subject{Kind: genericSubject, Name: target}
		switch metadata.Type {
		case "OsvPurlInfo":
			if metadata.PURL == "" || metadata.Version == "" {
				problems = append(problems, target+": OsvPurlInfo requires non-empty purl and version")
				continue
			}
			if metadata.Version != packageVersion {
				problems = append(problems, fmt.Sprintf("%s: OSV version %q does not match meta.version %q", target, metadata.Version, packageVersion))
				continue
			}
			item.Query = osvQuery{Version: metadata.Version, Package: &osvPackage{PURL: metadata.PURL}}
			item.Display = metadata.PURL + "@" + metadata.Version
		case "OsvGitRepoInfo":
			if metadata.Commit == "" || metadata.URL == "" {
				problems = append(problems, target+": OsvGitRepoInfo requires non-empty url and commit")
				continue
			}
			if err := validateGitURL(metadata.URL); err != nil {
				problems = append(problems, target+": "+err.Error())
				continue
			}
			if !isGitHash(metadata.Commit) {
				problems = append(problems, fmt.Sprintf("%s: OSV commit %q is not an immutable 40- or 64-digit Git hash", target, metadata.Commit))
				continue
			}
			item.Query = osvQuery{Commit: metadata.Commit}
			item.Display = metadata.URL + "@" + metadata.Commit + " (package version " + packageVersion + ")"
		default:
			problems = append(problems, fmt.Sprintf("%s: unknown meta.osv type %q", target, metadata.Type))
			continue
		}
		if err := item.Query.validate(); err != nil {
			problems = append(problems, target+": "+err.Error())
			continue
		}
		subjects = append(subjects, item)
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("invalid third-party OSV metadata:\n  - %s", strings.Join(problems, "\n  - "))
	}
	return subjects, nil
}

// inheritsMetadata says whether pkg is a subpackage that has its version and
// OSV metadata only from its nearest ancestor package, which package values
// are inherited from, and so stands for the same upstream release.
func inheritsMetadata(pkg string, values map[string]packageValues) bool {
	for dir := path.Dir(strings.TrimPrefix(pkg, "third-party//")); dir != "."; dir = path.Dir(dir) {
		parent, ok := values["third-party//"+dir]
		if !ok {
			continue
		}
		own := values[pkg]
		return bytes.Equal(own["meta.osv"], parent["meta.osv"]) && bytes.Equal(own["meta.version"], parent["meta.version"])
	}
	return false
}

func decodeRequired(values packageValues, key string, destination any) error {
	raw, ok := values[key]
	if !ok || len(raw) == 0 || raw.Kind() == 'n' {
		return fmt.Errorf("missing %s", key)
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return fmt.Errorf("invalid %s: %w", key, err)
	}
	switch value := destination.(type) {
	case *string:
		if *value == "" {
			return fmt.Errorf("%s is empty", key)
		}
	}
	return nil
}

func isGitHash(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
