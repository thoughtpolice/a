// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
)

const (
	wolfiPackagePath = "by-name/wo/wolfi"
	wolfiTargetSet   = "third-party//" + wolfiPackagePath + ":"
	wolfiRepository  = "https://packages.wolfi.dev/os/x86_64/"
)

type wolfiTargetAttributes struct {
	SHA256 string   `json:"sha256"`
	URLs   []string `json:"urls"`
}

type wolfiTargetResponse map[string]wolfiTargetAttributes

type wolfiAuditor interface {
	readWolfiTargets(context.Context) (wolfiTargetResponse, error)
}

type dependencyAuditor interface {
	packageAuditor
	wolfiAuditor
}

// readWolfiTargets evaluates the same generated http_file targets consumed by
// image builds. This keeps the vulnerability inventory coupled to the pins
// without maintaining or parsing a second manifest.
func (b buckAuditor) readWolfiTargets(ctx context.Context) (wolfiTargetResponse, error) {
	args := []string{
		"--isolation-dir", b.isolationDir,
		"uquery", wolfiTargetSet,
		"--output-attribute", "urls|sha256",
		"--json",
	}
	cmd := exec.CommandContext(ctx, b.path, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("buck uquery Wolfi targets failed: %s", message)
	}

	var response wolfiTargetResponse
	if err := json.NewDecoder(&stdout).Decode(&response); err != nil {
		return nil, fmt.Errorf("decode Buck Wolfi target attributes: %w", err)
	}
	if len(response) == 0 {
		return nil, fmt.Errorf("buck returned no Wolfi package targets")
	}
	return response, nil
}

func collectWolfiSubjects(ctx context.Context, auditor wolfiAuditor) ([]subject, error) {
	targets, err := auditor.readWolfiTargets(ctx)
	if err != nil {
		return nil, err
	}
	return wolfiSubjects(targets)
}

func wolfiSubjects(targets wolfiTargetResponse) ([]subject, error) {
	if len(targets) == 0 {
		return nil, fmt.Errorf("Wolfi target set is empty")
	}

	subjects := make([]subject, 0, len(targets))
	seen := make(map[string]string, len(targets))
	var problems []string
	for target, attributes := range targets {
		separator := strings.LastIndexByte(target, ':')
		if separator >= 0 && !strings.HasSuffix(target[separator+1:], ".apk") {
			// The package also owns updater/support targets. Only generated APK
			// downloads form the vulnerability inventory.
			continue
		}
		name, version, err := parseWolfiTarget(target, attributes)
		if err != nil {
			problems = append(problems, target+": "+err.Error())
			continue
		}
		if previous, duplicate := seen[name]; duplicate {
			problems = append(problems, fmt.Sprintf("%s: duplicate Wolfi package %q (also provided by %s)", target, name, previous))
			continue
		}
		seen[name] = target

		purl := "pkg:apk/wolfi/" + name
		query := osvQuery{
			Version: version,
			Package: &osvPackage{PURL: purl},
		}
		if err := query.validate(); err != nil {
			problems = append(problems, target+": "+err.Error())
			continue
		}
		subjects = append(subjects, subject{
			Kind:    wolfiSubject,
			Name:    name + "@" + version,
			Display: purl + "@" + version,
			Query:   query,
		})
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("invalid Wolfi target metadata:\n  - %s", strings.Join(problems, "\n  - "))
	}
	if len(subjects) == 0 {
		return nil, fmt.Errorf("Wolfi target set contains no packages")
	}
	sort.Slice(subjects, func(left, right int) bool {
		return subjects[left].Name < subjects[right].Name
	})
	return subjects, nil
}

func parseWolfiTarget(target string, attributes wolfiTargetAttributes) (string, string, error) {
	separator := strings.LastIndexByte(target, ':')
	if separator < 0 || !strings.HasSuffix(target[:separator], "//"+wolfiPackagePath) {
		return "", "", fmt.Errorf("target is not in third-party//%s", wolfiPackagePath)
	}
	targetName := target[separator+1:]
	if !strings.HasSuffix(targetName, ".apk") {
		return "", "", fmt.Errorf("target name %q does not end in .apk", targetName)
	}
	name := strings.TrimSuffix(targetName, ".apk")
	if !validWolfiPackageName(name) {
		return "", "", fmt.Errorf("invalid Wolfi package name %q", name)
	}
	if !lowerHexDigest(attributes.SHA256) {
		return "", "", fmt.Errorf("sha256 must be exactly 64 lowercase hexadecimal digits")
	}
	if len(attributes.URLs) != 1 {
		return "", "", fmt.Errorf("expected exactly one package URL, got %d", len(attributes.URLs))
	}

	expectedPrefix := wolfiRepository + name + "-"
	packageURL := attributes.URLs[0]
	if !strings.HasPrefix(packageURL, expectedPrefix) || !strings.HasSuffix(packageURL, ".apk") {
		return "", "", fmt.Errorf("URL %q does not match %s<version>.apk", packageURL, expectedPrefix)
	}
	version := strings.TrimSuffix(strings.TrimPrefix(packageURL, expectedPrefix), ".apk")
	if !validWolfiVersion(version) {
		return "", "", fmt.Errorf("invalid Wolfi package version %q", version)
	}
	return name, version, nil
}

func validWolfiPackageName(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || strings.ContainsRune("+_.-", char) {
			continue
		}
		return false
	}
	return true
}

func validWolfiVersion(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("+_.~-", char) {
			continue
		}
		return false
	}
	return true
}

func lowerHexDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}
