// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"strings"
)

// Caps applied to console failure detail unless --all is given. Complete
// details are always available via --all, --format json, or markdown.
const (
	consoleMaxCauses       = 20
	consoleMaxMessageLines = 20
	consoleMaxStreamLines  = 15
	consoleMaxTargets      = 10
	consoleTargetWidth     = 76
)

type consoleRenderer struct {
	color bool
	all   bool
}

func (r consoleRenderer) sgr(code, value string) string {
	if !r.color || value == "" {
		return value
	}
	return "\x1b[" + code + "m" + value + "\x1b[0m"
}

func (r consoleRenderer) bold(value string) string   { return r.sgr("1", value) }
func (r consoleRenderer) dim(value string) string    { return r.sgr("2", value) }
func (r consoleRenderer) red(value string) string    { return r.sgr("31", value) }
func (r consoleRenderer) green(value string) string  { return r.sgr("32", value) }
func (r consoleRenderer) yellow(value string) string { return r.sgr("33", value) }
func (r consoleRenderer) blue(value string) string   { return r.sgr("34", value) }

func (r consoleRenderer) header(w io.Writer, title string) {
	fmt.Fprintf(w, "\n%s\n%s\n", r.bold(title), r.dim(strings.Repeat("─", 50)))
}

func renderConsole(w io.Writer, report *Report, color, all bool) {
	r := consoleRenderer{color: color, all: all}

	r.header(w, "📊 Buck2 Build Report")
	fmt.Fprintf(w, "Build ID: %s\n", r.blue(report.Build.ID))
	status := r.green("✓ SUCCESS")
	if report.Build.Status != statusSuccess {
		status = r.red("✗ FAILED")
	}
	fmt.Fprintf(w, "Status:   %s\n", status)
	fmt.Fprintf(w, "Project:  %s\n", report.Build.ProjectRoot)
	if report.Build.Truncated {
		fmt.Fprintf(w, "%s\n", r.yellow("⚠ buck2 truncated this report; every count below is a lower bound"))
	}

	r.renderSummary(w, report)
	r.renderBreakdowns(w, report)
	r.renderGraph(w, report.Graph)
	r.renderFailures(w, report)
	fmt.Fprintln(w)
}

func (r consoleRenderer) renderSummary(w io.Writer, report *Report) {
	summary := report.Summary
	r.header(w, "📈 Summary")

	line := fmt.Sprintf("%s total", r.bold(withCommas(int64(summary.TotalTargets))))
	if summary.TotalTargets > 0 {
		line += fmt.Sprintf(" — %s succeeded (%s)",
			r.green(withCommas(int64(summary.Succeeded))), percent(summary.SuccessRatePct))
		if summary.Failed > 0 {
			line += fmt.Sprintf(", %s failed", r.red(withCommas(int64(summary.Failed))))
		}
		for _, outcome := range sortedKeys(summary.OtherOutcomes) {
			line += fmt.Sprintf(", %d %s", summary.OtherOutcomes[outcome], strings.ToLower(outcome))
		}
	}
	fmt.Fprintf(w, "Targets:   %s\n", line)

	artifacts := fmt.Sprintf("%s default %s", withCommas(int64(summary.DefaultOutputs)),
		plural(summary.DefaultOutputs, "output", "outputs"))
	if summary.OtherOutputs > 0 {
		artifacts += fmt.Sprintf(" (+%s other)", withCommas(int64(summary.OtherOutputs)))
	}
	fmt.Fprintf(w, "Artifacts: %s\n", artifacts)

	if graph := report.Graph; graph != nil {
		fmt.Fprintf(w, "Graph:     %s nodes · mean %s · median %s · max %s\n",
			withCommas(graph.TotalNodes), withCommas(graph.MeanNodes),
			withCommas(graph.MedianNodes), withCommas(graph.MaxNodes))
	}
	if summary.Configurations > 1 {
		fmt.Fprintf(w, "Configs:   %d distinct configurations\n", summary.Configurations)
	}
}

func (r consoleRenderer) renderBreakdowns(w io.Writer, report *Report) {
	breakdowns := report.Breakdowns
	if len(breakdowns.ByCell) > 1 {
		r.header(w, "📦 Cells")
		r.renderGroups(w, breakdowns.ByCell)
	}
	if len(breakdowns.TopPackages) > 1 {
		title := "🎯 Top packages"
		if len(breakdowns.TopPackages) == topPackageCount {
			title += fmt.Sprintf(" (top %d by target count)", topPackageCount)
		}
		r.header(w, title)
		r.renderGroups(w, breakdowns.TopPackages)
	}
	if len(breakdowns.ByConfiguration) > 0 {
		r.header(w, "🧩 Configurations")
		r.renderGroups(w, breakdowns.ByConfiguration)
	}
}

func (r consoleRenderer) renderGroups(w io.Writer, groups []GroupCount) {
	width := 0
	for _, group := range groups {
		if len(group.Name) > width {
			width = len(group.Name)
		}
	}
	for _, group := range groups {
		fmt.Fprintf(w, "%-*s %5d", width, group.Name, group.Targets)
		if group.Percent > 0 {
			fmt.Fprintf(w, "  (%s)", percent(group.Percent))
		}
		if group.Failed > 0 {
			fmt.Fprintf(w, "  %s", r.red(fmt.Sprintf("✗ %d failed", group.Failed)))
		}
		fmt.Fprintln(w)
	}
}

