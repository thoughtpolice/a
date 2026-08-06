// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"sort"
	"strings"
)

type labelSet map[string]struct{}
type graphIndex map[string]labelSet

// graph contains union indexes for direct impact and head-only reverse edges
// for propagation into the graph that will actually be built.
type graph struct {
	targets         map[string]target
	baseTargets     map[string]target
	headTargets     map[string]target
	inputs          graphIndex
	packages        graphIndex
	rules           graphIndex
	imports         map[string]labelSet
	reverseImports  map[string]labelSet
	headReverseDeps graphIndex
	repoFiles       map[string]fileNode
}

func newGraph(base, head *snapshot) *graph {
	result := &graph{
		targets:        make(map[string]target, len(base.targets)+len(head.targets)),
		baseTargets:    base.targets,
		headTargets:    head.targets,
		inputs:         make(graphIndex),
		packages:       make(graphIndex),
		rules:          make(graphIndex),
		imports:        make(map[string]labelSet),
		reverseImports: make(map[string]labelSet),
		repoFiles:      make(map[string]fileNode, len(base.files)+len(head.files)),
	}
	for label, target := range base.targets {
		result.targets[label] = target
	}
	for label, target := range head.targets {
		result.targets[label] = target
	}
	for _, file := range base.files {
		if file.path != nil {
			result.repoFiles[*file.path] = file
		}
	}
	for _, file := range head.files {
		if file.path != nil {
			result.repoFiles[*file.path] = file
		}
	}
	indexDirect(base, result.inputs, result.packages, result.rules)
	indexDirect(head, result.inputs, result.packages, result.rules)
	indexImports(base, result.imports, result.reverseImports)
	indexImports(head, result.imports, result.reverseImports)

	candidates := make([]string, 0, len(result.targets))
	for label := range result.targets {
		candidates = append(candidates, label)
	}
	sort.Strings(candidates)
	result.headReverseDeps = buildReverseDeps(head.targets, candidates)
	return result
}

func (g *graph) target(label string) (target, bool) {
	result, ok := g.targets[label]
	return result, ok
}

func (g *graph) headTarget(label string) (target, bool) {
	result, ok := g.headTargets[label]
	return result, ok
}

func (g *graph) labelsForInput(path string) labelSet   { return g.inputs[path] }
func (g *graph) labelsForPackage(path string) labelSet { return g.packages[path] }
func (g *graph) labelsForRule(path string) labelSet    { return g.rules[path] }

func (g *graph) fileByPath(path string) (fileNode, bool) {
	result, ok := g.repoFiles[path]
	return result, ok
}

func (g *graph) headDependents(label string) labelSet {
	return cloneSet(g.headReverseDeps[label])
}

func (g *graph) transitiveImporters(changed []string) labelSet {
	return propagate(g.reverseImports, changed, nil)
}

func indexDirect(input *snapshot, inputs, packages, rules graphIndex) {
	for _, target := range input.targets {
		insertIndex(packages, target.repoPackage, target.label)
		for _, source := range target.inputs {
			insertIndex(inputs, source, target.label)
		}
		if rule, ok := target.ruleFile(); ok {
			if path, err := input.cells.toRepoPath(rule); err == nil && path != nil {
				insertIndex(rules, *path, target.label)
			}
		}
	}
}

func indexImports(input *snapshot, imports, reverseImports map[string]labelSet) {
	for _, file := range input.files {
		if file.path == nil {
			continue
		}
		importer := *file.path
		if imports[importer] == nil {
			imports[importer] = make(labelSet)
		}
		for _, imported := range file.imports {
			imports[importer][imported] = struct{}{}
			insertSet(reverseImports, imported, importer)
		}
	}
}

func buildReverseDeps(targets map[string]target, ciDepCandidates []string) graphIndex {
	result := make(graphIndex, len(targets))
	for _, target := range targets {
		for _, dependency := range target.deps {
			insertIndex(result, dependency, target.label)
		}
	}
	for _, dependent := range targets {
		for _, rawPattern := range dependent.ciDeps {
			pattern := makeAbsolutePattern(rawPattern, dependent.packageName)
			for _, candidate := range ciDepCandidates {
				if targetPatternMatches(pattern, candidate) {
					insertIndex(result, candidate, dependent.label)
				}
			}
		}
	}
	for _, hint := range targets {
		if ruleShortName(hint.ruleType) != "ci_hint" {
			continue
		}
		destinationName, ok := strings.CutPrefix(hint.name, "ci_hint@")
		if !ok {
			continue
		}
		destination := hint.packageName + ":" + destinationName
		if _, ok := targets[destination]; ok {
			insertIndex(result, hint.label, destination)
		}
	}
	return result
}

func makeAbsolutePattern(pattern, packageName string) string {
	if strings.HasPrefix(pattern, ":") {
		return packageName + pattern
	}
	if relative, ok := strings.CutPrefix(pattern, "//"); ok {
		if cell, _, ok := strings.Cut(packageName, "//"); ok {
			return cell + "//" + relative
		}
	}
	return pattern
}

func targetPatternMatches(pattern, label string) bool {
	if _, name, ok := strings.Cut(pattern, ":"); ok && name != "" {
		return pattern == label
	}
	if packageName, ok := strings.CutSuffix(pattern, ":"); ok {
		rest, ok := strings.CutPrefix(label, packageName)
		return ok && strings.HasPrefix(rest, ":")
	}
	if prefix, ok := strings.CutSuffix(pattern, "/..."); ok {
		rest, ok := strings.CutPrefix(label, prefix)
		return ok && (strings.HasPrefix(rest, ":") || strings.HasPrefix(rest, "/"))
	}
	if prefix, ok := strings.CutSuffix(pattern, "..."); ok {
		rest, ok := strings.CutPrefix(label, prefix)
		return ok && (strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, ":") || strings.HasSuffix(prefix, "//"))
	}
	return pattern == label
}

func ruleShortName(ruleType string) string {
	if separator := strings.LastIndexByte(ruleType, ':'); separator >= 0 {
		return ruleType[separator+1:]
	}
	return ruleType
}

func insertIndex(index graphIndex, key, label string) {
	insertSet(index, key, label)
}

func insertSet(index map[string]labelSet, key, value string) {
	values := index[key]
	if values == nil {
		values = make(labelSet)
		index[key] = values
	}
	values[value] = struct{}{}
}

func cloneSet(input labelSet) labelSet {
	result := make(labelSet, len(input))
	for value := range input {
		result[value] = struct{}{}
	}
	return result
}

func propagate(edges map[string]labelSet, seeds []string, depthLimit *int) labelSet {
	seen := make(labelSet, len(seeds))
	frontier := make([]string, 0, len(seeds))
	for _, seed := range seeds {
		if _, exists := seen[seed]; !exists {
			seen[seed] = struct{}{}
			frontier = append(frontier, seed)
		}
	}
	depth := 0
	for len(frontier) != 0 && (depthLimit == nil || depth < *depthLimit) {
		next := make([]string, 0)
		for _, node := range frontier {
			for dependent := range edges[node] {
				if _, exists := seen[dependent]; exists {
					continue
				}
				seen[dependent] = struct{}{}
				next = append(next, dependent)
			}
		}
		frontier = next
		depth++
	}
	return seen
}
