// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"strings"
)

// renderMarkdown writes the full report as GitHub-flavored markdown. Unlike
// the console renderer it never truncates failure detail: markdown output is
// meant for CI artifacts and step summaries where completeness wins.
func renderMarkdown(w io.Writer, report *Report) {
	fmt.Fprintln(w, "# Buck2 Build Report")
	fmt.Fprintln(w)

	status := "✅ SUCCESS"
	if report.Build.Status != statusSuccess {
		status = "❌ FAILED"
	}
	fmt.Fprintln(w, "| Field | Value |")
	fmt.Fprintln(w, "|-------|-------|")
	fmt.Fprintf(w, "| Build ID | `%s` |\n", report.Build.ID)
	fmt.Fprintf(w, "| Status | %s |\n", status)
	fmt.Fprintf(w, "| Project root | `%s` |\n", report.Build.ProjectRoot)
	if report.Build.Truncated {
		fmt.Fprintln(w, "| Truncated | ⚠ yes — every count below is a lower bound |")
	}
	fmt.Fprintln(w)

	renderMarkdownSummary(w, report)
	renderMarkdownGraph(w, report.Graph)
	renderMarkdownGroups(w, "Cells", report.Breakdowns.ByCell, true)
	renderMarkdownGroups(w, "Top packages", report.Breakdowns.TopPackages, true)
	renderMarkdownGroups(w, "Configurations", report.Breakdowns.ByConfiguration, false)
	renderMarkdownFailures(w, report)
}

func renderMarkdownSummary(w io.Writer, report *Report) {
	summary := report.Summary
	fmt.Fprintln(w, "## Summary")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "| Metric | Value |")
	fmt.Fprintln(w, "|--------|-------|")
	fmt.Fprintf(w, "| Total targets | **%s** |\n", withCommas(int64(summary.TotalTargets)))
	fmt.Fprintf(w, "| Succeeded | %s (%s) |\n", withCommas(int64(summary.Succeeded)), percent(summary.SuccessRatePct))
	fmt.Fprintf(w, "| Failed | %s |\n", withCommas(int64(summary.Failed)))
	for _, outcome := range sortedKeys(summary.OtherOutcomes) {
		fmt.Fprintf(w, "| %s | %d |\n", outcome, summary.OtherOutcomes[outcome])
	}
	fmt.Fprintf(w, "| Default outputs | %s |\n", withCommas(int64(summary.DefaultOutputs)))
	if summary.OtherOutputs > 0 {
		fmt.Fprintf(w, "| Other outputs | %s |\n", withCommas(int64(summary.OtherOutputs)))
	}
	fmt.Fprintf(w, "| Configurations | %d |\n", summary.Configurations)
	fmt.Fprintln(w)
}

func renderMarkdownGraph(w io.Writer, graph *GraphStats) {
	if graph == nil {
		return
	}
	fmt.Fprintln(w, "## Dependency graphs")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "| Metric | Nodes |")
	fmt.Fprintln(w, "|--------|-------|")
	fmt.Fprintf(w, "| Total | %s |\n", withCommas(graph.TotalNodes))
	fmt.Fprintf(w, "| Mean | %s |\n", withCommas(graph.MeanNodes))
	fmt.Fprintf(w, "| Median | %s |\n", withCommas(graph.MedianNodes))
	fmt.Fprintf(w, "| Max | %s |\n", withCommas(graph.MaxNodes))
	fmt.Fprintln(w)
	if len(graph.Largest) == 0 {
		return
	}
	fmt.Fprintln(w, "### Largest")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "| Rank | Target | Nodes |")
	fmt.Fprintln(w, "|------|--------|-------|")
	for index, item := range graph.Largest {
		fmt.Fprintf(w, "| %d | `%s` | %s |\n", index+1, item.Target, withCommas(item.Nodes))
	}
	fmt.Fprintln(w)
}