func (r consoleRenderer) renderGraph(w io.Writer, graph *GraphStats) {
	if graph == nil || len(graph.Largest) == 0 {
		return
	}
	r.header(w, "📏 Largest dependency graphs")
	largest := graph.Largest
	if !r.all && len(largest) > 5 {
		largest = largest[:5]
	}
	for _, item := range largest {
		fmt.Fprintf(w, "%7s nodes  %s\n", withCommas(item.Nodes),
			r.dim(shortenTarget(item.Target, consoleTargetWidth)))
	}
}

func (r consoleRenderer) renderFailures(w io.Writer, report *Report) {
	failures := report.Failures
	if len(failures) == 0 {
		return
	}
	r.header(w, fmt.Sprintf("❌ Failures — %d root %s, %d failed %s",
		len(failures), plural(len(failures), "cause", "causes"),
		report.Summary.Failed, plural(report.Summary.Failed, "target", "targets")))

	shown, hidden := len(failures), 0
	if !r.all && shown > consoleMaxCauses {
		shown, hidden = consoleMaxCauses, len(failures)-consoleMaxCauses
	}
	for index, failure := range failures[:shown] {
		if index > 0 {
			fmt.Fprintln(w)
		}
		r.renderFailure(w, index+1, failure)
	}
	if hidden > 0 {
		fmt.Fprintf(w, "\n%s\n", r.dim(fmt.Sprintf("... %d more root %s (rerun with --all or --format json)",
			hidden, plural(hidden, "cause", "causes"))))
	}
}

func (r consoleRenderer) renderFailure(w io.Writer, ordinal int, failure Failure) {
	category := ""
	if failure.Category != "" {
		label := "[" + failure.Category + "] "
		if failure.Category == "INFRA" {
			category = r.yellow(label)
		} else {
			category = r.red(label)
		}
	}
	fmt.Fprintf(w, "%d) %s%s\n", ordinal, category, r.bold(stripConfigurationHashes(firstLine(failure.Message))))
	if len(failure.Tags) > 0 {
		fmt.Fprintf(w, "   %s\n", r.dim(strings.Join(failure.Tags, ", ")))
	}

	if action := failure.Action; action != nil {
		r.renderAction(w, action)
	} else {
		// Everything past the first line of the message, which already
		// served as the headline.
		lines := splitTrimmedLines(stripConfigurationHashes(failure.Message))
		if len(lines) > 1 {
			body := lines[1:]
			if !r.all {
				body, _ = headLines(body, consoleMaxMessageLines)
			}
			for _, line := range body {
				fmt.Fprintf(w, "   %s\n", line)
			}
			if dropped := len(lines) - 1 - len(body); dropped > 0 {
				fmt.Fprintf(w, "   %s\n", r.dim(fmt.Sprintf("... %d more %s (rerun with --all)",
					dropped, plural(dropped, "line", "lines"))))
			}
		}
	}

	targets := failure.Targets
	fmt.Fprintf(w, "   affects %d %s:\n", len(targets), plural(len(targets), "target", "targets"))
	shown := len(targets)
	if !r.all && shown > consoleMaxTargets {
		shown = consoleMaxTargets
	}
	for _, target := range targets[:shown] {
		suffix := ""
		if cfg := displayConfiguration(target.Configuration); cfg != "" && cfg != "cfg:<empty>" {
			suffix = " " + r.dim("("+cfg+")")
		}
		fmt.Fprintf(w, "   • %s%s\n", shortenTarget(target.Target, consoleTargetWidth), suffix)
	}
	if dropped := len(targets) - shown; dropped > 0 {
		fmt.Fprintf(w, "   %s\n", r.dim(fmt.Sprintf("... %d more %s (rerun with --all)",
			dropped, plural(dropped, "target", "targets"))))
	}
}

func (r consoleRenderer) renderAction(w io.Writer, action *ActionDetail) {
	if action.Reason != "" {
		fmt.Fprintf(w, "   %s\n", firstLine(action.Reason))
	}
	stream, name := action.Stderr, "stderr"
	if strings.TrimSpace(stream) == "" {
		stream, name = action.Stdout, "stdout"
	}
	lines := splitTrimmedLines(stream)
	if len(lines) == 0 {
		return
	}
	kept := lines
	dropped := 0
	if !r.all {
		kept, dropped = tailLines(lines, consoleMaxStreamLines)
	}
	fmt.Fprintf(w, "   %s\n", r.dim(name+":"))
	if dropped > 0 {
		fmt.Fprintf(w, "   %s %s\n", r.dim("│"), r.dim(fmt.Sprintf("... %d earlier %s omitted (rerun with --all)",
			dropped, plural(dropped, "line", "lines"))))
	}
	for _, line := range kept {
		fmt.Fprintf(w, "   %s %s\n", r.dim("│"), line)
	}
}
