// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// rawReport mirrors the JSON written by `buck2 build --build-report` and
// `buck2 test --build-report` (see build_report.rs in buck2). Only the fields
// this tool consumes are declared; unknown fields are ignored so the tool
// tolerates report format evolution such as the graph sketch fields.
type rawReport struct {
	TraceID     string              `json:"trace_id"`
	Success     bool                `json:"success"`
	Results     map[string]rawEntry `json:"results"`
	Failures    map[string]string   `json:"failures"`
	ProjectRoot string              `json:"project_root"`
	Truncated   bool                `json:"truncated"`
	Strings     stringTable         `json:"strings"`
}

// rawEntry is the per-target entry. Analysis errors (for example a missing
// target) appear in Errors, while errors from building a particular
// configuration appear under Configured, so both must be inspected.
type rawEntry struct {
	Success             string                        `json:"success"`
	Outputs             map[string][]string           `json:"outputs"`
	OtherOutputs        map[string][]string           `json:"other_outputs"`
	ConfiguredGraphSize *int64                        `json:"configured_graph_size"`
	Configured          map[string]rawConfiguredEntry `json:"configured"`
	Errors              []rawError                    `json:"errors"`
}

type rawConfiguredEntry struct {
	Success             string              `json:"success"`
	Outputs             map[string][]string `json:"outputs"`
	OtherOutputs        map[string][]string `json:"other_outputs"`
	ConfiguredGraphSize *int64              `json:"configured_graph_size"`
	Errors              []rawError          `json:"errors"`
}

// rawError is one build error. Message fields are keys into the report's
// string table, not the message text itself. Errors sharing a root cause
// carry the same CauseIndex, which is what allows one broken dependency to be
// reported once rather than once per broken dependent.
type rawError struct {
	MessageContent string          `json:"message_content"`
	ActionError    *rawActionError `json:"action_error"`
	ErrorTags      []string        `json:"error_tags"`
	CauseIndex     *int64          `json:"cause_index"`
	ErrorCategory  string          `json:"error_category"`

	// direct holds the message when the report used the historical encoding
	// of errors as plain strings instead of objects.
	direct string
}

func (e *rawError) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var message string
		if err := json.Unmarshal(trimmed, &message); err != nil {
			return err
		}
		*e = rawError{direct: message}
		return nil
	}
	type plain rawError
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*e = rawError(decoded)
	return nil
}

// resolvedMessage returns the error message text for this error.
func (e rawError) resolvedMessage(table stringTable) string {
	if e.direct != "" {
		return e.direct
	}
	return table.lookup(e.MessageContent)
}

type rawActionError struct {
	Name          rawActionName `json:"name"`
	Key           rawActionKey  `json:"key"`
	Digest        string        `json:"digest"`
	ErrorContent  string        `json:"error_content"`
	StderrContent string        `json:"stderr_content"`
	StdoutContent string        `json:"stdout_content"`
}

type rawActionName struct {
	Category   string `json:"category"`
	Identifier string `json:"identifier"`
}

type rawActionKey struct {
	Owner string `json:"owner"`
}

// detail resolves the interned message references into an ActionDetail.
func (a *rawActionError) detail(table stringTable) *ActionDetail {
	if a == nil {
		return nil
	}
	return &ActionDetail{
		Category:   a.Name.Category,
		Identifier: a.Name.Identifier,
		Owner:      a.Key.Owner,
		Reason:     table.lookup(a.ErrorContent),
		Stderr:     table.lookup(a.StderrContent),
		Stdout:     table.lookup(a.StdoutContent),
	}
}

// stringTable is the report-level interning table for error content.
type stringTable map[string]string

// lookup resolves an interned key. An empty key resolves to an empty string;
// a key missing from the table (a malformed or truncated report) resolves to
// a placeholder instead of failing the whole report.
func (t stringTable) lookup(key string) string {
	if key == "" {
		return ""
	}
	if value, ok := t[key]; ok {
		return value
	}
	return fmt.Sprintf("<message %s missing from report string table>", key)
}

func parseRawReport(data []byte) (*rawReport, error) {
	var report rawReport
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, fmt.Errorf("parse build report: %w", err)
	}
	if report.TraceID == "" && report.Results == nil && report.Failures == nil {
		return nil, fmt.Errorf("input does not look like a buck2 build report (no trace_id, results, or failures)")
	}
	return &report, nil
}
