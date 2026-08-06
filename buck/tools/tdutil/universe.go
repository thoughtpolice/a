// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"syscall"
	"unicode"
)

type universePatternKind int

const (
	universeOther universePatternKind = iota
	universeRecursive
	universePackage
	universeExact
)

type universePattern struct {
	kind        universePatternKind
	packageName string
	name        string
}

type anchorState int

const (
	anchorPresent anchorState = iota
	anchorAbsent
	anchorExternal
	anchorUnknownCell
)

type plannedPattern struct {
	raw  string
	kind universePattern
	base bool
	head bool
}

type universePlan struct {
	basePatterns []string
	headPatterns []string
	patterns     []plannedPattern
}

func classifyPattern(pattern string) universePattern {
	cell, relative, ok := strings.Cut(pattern, "//")
	if !ok || cell == "" || strings.HasPrefix(relative, "/") {
		return universePattern{kind: universeOther}
	}
	if relative == "..." {
		return universePattern{kind: universeRecursive, packageName: cell + "//"}
	}
	if packagePath, ok := strings.CutSuffix(relative, "/..."); ok && packagePath != "" {
		return universePattern{kind: universeRecursive, packageName: cell + "//" + packagePath}
	}
	if packagePath, name, ok := strings.Cut(relative, ":"); ok {
		if strings.Contains(packagePath, ":") || strings.Contains(name, ":") {
			return universePattern{kind: universeOther}
		}
		packageName := cell + "//" + packagePath
		if name == "" {
			return universePattern{kind: universePackage, packageName: packageName}
		}
		if strings.Contains(name, "*") || strings.Contains(name, "...") {
			return universePattern{kind: universeOther}
		}
		return universePattern{kind: universeExact, packageName: packageName, name: name}
	}
	if relative == "" {
		return universePattern{kind: universeOther}
	}
	name := relative
	if slash := strings.LastIndexByte(relative, '/'); slash >= 0 {
		name = relative[slash+1:]
	}
	return universePattern{kind: universeExact, packageName: cell + "//" + relative, name: name}
}

func inspectAnchor(workspace string, cells cellMap, packageName string) (anchorState, error) {
	cell, _, err := splitCellPath(packageName)
	if err != nil {
		return anchorUnknownCell, err
	}
	if !cells.isKnownCell(cell) {
		return anchorUnknownCell, nil
	}
	repoPath, err := cells.toRepoPath(packageName)
	if err != nil {
		return anchorUnknownCell, err
	}
	if repoPath == nil {
		return anchorExternal, nil
	}
	anchor := workspace
	if *repoPath != "" {
		anchor += string(os.PathSeparator) + strings.ReplaceAll(*repoPath, "/", string(os.PathSeparator))
	}
	info, err := os.Stat(anchor)
	if err == nil {
		if !info.IsDir() {
			return anchorUnknownCell, fmt.Errorf("universe package anchor `%s` at `%s` is not a directory", packageName, anchor)
		}
		return anchorPresent, nil
	}
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return anchorAbsent, nil
	}
	return anchorUnknownCell, fmt.Errorf("failed to inspect universe package anchor `%s` at `%s`: %w", packageName, anchor, err)
}

func planUniverse(
	baseWorkspace string,
	baseCells cellMap,
	headWorkspace string,
	headCells cellMap,
	patterns []string,
) (universePlan, error) {
	plan := universePlan{patterns: make([]plannedPattern, 0, len(patterns))}
	for _, raw := range patterns {
		kind := classifyPattern(raw)
		packageName, classified := patternPackage(kind)
		if !classified {
			plan.basePatterns = append(plan.basePatterns, raw)
			plan.headPatterns = append(plan.headPatterns, raw)
			plan.patterns = append(plan.patterns, plannedPattern{raw: raw, kind: kind, base: true, head: true})
			continue
		}
		baseState, err := inspectAnchor(baseWorkspace, baseCells, packageName)
		if err != nil {
			return universePlan{}, err
		}
		headState, err := inspectAnchor(headWorkspace, headCells, packageName)
		if err != nil {
			return universePlan{}, err
		}
		baseEvidence := baseState == anchorPresent || baseState == anchorExternal
		headEvidence := headState == anchorPresent || headState == anchorExternal
		if !baseEvidence && !headEvidence {
			return universePlan{}, fmt.Errorf("invalid universe pattern `%s`: its cell or directory exists at neither endpoint", raw)
		}
		if baseEvidence {
			plan.basePatterns = append(plan.basePatterns, raw)
		}
		if headEvidence {
			plan.headPatterns = append(plan.headPatterns, raw)
		}
		plan.patterns = append(plan.patterns, plannedPattern{raw: raw, kind: kind, base: baseEvidence, head: headEvidence})
	}
	return plan, nil
}

// headCoversEveryPattern reports whether every requested pattern was queried
// at head. A collected head graph may only be recorded as a reusable snapshot
// when this holds: planUniverseCachedBase treats a document's universe as
// unconditional evidence, on the grounds that capture queried everything the
// document lists. A graph collected over a subset would quietly break that.
func (plan *universePlan) headCoversEveryPattern() bool {
	for _, planned := range plan.patterns {
		if !planned.head {
			return false
		}
	}
	return true
}

