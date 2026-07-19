// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"math"
	"sort"
	"strings"
)

const (
	topPackageCount   = 10
	largestGraphCount = 10
)

// analyze reduces a raw buck2 report to the processed Report. All maps are
// walked in sorted order so identical inputs produce identical reports.
func analyze(raw *rawReport) *Report {
	report := &Report{
		FormatVersion: formatVersion,
		Build: BuildInfo{
			ID:          raw.TraceID,
			Status:      statusFailed,
			ProjectRoot: raw.ProjectRoot,
			Truncated:   raw.Truncated,
		},
	}
	if raw.Success {
		report.Build.Status = statusSuccess
	}

	targets := sortedKeys(raw.Results)
	summary := &report.Summary
	cells := make(map[string]*GroupCount)
	packages := make(map[string]*GroupCount)
	configurations := make(map[string]*GroupCount)
	var graphed []TargetNodes
	var totalNodes int64

	for _, target := range targets {
		entry := raw.Results[target]
		failed := false
		switch entry.Success {
		case "SUCCESS":
			summary.Succeeded++
		case "FAIL":
			summary.Failed++
			failed = true
		default:
			if summary.OtherOutcomes == nil {
				summary.OtherOutcomes = make(map[string]int)
			}
			summary.OtherOutcomes[entry.Success]++
		}
		for _, paths := range entry.Outputs {
			summary.DefaultOutputs += len(paths)
		}
		for _, paths := range entry.OtherOutputs {
			summary.OtherOutputs += len(paths)
		}
		bumpGroup(cells, cellOf(target), failed)
		bumpGroup(packages, packageOf(target), failed)
		for configuration := range entry.Configured {
			bumpGroup(configurations, displayConfiguration(configuration), failed)
		}
		if entry.ConfiguredGraphSize != nil {
			totalNodes += *entry.ConfiguredGraphSize
			graphed = append(graphed, TargetNodes{Target: target, Nodes: *entry.ConfiguredGraphSize})
		}
	}

	// With --build-report-options fill-out-failures, targets that failed
	// before producing a results entry still appear in the failures map.
	for _, target := range sortedKeys(raw.Failures) {
		if _, known := raw.Results[target]; known {
			continue
		}
		summary.Failed++
		bumpGroup(cells, cellOf(target), true)
		bumpGroup(packages, packageOf(target), true)
	}

	summary.TotalTargets = summary.Succeeded + summary.Failed + mapSum(summary.OtherOutcomes)
	summary.Configurations = len(configurations)
	if summary.TotalTargets > 0 {
		summary.SuccessRatePct = roundTenth(float64(summary.Succeeded) / float64(summary.TotalTargets) * 100)
	}

	report.Graph = graphStats(graphed, totalNodes)
	report.Breakdowns = Breakdowns{
		ByCell:      finishGroups(cells, summary.TotalTargets, 0),
		TopPackages: finishGroups(packages, summary.TotalTargets, topPackageCount),
	}
	if len(configurations) > 1 {
		report.Breakdowns.ByConfiguration = finishGroups(configurations, 0, 0)
	}
	report.Failures = collectFailures(raw, targets)
	return report
}

// causeKey identifies a root cause. Errors carrying a cause index group by
// it; errors without one (older reports, fill-out-failures entries) group by
// their message text.
type causeKey struct {
	indexed bool
	index   int64
	message string
}

func (e rawError) causeKey(table stringTable) causeKey {
	if e.CauseIndex != nil {
		return causeKey{indexed: true, index: *e.CauseIndex}
	}
	return causeKey{message: e.resolvedMessage(table)}
}

type failureGroup struct {
	failure Failure
	tags    map[string]struct{}
	seen    map[FailedTarget]struct{}
}

