// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"slices"
	"sort"
	"strings"
)

type affectedTarget struct {
	target      string
	ruleType    string
	depth       int
	reason      string
	affectedDep *string
}

type determineOptions struct {
	depth *int
	// config carries the repository's conventions: which paths invalidate the
	// whole graph, which files are build files, and what the CI metadata is
	// called. The zero value is not usable; callers pass a resolved config.
	config tdutilConfig
}

// determine conservatively compares complete base and head snapshots and
// propagates direct impact through the head reverse-dependency graph.
func determine(base, head *snapshot, changed []string, options determineOptions) ([]affectedTarget, error) {
	options.config = options.config.withDefaults()
	changedSet := make(map[string]struct{}, len(changed))
	for _, changedPath := range changed {
		changedSet[strings.ReplaceAll(changedPath, "\\", "/")] = struct{}{}
	}
	changedPaths := sortedSet(changedSet)

	graph := newGraph(base, head, options.config)
	ciPatterns, err := compileCIPatterns(graph, options.config)
	if err != nil {
		return nil, err
	}
	for _, changedPath := range changedPaths {
		if options.config.isGlobalConfiguration(changedPath) {
			return selectEveryHeadTarget(graph, "build configuration changed"), nil
		}
	}

	roots := make(map[string]string)
	for _, label := range sortedTargetLabels(base.targets) {
		if _, exists := head.targets[label]; !exists {
			addRoot(roots, label, "target was removed")
		}
	}
	for _, label := range sortedTargetLabels(head.targets) {
		current := head.targets[label]
		previous, exists := base.targets[label]
		switch {
		case !exists:
			addRoot(roots, label, "target was added")
		case previous.targetHash != current.targetHash:
			addRoot(roots, label, "target definition changed")
		}
	}

	for _, changedPath := range changedPaths {
		for label := range graph.labelsForInput(changedPath) {
			addRoot(roots, label, fmt.Sprintf("input `%s` changed", changedPath))
		}
	}
	for _, changedPath := range changedPaths {
		if isPackageFile(pathBase(changedPath)) {
			addDescendantPackages(graph, pathParent(changedPath), changedPath, roots)
		} else if options.config.buildFiles.isBuildFile(changedPath) {
			addPackage(graph, pathParent(changedPath), changedPath, roots)
		}
	}

	importingFiles := sortedSet(graph.transitiveImporters(changedPaths))
	for _, importedPath := range importingFiles {
		for label := range graph.labelsForRule(importedPath) {
			addRoot(roots, label, fmt.Sprintf("rule import `%s` changed", importedPath))
		}
		if file, exists := graph.fileByPath(importedPath); exists && file.repoPackage != nil {
			addPackage(graph, *file.repoPackage, importedPath, roots)
		}
		if isPackageFile(pathBase(importedPath)) {
			addDescendantPackages(graph, pathParent(importedPath), importedPath, roots)
		} else if options.config.buildFiles.isBuildFile(importedPath) {
			addPackage(graph, pathParent(importedPath), importedPath, roots)
		}
	}

	for _, label := range sortedTargetLabels(graph.targets) {
		patterns := ciPatterns[label]
		for _, changedPath := range changedPaths {
			if patterns.srcs.matches(changedPath) {
				if ciMustMatch(patterns, changedPaths) {
					addRoot(roots, label, fmt.Sprintf("%s matched `%s`", options.config.ciSrcsAttribute, changedPath))
				}
				break
			}
		}
	}

	return propagateWithReasons(graph, roots, options.depth, changedPaths, ciPatterns, options.config.skipUpstreamLabel), nil
}

// selectEveryHeadTarget names the whole head universe. It answers the case
// where the diff cannot be reasoned about target by target — a change to the
// build configuration itself — but the head graph is complete, so testing all
// of it is a superset of any honest selection.
func selectEveryHeadTarget(graph *graph, reason string) []affectedTarget {
	labels := sortedTargetLabels(graph.headTargets)
	affected := make([]affectedTarget, 0, len(labels))
	for _, label := range labels {
		affected = append(affected, affectedTarget{
			target:   label,
			ruleType: graph.headTargets[label].ruleType,
			depth:    0,
			reason:   reason,
		})
	}
	return affected
}

type ciPatterns struct {
	srcs      globList
	mustMatch globList
}