func patternPackage(pattern universePattern) (string, bool) {
	switch pattern.kind {
	case universeRecursive, universePackage, universeExact:
		return pattern.packageName, true
	default:
		return "", false
	}
}

func validateUniverse(plan *universePlan, base, head *snapshot) error {
	excuseExpectedEndpointDiagnostics(plan, true, base, head)
	excuseExpectedEndpointDiagnostics(plan, false, head, base)
	if err := rejectBaseOnlyGraphErrors(base, head); err != nil {
		return err
	}
	for _, planned := range plan.patterns {
		switch planned.kind.kind {
		case universeExact:
			if !snapshotHasExact(base, planned.kind.packageName, planned.kind.name) &&
				!snapshotHasExact(head, planned.kind.packageName, planned.kind.name) {
				return fmt.Errorf("invalid universe pattern `%s`: target does not exist at either endpoint", planned.raw)
			}
		case universePackage:
			basePackage, baseOK := patternRepoPackage(base.cells, planned.kind)
			headPackage, headOK := patternRepoPackage(head.cells, planned.kind)
			if (!baseOK || !snapshotHasPackage(base, basePackage)) && (!headOK || !snapshotHasPackage(head, headPackage)) {
				return fmt.Errorf("invalid universe pattern `%s`: package does not exist at either endpoint", planned.raw)
			}
		}
	}
	return nil
}

func excuseExpectedEndpointDiagnostics(plan *universePlan, baseEndpoint bool, current, peer *snapshot) {
	for diagnosticPackage, records := range current.errors {
		repoPackage, err := current.cells.toRepoPath(diagnosticPackage)
		if err != nil || repoPackage == nil {
			continue
		}
		retained := records[:0]
		for _, diagnostic := range records {
			if !isExpectedEndpointDiagnostic(plan, baseEndpoint, current.cells, peer, diagnosticPackage, *repoPackage, diagnostic) {
				retained = append(retained, diagnostic)
			}
		}
		if len(retained) == 0 {
			delete(current.errors, diagnosticPackage)
		} else {
			current.errors[diagnosticPackage] = retained
		}
	}
}

