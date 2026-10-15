// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strings"
	"syscall"
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

// baseCoversEveryPattern is the same gate for the other endpoint. A run which
// missed the cache collects the base graph anyway, and that graph is worth
// storing for the next run — but only when it covers everything a reader would
// later take it as evidence for, which is the pattern that exists at base and
// not at head.
func (plan *universePlan) baseCoversEveryPattern() bool {
	for _, planned := range plan.patterns {
		if !planned.base {
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

// validateUniverse checks that every requested pattern resolved to something
// at one endpoint or the other. A pattern which named nothing at either is a
// typo, not a diff: it would silently contribute no targets forever.
//
// A pattern absent from one endpoint alone is ordinary — that is what adding
// or removing a package looks like — and planUniverse has already arranged not
// to query it there.
func validateUniverse(plan *universePlan, base, head *snapshot) error {
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

// collectionUniverse is what tdutil queries, as opposed to what it reports. A
// selection is only as complete as the graph its reverse dependencies are
// walked in: a toolchain, a vendored crate or a library in another cell is a
// dependency like any other, and a change to it reaches its dependents only
// if it is in the graph to change. So every collectable cell is queried
// whole, and a selection pattern survives only for a cell that is not, such
// as one `ignore_cells` leaves out but the caller asked for anyway.
func collectionUniverse(selection, collectCells []string) []string {
	whole := make(map[string]bool, len(collectCells))
	patterns := make([]string, 0, len(collectCells)+len(selection))
	for _, cell := range collectCells {
		whole[cell] = true
		patterns = append(patterns, cell+"//...")
	}
	for _, pattern := range selection {
		cell, _, _ := strings.Cut(pattern, "//")
		if !whole[cell] {
			patterns = append(patterns, pattern)
		}
	}
	return normalizeUniverse(patterns)
}

// withinUniverse keeps the affected targets the caller asked about. Impact is
// propagated through the whole collected graph first, so a target outside the
// selection can still be why one inside it is reported.
func withinUniverse(affected []affectedTarget, selection []string) []affectedTarget {
	kept := make([]affectedTarget, 0, len(affected))
	for _, candidate := range affected {
		for _, pattern := range selection {
			if targetPatternMatches(pattern, candidate.target) {
				kept = append(kept, candidate)
				break
			}
		}
	}
	return kept
}

// ignoredCellDependents finds collected targets which depend on a target in an
// ignored cell. Those edges lead out of the graph, so a change at their far
// end selects nothing. Each such target is reported once, with one of the
// dependencies it was found through.
func ignoredCellDependents(collected *snapshot, ignored []string) map[string]string {
	result := make(map[string]string)
	if len(ignored) == 0 {
		return result
	}
	for _, label := range sortedTargetLabels(collected.targets) {
		for _, dep := range collected.targets[label].deps {
			cell, _, _ := strings.Cut(dep, "//")
			if slices.Contains(ignored, cell) {
				result[label] = dep
				break
			}
		}
	}
	return result
}
