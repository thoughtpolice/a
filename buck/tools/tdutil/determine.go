// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"sort"
	"strings"
)

type affectedTarget struct {
	target      string
	depth       int
	reason      string
	affectedDep *string
}

type determineOptions struct {
	depth *int
}

// determine conservatively compares complete base and head snapshots and
// propagates direct impact through the head reverse-dependency graph.
func determine(base, head *snapshot, changed []string, options determineOptions) ([]affectedTarget, error) {
	changedSet := make(map[string]struct{}, len(changed))
	for _, changedPath := range changed {
		changedSet[strings.ReplaceAll(changedPath, "\\", "/")] = struct{}{}
	}
	changedPaths := sortedSet(changedSet)
	if err := validateGraphErrors(base, head, changedPaths); err != nil {
		return nil, err
	}

	graph := newGraph(base, head)
	ciPatterns, err := compileCIPatterns(graph)
	if err != nil {
		return nil, err
	}
	for _, changedPath := range changedPaths {
		if isGlobalConfiguration(changedPath) {
			labels := sortedTargetLabels(graph.headTargets)
			affected := make([]affectedTarget, 0, len(labels))
			for _, label := range labels {
				affected = append(affected, affectedTarget{
					target: label,
					depth:  0,
					reason: "build configuration changed",
				})
			}
			return affected, nil
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
		name := pathBase(changedPath)
		if isPackageFile(name) {
			addDescendantPackages(graph, pathParent(changedPath), changedPath, roots)
		} else if isBuildFile(name) {
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
		} else if isBuildFile(pathBase(importedPath)) {
			addPackage(graph, pathParent(importedPath), importedPath, roots)
		}
	}

	for _, label := range sortedTargetLabels(graph.targets) {
		patterns := ciPatterns[label]
		for _, changedPath := range changedPaths {
			if patterns.srcs.matches(changedPath) {
				if ciMustMatch(patterns, changedPaths) {
					addRoot(roots, label, fmt.Sprintf("ci_srcs matched `%s`", changedPath))
				}
				break
			}
		}
	}

	return propagateWithReasons(graph, roots, options.depth, changedPaths, ciPatterns), nil
}

type diagnosticIdentity struct {
	external bool
	path     string
}

type diagnosticGroup struct {
	displayPackage string
	diagnostics    []string
}

func validateGraphErrors(base, head *snapshot, changed []string) error {
	baseDiagnostics, err := endpointDiagnostics(base, head)
	if err != nil {
		return err
	}
	headDiagnostics, err := endpointDiagnostics(head, base)
	if err != nil {
		return err
	}
	identitiesSet := make(map[diagnosticIdentity]struct{}, len(baseDiagnostics)+len(headDiagnostics))
	for identity := range baseDiagnostics {
		identitiesSet[identity] = struct{}{}
	}
	for identity := range headDiagnostics {
		identitiesSet[identity] = struct{}{}
	}
	identities := make([]diagnosticIdentity, 0, len(identitiesSet))
	for identity := range identitiesSet {
		identities = append(identities, identity)
	}
	sort.Slice(identities, func(i, j int) bool {
		if identities[i].external != identities[j].external {
			return !identities[i].external
		}
		return identities[i].path < identities[j].path
	})

	for _, identity := range identities {
		baseGroup := baseDiagnostics[identity]
		headGroup, hasHead := headDiagnostics[identity]
		baseCount := len(baseGroup.diagnostics)
		headCount := len(headGroup.diagnostics)
		displayPackage := baseGroup.displayPackage
		if hasHead {
			displayPackage = headGroup.displayPackage
		}
		if headCount > baseCount {
			return fmt.Errorf(
				"new Buck graph error in `%s` (%d non-endpoint diagnostics at head, %d in the predecessor): %s",
				displayPackage, headCount, baseCount, strings.Join(headGroup.diagnostics, "\n"),
			)
		}
		if baseCount > headCount {
			return fmt.Errorf(
				"Buck graph error in predecessor package `%s` (%d non-endpoint diagnostics in the predecessor, %d at head): %s",
				displayPackage, baseCount, headCount, strings.Join(baseGroup.diagnostics, "\n"),
			)
		}
		if baseCount > 0 && !identity.external {
			for _, changedPath := range changed {
				if pathIsWithin(changedPath, identity.path) {
					return fmt.Errorf(
						"changed files touch package `%s`, which has a pre-existing Buck graph error: %s",
						displayPackage, strings.Join(headGroup.diagnostics, "\n"),
					)
				}
			}
		}
	}
	return nil
}

func endpointDiagnostics(current, peer *snapshot) (map[diagnosticIdentity]diagnosticGroup, error) {
	packages := make([]string, 0, len(current.errors))
	for packageName := range current.errors {
		packages = append(packages, packageName)
	}
	sort.Strings(packages)
	result := make(map[diagnosticIdentity]diagnosticGroup)
	for _, packageName := range packages {
		retained := make([]string, 0, len(current.errors[packageName]))
		for _, diagnostic := range current.errors[packageName] {
			expected := isExpectedMissingTargetError(current, peer, packageName, diagnostic)
			if !expected {
				retained = append(retained, diagnostic)
			}
		}
		if len(retained) == 0 {
			continue
		}
		repoPackage, err := current.cells.toRepoPath(packageName)
		if err != nil {
			return nil, err
		}
		identity := diagnosticIdentity{external: true, path: packageName}
		if repoPackage != nil {
			identity = diagnosticIdentity{path: *repoPackage}
		}
		group, exists := result[identity]
		if !exists {
			group.displayPackage = packageName
		}
		group.diagnostics = append(group.diagnostics, retained...)
		result[identity] = group
	}
	return result, nil
}

func isExpectedMissingTargetError(missing, present *snapshot, packageName, diagnostic string) bool {
	names, ok := parseUnknownTargetDiagnostic(packageName, diagnostic)
	if !ok || len(names) == 0 {
		return false
	}
	repoPackage, err := missing.cells.toRepoPath(packageName)
	if err != nil || repoPackage == nil {
		return false
	}
	for _, name := range names {
		missingHas := false
		for _, candidate := range missing.targets {
			if candidate.repoPackage == *repoPackage && candidate.name == name {
				missingHas = true
				break
			}
		}
		presentHas := false
		for _, candidate := range present.targets {
			if candidate.repoPackage == *repoPackage && candidate.name == name {
				presentHas = true
				break
			}
		}
		if missingHas || !presentHas {
			return false
		}
	}
	return true
}

type ciPatterns struct {
	srcs      globList
	mustMatch globList
}

func compileCIPatterns(graph *graph) (map[string]ciPatterns, error) {
	result := make(map[string]ciPatterns, len(graph.targets))
	for _, label := range sortedTargetLabels(graph.targets) {
		target := graph.targets[label]
		srcs, err := compileGlobList(target.ciSrcs, target.label, "ci_srcs")
		if err != nil {
			return nil, err
		}
		mustMatch, err := compileGlobList(target.ciSrcsMustMatch, target.label, "ci_srcs_must_match")
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
				depth:       item.depth,
				reason:      item.reason,
				affectedDep: item.affectedDep,
			})
		}
		unionTarget, exists := graph.target(item.target)
		if (depthLimit != nil && item.depth >= *depthLimit) || (exists && stopsUpstreamPropagation(unionTarget)) {
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

func stopsUpstreamPropagation(target target) bool {
	for _, label := range target.labels {
		if label == "ci:dangerously_skip_upstream" {
			return true
		}
	}
	return false
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

func isGlobalConfiguration(path string) bool {
	name := pathBase(path)
	if name == ".buckroot" || strings.HasSuffix(name, ".buckconfig") || strings.HasSuffix(name, ".bcfg") {
		return true
	}
	for _, component := range strings.Split(path, "/") {
		if component == ".buckconfig.d" || component == "buckconfigs" {
			return true
		}
	}
	return path == "buck/mode" || strings.HasPrefix(path, "buck/mode/")
}

func isBuildFile(name string) bool   { return name == "BUILD" || name == "BUCK" || name == "BUCK.v2" }
func isPackageFile(name string) bool { return name == "PACKAGE" || name == "PACKAGE.v2" }

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