func compileCIPatterns(graph *graph, config tdutilConfig) (map[string]ciPatterns, error) {
	result := make(map[string]ciPatterns, len(graph.targets))
	for _, label := range sortedTargetLabels(graph.targets) {
		target := graph.targets[label]
		srcs, err := compileGlobList(target.ciSrcs, target.label, config.ciSrcsAttribute)
		if err != nil {
			return nil, err
		}
		mustMatch, err := compileGlobList(target.ciSrcsMustMatch, target.label, config.ciSrcsMustMatch)
		if err != nil {
			return nil, err
		}
		result[label] = ciPatterns{srcs: srcs, mustMatch: mustMatch}
	}
	return result, nil
}

type propagationItem struct {
	target      string
	depth       int
	reason      string
	affectedDep *string
}

func propagateWithReasons(
	graph *graph,
	roots map[string]string,
	depthLimit *int,
	changed []string,
	patterns map[string]ciPatterns,
	skipUpstreamLabel string,
) []affectedTarget {
	rootLabels := make([]string, 0, len(roots))
	for label := range roots {
		rootLabels = append(rootLabels, label)
	}
	sort.Strings(rootLabels)
	seen := make(labelSet, len(rootLabels))
	queue := make([]propagationItem, 0, len(rootLabels))
	for _, label := range rootLabels {
		seen[label] = struct{}{}
		queue = append(queue, propagationItem{target: label, reason: roots[label]})
	}

	affected := make([]affectedTarget, 0, len(queue))
	for first := 0; first < len(queue); first++ {
		item := queue[first]
		headTarget, inHead := graph.headTarget(item.target)
		if item.depth > 0 && inHead && !ciMustMatch(patterns[headTarget.label], changed) {
			continue
		}
		if inHead {
			affected = append(affected, affectedTarget{
				target:      item.target,
				ruleType:    headTarget.ruleType,
				depth:       item.depth,
				reason:      item.reason,
				affectedDep: item.affectedDep,
			})
		}
		unionTarget, exists := graph.target(item.target)
		if (depthLimit != nil && item.depth >= *depthLimit) || (exists && stopsUpstreamPropagation(unionTarget, skipUpstreamLabel)) {
			continue
		}
		dependents := sortedSet(graph.headDependents(item.target))
		for _, dependent := range dependents {
			if _, exists := seen[dependent]; exists {
				continue
			}
			seen[dependent] = struct{}{}
			dependency := item.target
			queue = append(queue, propagationItem{
				target:      dependent,
				depth:       item.depth + 1,
				reason:      item.reason,
				affectedDep: &dependency,
			})
		}
	}
	sort.Slice(affected, func(i, j int) bool { return affected[i].target < affected[j].target })
	return affected
}

func stopsUpstreamPropagation(target target, skipUpstreamLabel string) bool {
	if skipUpstreamLabel == "" {
		return false
	}
	return slices.Contains(target.labels, skipUpstreamLabel)
}

func ciMustMatch(patterns ciPatterns, changed []string) bool {
	if patterns.mustMatch.isUndeclared() {
		return true
	}
	for _, changedPath := range changed {
		if patterns.mustMatch.matches(changedPath) {
			return true
		}
	}
	return false
}

func addRoot(roots map[string]string, label, reason string) {
	if _, exists := roots[label]; !exists {
		roots[label] = reason
	}
}

func addPackage(graph *graph, packageName, changedFile string, roots map[string]string) {
	for label := range graph.labelsForPackage(packageName) {
		addRoot(roots, label, fmt.Sprintf("package file `%s` changed", changedFile))
	}
}

func addDescendantPackages(graph *graph, packageName, changedFile string, roots map[string]string) {
	for candidate, labels := range graph.packages {
		if !pathIsWithin(candidate, packageName) {
			continue
		}
		for label := range labels {
			addRoot(roots, label, fmt.Sprintf("inherited package file `%s` changed", changedFile))
		}
	}
}

func pathParent(path string) string {
	if separator := strings.LastIndexByte(path, '/'); separator >= 0 {
		return path[:separator]
	}
	return ""
}

func pathBase(path string) string {
	if separator := strings.LastIndexByte(path, '/'); separator >= 0 {
		return path[separator+1:]
	}
	return path
}

func pathIsWithin(path, directory string) bool {
	return directory == "" || path == directory || strings.HasPrefix(path, directory+"/")
}

func sortedTargetLabels(targets map[string]target) []string {
	result := make([]string, 0, len(targets))
	for label := range targets {
		result = append(result, label)
	}
	sort.Strings(result)
	return result
}

func sortedSet(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