func renderMarkdownGroups(w io.Writer, title string, groups []GroupCount, bars bool) {
	if len(groups) < 2 {
		return
	}
	fmt.Fprintf(w, "## %s\n", title)
	fmt.Fprintln(w)
	if bars {
		fmt.Fprintln(w, "| Name | Targets | Failed | Share | |")
		fmt.Fprintln(w, "|------|---------|--------|-------|--|")
	} else {
		fmt.Fprintln(w, "| Name | Targets | Failed |")
		fmt.Fprintln(w, "|------|---------|--------|")
	}
	for _, group := range groups {
		if bars {
			fmt.Fprintf(w, "| `%s` | %d | %d | %s | %s |\n",
				group.Name, group.Targets, group.Failed, percent(group.Percent), barChart(group.Percent, 20))
		} else {
			fmt.Fprintf(w, "| `%s` | %d | %d |\n", group.Name, group.Targets, group.Failed)
		}
	}
	fmt.Fprintln(w)
}

// barChart renders pct as a fixed-width bar, e.g. "██████░░░░".
func barChart(pct float64, width int) string {
	filled := int(pct/100*float64(width) + 0.5)
	if filled > width {
		filled = width
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
}

func renderMarkdownFailures(w io.Writer, report *Report) {
	if len(report.Failures) == 0 {
		return
	}
	fmt.Fprintln(w, "## Failures")
	fmt.Fprintln(w)
	fmt.Fprintf(w, "%d root %s affecting %d %s.\n",
		len(report.Failures), plural(len(report.Failures), "cause", "causes"),
		report.Summary.Failed, plural(report.Summary.Failed, "target", "targets"))
	fmt.Fprintln(w)

	for index, failure := range report.Failures {
		headline := stripConfigurationHashes(firstLine(failure.Message))
		if failure.Category != "" {
			headline = "[" + failure.Category + "] " + headline
		}
		fmt.Fprintf(w, "### %d. %s\n", index+1, headline)
		fmt.Fprintln(w)
		if len(failure.Tags) > 0 {
			fmt.Fprintf(w, "*Tags: %s*\n", strings.Join(failure.Tags, ", "))
			fmt.Fprintln(w)
		}
		if action := failure.Action; action != nil {
			renderMarkdownAction(w, action)
		} else if body := strings.TrimSpace(failure.Message); body != "" {
			fencedBlock(w, body)
		}
		fmt.Fprintf(w, "**Affected %s (%d):**\n", plural(len(failure.Targets), "target", "targets"), len(failure.Targets))
		fmt.Fprintln(w)
		for _, target := range failure.Targets {
			if cfg := displayConfiguration(target.Configuration); cfg != "" {
				fmt.Fprintf(w, "- `%s` (%s)\n", target.Target, cfg)
			} else {
				fmt.Fprintf(w, "- `%s`\n", target.Target)
			}
		}
		fmt.Fprintln(w)
	}
}

func renderMarkdownAction(w io.Writer, action *ActionDetail) {
	name := action.Category
	if action.Identifier != "" {
		name += " " + action.Identifier
	}
	fmt.Fprintf(w, "Action `%s` failed", name)
	if action.Owner != "" {
		fmt.Fprintf(w, " for `%s`", stripConfigurationHashes(action.Owner))
	}
	if action.Reason != "" {
		fmt.Fprintf(w, ": %s", firstLine(action.Reason))
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w)
	if strings.TrimSpace(action.Stderr) != "" {
		fmt.Fprintln(w, "**stderr:**")
		fmt.Fprintln(w)
		fencedBlock(w, action.Stderr)
	}
	if strings.TrimSpace(action.Stdout) != "" {
		fmt.Fprintln(w, "**stdout:**")
		fmt.Fprintln(w)
		fencedBlock(w, action.Stdout)
	}
}

// fencedBlock writes content inside a code fence long enough not to clash
// with any backtick run inside the content itself.
func fencedBlock(w io.Writer, content string) {
	fence := "```"
	for strings.Contains(content, fence) {
		fence += "`"
	}
	fmt.Fprintf(w, "%stext\n%s\n%s\n", fence, strings.TrimRight(content, "\n"), fence)
	fmt.Fprintln(w)
}
