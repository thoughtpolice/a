// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// formatVersion identifies the processed report schema. Version 1.x was
// produced by the retired TypeScript implementation and is not accepted.
const formatVersion = "2.0.0"

// Report is the processed form of a build report: everything the renderers
// need, and nothing tied to buck2's raw encoding. It is also the JSON output
// schema, so a report written with `--format json` can be fed back in later
// and re-rendered as console or markdown output.
type Report struct {
	FormatVersion string      `json:"format_version"`
	Build         BuildInfo   `json:"build"`
	Summary       Summary     `json:"summary"`
	Graph         *GraphStats `json:"graph,omitempty"`
	Breakdowns    Breakdowns  `json:"breakdowns"`
	Failures      []Failure   `json:"failures"`
}

type BuildInfo struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	ProjectRoot string `json:"project_root"`
	Truncated   bool   `json:"truncated,omitempty"`
}

const (
	statusSuccess = "SUCCESS"
	statusFailed  = "FAILED"
)

type Summary struct {
	TotalTargets int `json:"total_targets"`
	Succeeded    int `json:"succeeded"`
	Failed       int `json:"failed"`
	// OtherOutcomes counts targets whose outcome was neither SUCCESS nor
	// FAIL, keyed by the raw outcome string, so new buck2 outcomes surface
	// instead of disappearing.
	OtherOutcomes  map[string]int `json:"other_outcomes,omitempty"`
	SuccessRatePct float64        `json:"success_rate_pct"`
	DefaultOutputs int            `json:"default_outputs"`
	OtherOutputs   int            `json:"other_outputs,omitempty"`
	Configurations int            `json:"configurations"`
}

// GraphStats summarizes configured graph sizes. It is absent for reports
// that carry no graph size data, such as those written by `buck2 test`.
type GraphStats struct {
	TotalNodes  int64         `json:"total_nodes"`
	MeanNodes   int64         `json:"mean_nodes"`
	MedianNodes int64         `json:"median_nodes"`
	MaxNodes    int64         `json:"max_nodes"`
	Largest     []TargetNodes `json:"largest"`
}

type TargetNodes struct {
	Target string `json:"target"`
	Nodes  int64  `json:"nodes"`
}

type Breakdowns struct {
	ByCell      []GroupCount `json:"by_cell"`
	TopPackages []GroupCount `json:"top_packages"`
	// ByConfiguration is only populated when targets were built in more
	// than one configuration; a single configuration carries no signal.
	ByConfiguration []GroupCount `json:"by_configuration,omitempty"`
}

type GroupCount struct {
	Name    string  `json:"name"`
	Targets int     `json:"targets"`
	Failed  int     `json:"failed,omitempty"`
	Percent float64 `json:"percent,omitempty"`
}

// Failure is one root cause and every target it took down. Errors sharing a
// buck2 cause index are folded into a single Failure.
type Failure struct {
	// Category is buck2's blame classification: USER or INFRA.
	Category string         `json:"category,omitempty"`
	Tags     []string       `json:"tags,omitempty"`
	Message  string         `json:"message"`
	Action   *ActionDetail  `json:"action,omitempty"`
	Targets  []FailedTarget `json:"targets"`
}

// ActionDetail describes a failed action with its captured output streams.
type ActionDetail struct {
	Category   string `json:"category"`
	Identifier string `json:"identifier,omitempty"`
	Owner      string `json:"owner,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
	Stdout     string `json:"stdout,omitempty"`
}

type FailedTarget struct {
	Target        string `json:"target"`
	Configuration string `json:"configuration,omitempty"`
}

// loadReport parses either a raw buck2 build report or a processed report
// previously written by `--format json`, detected by the format_version
// field that only processed reports carry.
func loadReport(data []byte) (*Report, error) {
	var probe struct {
		FormatVersion string `json:"format_version"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, fmt.Errorf("parse report: %w", err)
	}

	switch {
	case probe.FormatVersion == "":
		raw, err := parseRawReport(data)
		if err != nil {
			return nil, err
		}
		return analyze(raw), nil
	case strings.HasPrefix(probe.FormatVersion, "2."):
		var report Report
		if err := json.Unmarshal(data, &report); err != nil {
			return nil, fmt.Errorf("parse processed report: %w", err)
		}
		if report.Failures == nil {
			report.Failures = []Failure{}
		}
		return &report, nil
	default:
		return nil, fmt.Errorf("unsupported processed report version %q (this tool reads raw buck2 reports and version 2.x processed reports)", probe.FormatVersion)
	}
}

func (r *Report) marshalJSON() (string, error) {
	encoded, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode report: %w", err)
	}
	return string(encoded) + "\n", nil
}