func isExpectedEndpointDiagnostic(
	plan *universePlan,
	baseEndpoint bool,
	currentCells cellMap,
	peer *snapshot,
	diagnosticPackage, repoPackage, diagnostic string,
) bool {
	matchesPlanned := func(planned plannedPattern) bool {
		queried := planned.head
		if baseEndpoint {
			queried = planned.base
		}
		plannedRepoPackage, ok := patternRepoPackage(currentCells, planned.kind)
		return queried && ok && plannedRepoPackage == repoPackage && peerProvesPattern(peer, planned.kind)
	}
	if isMissingPackageError(diagnosticPackage, diagnostic) {
		for _, planned := range plan.patterns {
			if matchesPlanned(planned) {
				return true
			}
		}
		return false
	}
	names, ok := parseUnknownTargetDiagnostic(diagnosticPackage, diagnostic)
	if !ok || len(names) == 0 {
		return false
	}
	for _, name := range names {
		matched := false
		for _, planned := range plan.patterns {
			if planned.kind.kind == universeExact && planned.kind.name == name && matchesPlanned(planned) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

type normalizedGraphErrors struct {
	packageName string
	diagnostics []string
}

func rejectBaseOnlyGraphErrors(base, head *snapshot) error {
	baseErrors, err := normalizeGraphErrors(base)
	if err != nil {
		return err
	}
	headErrors, err := normalizeGraphErrors(head)
	if err != nil {
		return err
	}
	identities := make([]string, 0, len(baseErrors))
	for identity := range baseErrors {
		identities = append(identities, identity)
	}
	sort.Slice(identities, func(i, j int) bool {
		return baseErrors[identities[i]].packageName < baseErrors[identities[j]].packageName
	})
	for _, identity := range identities {
		baseGroup := baseErrors[identity]
		headCount := len(headErrors[identity].diagnostics)
		if len(baseGroup.diagnostics) > headCount {
			return fmt.Errorf(
				"Buck graph has more errors at base than head in `%s` (%d versus %d): %s",
				baseGroup.packageName,
				len(baseGroup.diagnostics),
				headCount,
				strings.Join(baseGroup.diagnostics, "\n"),
			)
		}
	}
	return nil
}

func normalizeGraphErrors(input *snapshot) (map[string]normalizedGraphErrors, error) {
	packages := make([]string, 0, len(input.errors))
	for packageName := range input.errors {
		packages = append(packages, packageName)
	}
	sort.Strings(packages)
	result := make(map[string]normalizedGraphErrors)
	for _, packageName := range packages {
		repoPackage, err := input.cells.toRepoPath(packageName)
		if err != nil {
			return nil, err
		}
		identity := "external:" + packageName
		if repoPackage != nil {
			identity = "repository:" + *repoPackage
		}
		group, exists := result[identity]
		if !exists {
			group.packageName = packageName
		}
		group.diagnostics = append(group.diagnostics, input.errors[packageName]...)
		result[identity] = group
	}
	return result, nil
}

func patternRepoPackage(cells cellMap, pattern universePattern) (string, bool) {
	packageName, ok := patternPackage(pattern)
	if !ok {
		return "", false
	}
	repoPackage, err := cells.toRepoPath(packageName)
	if err != nil || repoPackage == nil {
		return "", false
	}
	return *repoPackage, true
}

func peerProvesPattern(peer *snapshot, pattern universePattern) bool {
	switch pattern.kind {
	case universePackage:
		repoPackage, ok := patternRepoPackage(peer.cells, pattern)
		return ok && snapshotHasPackage(peer, repoPackage)
	case universeExact:
		return snapshotHasExact(peer, pattern.packageName, pattern.name)
	default:
		return false
	}
}

func snapshotHasPackage(input *snapshot, repoPackage string) bool {
	for _, target := range input.targets {
		if target.repoPackage == repoPackage {
			return true
		}
	}
	for _, file := range input.files {
		if file.repoPackage != nil && *file.repoPackage == repoPackage {
			return true
		}
	}
	return false
}

func snapshotHasExact(input *snapshot, packageName, name string) bool {
	repoPackage, err := input.cells.toRepoPath(packageName)
	if err != nil || repoPackage == nil {
		return false
	}
	for _, target := range input.targets {
		if target.repoPackage == *repoPackage && target.name == name {
			return true
		}
	}
	return false
}

func isMissingPackageError(packageName, diagnostic string) bool {
	detail, ok := strings.CutPrefix(diagnostic, "package `"+packageName+":` does not exist\n")
	if !ok {
		return false
	}
	if !strings.Contains(detail, "\n") {
		return isMissingBuildFileDetail(detail)
	}
	lines := rustStringLines(detail)
	if len(lines) != 2 {
		return false
	}
	marker := lines[0]
	trimmedMarker := strings.TrimLeftFunc(marker, unicode.IsSpace)
	if !strings.HasPrefix(trimmedMarker, "^") {
		return false
	}
	for _, character := range marker {
		if character != ' ' && character != '^' && character != '-' {
			return false
		}
	}
	message := strings.TrimRightFunc(lines[1], unicode.IsSpace)
	return message == "    dir `"+packageName+"` does not exist."
}

func rustStringLines(value string) []string {
	lines := strings.Split(value, "\n")
	if len(lines) != 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for index := range lines {
		lines[index] = strings.TrimSuffix(lines[index], "\r")
	}
	return lines
}

func isMissingBuildFileDetail(detail string) bool {
	rest, ok := strings.CutPrefix(detail, "    missing ")
	if !ok {
		return false
	}
	rest, ok = stripQuotedBuildFile(rest)
	if !ok {
		return false
	}
	rest, ok = strings.CutPrefix(rest, " file")
	if !ok {
		return false
	}
	if rest == "" {
		return true
	}
	rest, ok = strings.CutPrefix(rest, " (also missing alternatives ")
	if !ok || !strings.HasSuffix(rest, ")") {
		return false
	}
	rest = strings.TrimSuffix(rest, ")")
	for {
		rest, ok = stripQuotedBuildFile(rest)
		if !ok {
			return false
		}
		if rest == "" {
			return true
		}
		rest, ok = strings.CutPrefix(rest, ", ")
		if !ok {
			return false
		}
	}
}

func stripQuotedBuildFile(input string) (string, bool) {
	rest, ok := strings.CutPrefix(input, "`")
	if !ok {
		return "", false
	}
	end := strings.IndexByte(rest, '`')
	if end < 0 {
		return "", false
	}
	name := rest[:end]
	if name == "" || strings.ContainsAny(name, "\n\r/\\") {
		return "", false
	}
	return rest[end+1:], true
}

func parseUnknownTargetDiagnostic(packageName, diagnostic string) ([]string, bool) {
	if strings.ContainsAny(diagnostic, "\n\r") {
		return nil, false
	}
	body := strings.TrimSuffix(diagnostic, ".")
	suffix := " from package `" + packageName + "`"
	body, ok := strings.CutSuffix(body, suffix)
	if !ok {
		return nil, false
	}
	if name, single := strings.CutPrefix(body, "Unknown target `"); single && strings.HasSuffix(name, "`") {
		name = strings.TrimSuffix(name, "`")
		if validTargetName(name) {
			return []string{name}, true
		}
		return nil, false
	}
	rest, ok := strings.CutPrefix(body, "Unknown targets ")
	if !ok {
		return nil, false
	}
	var names []string
	for {
		rest, ok = strings.CutPrefix(rest, "`")
		if !ok {
			return nil, false
		}
		end := strings.IndexByte(rest, '`')
		if end < 0 || !validTargetName(rest[:end]) {
			return nil, false
		}
		names = append(names, rest[:end])
		rest = rest[end+1:]
		if rest == "" {
			return names, len(names) != 0
		}
		rest, ok = strings.CutPrefix(rest, ", ")
		if !ok {
			return nil, false
		}
	}
}

func validTargetName(name string) bool {
	return name != "" &&
		!strings.ContainsAny(name, "`\n\r:") &&
		!strings.Contains(name, "//")
}
