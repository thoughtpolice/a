// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
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

type packageAuditor interface {
	read(context.Context, ...string) (auditResponse, error)
}

type packageValues map[string]json.RawMessage
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
	decoder := json.NewDecoder(&stdout)
	if err := decoder.Decode(&response); err != nil {
		return nil, fmt.Errorf("decode buck package metadata: %w", err)
	}
	if len(response) == 0 {
		return nil, fmt.Errorf("buck returned no package metadata")
	}
	return response, nil
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
	rootResponse, err := auditor.read(ctx, "third-party//")
	if err != nil {
		return nil, err
	}
	root, err := findPackageValues(rootResponse, "third-party//")
	if err != nil {
		return nil, err
	}
	var packagePaths []string
	if err := decodeRequired(root, "meta.3p", &packagePaths); err != nil {
		return nil, fmt.Errorf("third-party//: %w", err)
	}
	if len(packagePaths) == 0 {
		return nil, fmt.Errorf("third-party//: meta.3p is empty")
	}

	seen := make(map[string]struct{}, len(packagePaths))
	targets := make([]string, 0, len(packagePaths))
	for _, packagePath := range packagePaths {
		if packagePath == "rust" {
			continue
		}
		if packagePath == "" || path.IsAbs(packagePath) || path.Clean(packagePath) != packagePath || strings.Contains(packagePath, "//") {
			return nil, fmt.Errorf("third-party//: invalid package path %q in meta.3p", packagePath)
		}
		if _, duplicate := seen[packagePath]; duplicate {
			return nil, fmt.Errorf("third-party//: duplicate package %q in meta.3p", packagePath)
		}
		seen[packagePath] = struct{}{}
		targets = append(targets, "third-party//"+packagePath)
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("third-party//: no generic packages are listed")
	}

	response, err := auditor.read(ctx, targets...)
	if err != nil {
		return nil, err
	}
	subjects := make([]subject, 0, len(targets))
	var problems []string
	for _, target := range targets {
		values, err := findPackageValues(response, target)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
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

func decodeRequired(values packageValues, key string, destination any) error {
	raw, ok := values[key]
	if !ok || len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
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