// collectFailures gathers errors from every level of the report — analysis
// errors on the entry, action errors on each configured build, and the
// legacy failures map — and folds them into one Failure per root cause.
func collectFailures(raw *rawReport, targets []string) []Failure {
	table := raw.Strings
	groups := make(map[causeKey]*failureGroup)
	var order []causeKey
	attributed := make(map[string]struct{})

	addError := func(target, configuration string, item rawError) {
		key := item.causeKey(table)
		group, ok := groups[key]
		if !ok {
			group = &failureGroup{
				failure: Failure{Message: item.resolvedMessage(table)},
				tags:    make(map[string]struct{}),
				seen:    make(map[FailedTarget]struct{}),
			}
			groups[key] = group
			order = append(order, key)
		}
		// Errors sharing a cause do not all carry the same detail: the
		// target that owns the failed action has the action error, its
		// dependents only reference the cause. Keep the richest data seen.
		if group.failure.Category == "" {
			group.failure.Category = item.ErrorCategory
		}
		if group.failure.Action == nil {
			group.failure.Action = item.ActionError.detail(table)
		}
		for _, tag := range item.ErrorTags {
			group.tags[tag] = struct{}{}
		}
		failedTarget := FailedTarget{Target: target, Configuration: configuration}
		if _, dup := group.seen[failedTarget]; !dup {
			group.seen[failedTarget] = struct{}{}
			group.failure.Targets = append(group.failure.Targets, failedTarget)
		}
		attributed[target] = struct{}{}
	}

	for _, target := range targets {
		entry := raw.Results[target]
		for _, item := range entry.Errors {
			addError(target, "", item)
		}
		for _, configuration := range sortedKeys(entry.Configured) {
			for _, item := range entry.Configured[configuration].Errors {
				addError(target, configuration, item)
			}
		}
	}

	for _, target := range sortedKeys(raw.Failures) {
		if _, done := attributed[target]; done {
			continue
		}
		addError(target, "", rawError{direct: raw.Failures[target]})
	}

	// Failed targets with no recorded error anywhere still deserve a line.
	var orphans []FailedTarget
	for _, target := range targets {
		if _, done := attributed[target]; done {
			continue
		}
		if raw.Results[target].Success == "FAIL" {
			orphans = append(orphans, FailedTarget{Target: target})
		}
	}

	failures := make([]Failure, 0, len(order)+1)
	for _, key := range order {
		group := groups[key]
		group.failure.Tags = setToSorted(group.tags)
		sortFailedTargets(group.failure.Targets)
		failures = append(failures, group.failure)
	}
	if len(orphans) > 0 {
		failures = append(failures, Failure{
			Message: "target failed but the report records no error details",
			Targets: orphans,
		})
	}
	sort.SliceStable(failures, func(left, right int) bool {
		if len(failures[left].Targets) != len(failures[right].Targets) {
			return len(failures[left].Targets) > len(failures[right].Targets)
		}
		return failures[left].Message < failures[right].Message
	})
	return failures
}

func graphStats(graphed []TargetNodes, totalNodes int64) *GraphStats {
	if len(graphed) == 0 {
		return nil
	}
	count := int64(len(graphed))
	sizes := make([]int64, len(graphed))
	for index, item := range graphed {
		sizes[index] = item.Nodes
	}
	sort.Slice(sizes, func(left, right int) bool { return sizes[left] < sizes[right] })

	var median int64
	if len(sizes)%2 == 1 {
		median = sizes[len(sizes)/2]
	} else {
		median = (sizes[len(sizes)/2-1] + sizes[len(sizes)/2] + 1) / 2
	}

	largest := make([]TargetNodes, len(graphed))
	copy(largest, graphed)
	sort.Slice(largest, func(left, right int) bool {
		if largest[left].Nodes != largest[right].Nodes {
			return largest[left].Nodes > largest[right].Nodes
		}
		return largest[left].Target < largest[right].Target
	})
	if len(largest) > largestGraphCount {
		largest = largest[:largestGraphCount]
	}

	return &GraphStats{
		TotalNodes:  totalNodes,
		MeanNodes:   (totalNodes + count/2) / count,
		MedianNodes: median,
		MaxNodes:    sizes[len(sizes)-1],
		Largest:     largest,
	}
}

func bumpGroup(groups map[string]*GroupCount, name string, failed bool) {
	group, ok := groups[name]
	if !ok {
		group = &GroupCount{Name: name}
		groups[name] = group
	}
	group.Targets++
	if failed {
		group.Failed++
	}
}

func finishGroups(groups map[string]*GroupCount, total, limit int) []GroupCount {
	result := make([]GroupCount, 0, len(groups))
	for _, group := range groups {
		if total > 0 {
			group.Percent = roundTenth(float64(group.Targets) / float64(total) * 100)
		}
		result = append(result, *group)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].Targets != result[right].Targets {
			return result[left].Targets > result[right].Targets
		}
		return result[left].Name < result[right].Name
	})
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result
}

// cellOf extracts the cell from a target label like `depot//pkg/path:name`.
func cellOf(label string) string {
	if cell, _, found := strings.Cut(label, "//"); found && cell != "" {
		return cell
	}
	return "unknown"
}

// packageOf extracts the cell-qualified package from a target label.
func packageOf(label string) string {
	if pkg, _, found := strings.Cut(label, ":"); found {
		return pkg
	}
	return label
}

func sortedKeys[Value any](m map[string]Value) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortFailedTargets(targets []FailedTarget) {
	sort.Slice(targets, func(left, right int) bool {
		if targets[left].Target != targets[right].Target {
			return targets[left].Target < targets[right].Target
		}
		return targets[left].Configuration < targets[right].Configuration
	})
}

func setToSorted(set map[string]struct{}) []string {
	if len(set) == 0 {
		return nil
	}
	result := make([]string, 0, len(set))
	for item := range set {
		result = append(result, item)
	}
	sort.Strings(result)
	return result
}

func mapSum(m map[string]int) int {
	total := 0
	for _, value := range m {
		total += value
	}
	return total
}

func roundTenth(value float64) float64 {
	return math.Round(value*10) / 10
}
