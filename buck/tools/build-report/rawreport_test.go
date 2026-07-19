// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseRawReportActionFailure(t *testing.T) {
	report, err := parseRawReport([]byte(fixtureActionFailure))
	if err != nil {
		t.Fatalf("parseRawReport: %v", err)
	}
	if report.Success {
		t.Error("report should be marked failed")
	}
	entry, ok := report.Results["depot//probe:fails"]
	if !ok {
		t.Fatal("missing entry for depot//probe:fails")
	}
	if len(entry.Errors) != 0 {
		t.Errorf("action errors belong on the configured entry, got %d top-level errors", len(entry.Errors))
	}
	configured, ok := entry.Configured["cfg:<empty>#1a608cc1468ec806"]
	if !ok {
		t.Fatal("missing configured entry")
	}
	if len(configured.Errors) != 1 {
		t.Fatalf("expected 1 configured error, got %d", len(configured.Errors))
	}
	raised := configured.Errors[0]
	if raised.ErrorCategory != "USER" {
		t.Errorf("category = %q, want USER", raised.ErrorCategory)
	}
	if raised.CauseIndex == nil || *raised.CauseIndex != 0 {
		t.Errorf("cause_index = %v, want 0", raised.CauseIndex)
	}
	message := raised.resolvedMessage(report.Strings)
	if !strings.HasPrefix(message, "Action failed: depot//probe:fails") {
		t.Errorf("resolved message = %q", message)
	}
	detail := raised.ActionError.detail(report.Strings)
	if detail == nil {
		t.Fatal("expected action detail")
	}
	if detail.Category != "genrule" {
		t.Errorf("action category = %q, want genrule", detail.Category)
	}
	if detail.Stderr != "error: fake compile failure in probe\n" {
		t.Errorf("stderr = %q", detail.Stderr)
	}
	if detail.Reason != "Local command returned non-zero exit code 1" {
		t.Errorf("reason = %q", detail.Reason)
	}
}

func TestParseRawReportLegacyStringErrors(t *testing.T) {
	report, err := parseRawReport([]byte(fixtureSharedCause))
	if err != nil {
		t.Fatalf("parseRawReport: %v", err)
	}
	entry := report.Results["depot//tools/flaky:flaky"]
	if len(entry.Errors) != 1 {
		t.Fatalf("expected 1 error, got %d", len(entry.Errors))
	}
	message := entry.Errors[0].resolvedMessage(report.Strings)
	if !strings.Contains(message, "download of https://example.com/dep.tar.gz failed") {
		t.Errorf("legacy string error not preserved: %q", message)
	}
	if entry.Errors[0].CauseIndex != nil {
		t.Error("legacy string errors carry no cause index")
	}
}

func TestStringTableLookup(t *testing.T) {
	table := stringTable{"1": "resolved text"}
	if got := table.lookup("1"); got != "resolved text" {
		t.Errorf("lookup(1) = %q", got)
	}
	if got := table.lookup(""); got != "" {
		t.Errorf("lookup of empty key should be empty, got %q", got)
	}
	if got := table.lookup("999"); !strings.Contains(got, "999") {
		t.Errorf("missing key should produce a placeholder naming the key, got %q", got)
	}
}

func TestParseRawReportRejectsNonReports(t *testing.T) {
	if _, err := parseRawReport([]byte(`{"unrelated": true}`)); err == nil {
		t.Error("expected an error for JSON that is not a build report")
	}
	if _, err := parseRawReport([]byte(`not json`)); err == nil {
		t.Error("expected an error for invalid JSON")
	}
}

func TestLoadReportDetectsFormats(t *testing.T) {
	raw, err := loadReport([]byte(fixtureSuccessBuild))
	if err != nil {
		t.Fatalf("loadReport(raw): %v", err)
	}
	if raw.FormatVersion != formatVersion {
		t.Errorf("format version = %q, want %q", raw.FormatVersion, formatVersion)
	}

	processed, err := raw.marshalJSON()
	if err != nil {
		t.Fatalf("marshalJSON: %v", err)
	}
	reloaded, err := loadReport([]byte(processed))
	if err != nil {
		t.Fatalf("loadReport(processed): %v", err)
	}
	if !reflect.DeepEqual(reloaded.Summary, raw.Summary) {
		t.Errorf("round-tripped summary differs: %+v vs %+v", reloaded.Summary, raw.Summary)
	}

	if _, err := loadReport([]byte(`{"format_version": "1.0.0"}`)); err == nil {
		t.Error("version 1.x reports from the retired TypeScript tool must be rejected")
	}
}
