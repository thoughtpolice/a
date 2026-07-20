// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseCargoLock(t *testing.T) {
	lock := `# generated
version = 4

[[package]]
name = "root"
version = "0.0.0"
dependencies = [
 "serde",
]

[[package]]
name = "hash#map" # the hash is inside the string
version = '1.2.3'
source = "registry+https://github.com/rust-lang/crates.io-index"

[metadata]
checksum = "ignored"
`
	packages, err := parseCargoLock(strings.NewReader(lock))
	if err != nil {
		t.Fatal(err)
	}
	want := []cargoPackage{
		{Name: "root", Version: "0.0.0"},
		{Name: "hash#map", Version: "1.2.3", Source: "registry+https://github.com/rust-lang/crates.io-index"},
	}
	if !reflect.DeepEqual(packages, want) {
		t.Fatalf("packages = %#v, want %#v", packages, want)
	}

	subjects, skipped, err := cargoSubjects(packages)
	if err != nil {
		t.Fatal(err)
	}
	if skipped != 1 || len(subjects) != 1 {
		t.Fatalf("got %d subjects and %d skipped, want 1 and 1", len(subjects), skipped)
	}
	if subjects[0].Query.Package.PURL != "pkg:cargo/hash#map" {
		t.Fatalf("unexpected purl %q", subjects[0].Query.Package.PURL)
	}
}

func TestParseCargoLockRejectsUnsupportedInput(t *testing.T) {
	tests := map[string]string{
		"old format":      "version = 3\n[[package]]\nname = \"x\"\nversion = \"1\"\n",
		"missing version": "[[package]]\nname = \"x\"\nversion = \"1\"\n",
		"missing name":    "version = 4\n[[package]]\nversion = \"1\"\n",
		"unknown table":   "version = 4\n[workspace]\nvalue = 1\n",
	}
	for name, input := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := parseCargoLock(strings.NewReader(input)); err == nil {
				t.Fatal("parseCargoLock unexpectedly succeeded")
			}
		})
	}
}

type mockAuditor struct {
	responses []auditResponse
	calls     int
}

func (m *mockAuditor) read(_ context.Context, _ ...string) (auditResponse, error) {
	if m.calls >= len(m.responses) {
		return nil, fmt.Errorf("unexpected audit call")
	}
	response := m.responses[m.calls]
	m.calls++
	return response, nil
}

func rawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestCollectGenericSubjects(t *testing.T) {
	auditor := &mockAuditor{responses: []auditResponse{
		{
			"depot-third-party//": {
				"meta.3p": rawJSON(t, []string{"foo", "rust", "bar"}),
			},
		},
		{
			"depot-third-party//foo": {
				"meta.version": rawJSON(t, "1.2.3"),
				"meta.osv": rawJSON(t, genericMetadata{
					Type: "OsvPurlInfo", PURL: "pkg:generic/example/foo", Version: "1.2.3",
				}),
			},
			"depot-third-party//bar": {
				"meta.version": rawJSON(t, "2.0"),
				"meta.osv": rawJSON(t, genericMetadata{
					Type: "OsvGitRepoInfo", URL: "https://example.com/bar", Commit: "0123456789abcdef0123456789abcdef01234567",
				}),
			},
		},
	}}
	subjects, err := collectGenericSubjects(context.Background(), auditor)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjects) != 2 || subjects[0].Name != "third-party//foo" || subjects[1].Query.Commit != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("unexpected subjects: %#v", subjects)
	}
}

func TestCollectGenericSubjectsReportsAllMetadataProblems(t *testing.T) {
	auditor := &mockAuditor{responses: []auditResponse{
		{"depot-third-party//": {"meta.3p": rawJSON(t, []string{"a", "b"})}},
		{
			"depot-third-party//a": {"meta.version": rawJSON(t, "1")},
			"depot-third-party//b": {
				"meta.version": rawJSON(t, "2"),
				"meta.osv":     rawJSON(t, genericMetadata{Type: "OsvPurlInfo", PURL: "pkg:generic/b", Version: "1"}),
			},
		},
	}}
	_, err := collectGenericSubjects(context.Background(), auditor)
	if err == nil || !strings.Contains(err.Error(), "third-party//a") || !strings.Contains(err.Error(), "third-party//b") {
		t.Fatalf("expected both metadata errors, got %v", err)
	}
}

func TestOSVQueryPaginationAndDetails(t *testing.T) {
	queryCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/querybatch":
			queryCalls++
			var request struct {
				Queries []osvQuery `json:"queries"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Errorf("decode query: %v", err)
			}
			if queryCalls == 1 {
				if len(request.Queries) != 2 || request.Queries[0].PageToken != "" {
					t.Errorf("unexpected initial request: %#v", request)
				}
				fmt.Fprint(w, `{"results":[{"vulns":[{"id":"RUSTSEC-1"}],"next_page_token":"next"},{}]}`)
				return
			}
			if len(request.Queries) != 1 || request.Queries[0].PageToken != "next" {
				t.Errorf("unexpected page request: %#v", request)
			}
			fmt.Fprint(w, `{"results":[{"vulns":[{"id":"RUSTSEC-1"},{"id":"GHSA-1"}]}]}`)
		case "/v1/vulns/RUSTSEC-1":
			fmt.Fprint(w, `{"id":"RUSTSEC-1","aliases":["GHSA-1"],"summary":"test issue"}`)
		case "/v1/vulns/GHSA-1":
			fmt.Fprint(w, `{"id":"GHSA-1","aliases":["RUSTSEC-1"],"summary":"duplicate record"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := newOSVClient(server.URL+"/v1", 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	subjects := []subject{
		{Name: "one", Kind: rustSubject, Query: osvQuery{Version: "1", Package: &osvPackage{PURL: "pkg:cargo/one"}}},
		{Name: "two", Kind: rustSubject, Query: osvQuery{Version: "1", Package: &osvPackage{PURL: "pkg:cargo/two"}}},
	}
	results, err := client.query(context.Background(), subjects, 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(results[0]) != 2 || len(results[1]) != 0 || queryCalls != 2 {
		t.Fatalf("unexpected results %#v after %d calls", results, queryCalls)
	}
	details, err := client.fetchVulnerabilities(context.Background(), results, 2)
	if err != nil {
		t.Fatal(err)
	}
	findings, err := analyzeFindings(subjects, results, details)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || len(findings[0].Groups) != 1 || findings[0].Groups[0].Primary != "RUSTSEC-1" {
		t.Fatalf("aliases were not grouped: %#v", findings)
	}
}

func TestOSVQueryRejectsWrongResultCount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"results":[]}`)
	}))
	defer server.Close()
	client, err := newOSVClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.query(context.Background(), []subject{{
		Name: "one", Query: osvQuery{Version: "1", Package: &osvPackage{PURL: "pkg:cargo/one"}},
	}}, 10, 1)
	if err == nil || !strings.Contains(err.Error(), "1 queries") {
		t.Fatalf("expected cardinality error, got %v", err)
	}
}

func TestGroupAdvisoriesMatchesExceptionsThroughAliases(t *testing.T) {
	references := []vulnerabilityRef{{ID: "alias-a"}, {ID: "alias-b"}}
	details := map[string]vulnerability{
		"alias-a": {ID: "alias-a", Aliases: []string{"RUSTSEC-2024-0388", "bridge"}, Summary: "first"},
		"alias-b": {ID: "alias-b", Aliases: []string{"bridge", "CVE-1"}, Summary: "second"},
	}
	groups, err := groupAdvisories(rustSubject, references, details)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].Primary != "RUSTSEC-2024-0388" || groups[0].ExceptionReason == "" {
		t.Fatalf("unexpected groups: %#v", groups)
	}

	groups, err = groupAdvisories(genericSubject, references, details)
	if err != nil {
		t.Fatal(err)
	}
	if groups[0].ExceptionReason != "" {
		t.Fatal("Rust exception was incorrectly applied to a generic package")
	}
}

func TestWriteTestListing(t *testing.T) {
	var output bytes.Buffer
	writeTestListing("all", &output)
	want := "test: generic:all generic-packages\ntest: rust:all rust-packages\n"
	if output.String() != want {
		t.Fatalf("listing = %q, want %q", output.String(), want)
	}

	output.Reset()
	writeTestListing("rust", &output)
	if output.String() != "test: rust:all rust-packages\n" {
		t.Fatalf("unexpected rust listing %q", output.String())
	}

	output.Reset()
	writeTestListing("generic", &output)
	if output.String() != "test: generic:all generic-packages\n" {
		t.Fatalf("unexpected generic listing %q", output.String())
	}
}

func writeTempCargoLock(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Cargo.lock")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func harnessOSVServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/querybatch":
			var request struct {
				Queries []osvQuery `json:"queries"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Errorf("decode query: %v", err)
			}
			results := make([]osvResult, len(request.Queries))
			for index, query := range request.Queries {
				if query.Package == nil {
					continue
				}
				switch query.Package.PURL {
				case "pkg:cargo/vulnerable":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "OSV-2"}}}
				case "pkg:cargo/derivative":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "RUSTSEC-2024-0388"}}}
				}
			}
			if err := json.NewEncoder(w).Encode(batchResponse{Results: results}); err != nil {
				t.Errorf("encode response: %v", err)
			}
		case "/vulns/OSV-2":
			fmt.Fprint(w, `{"id":"OSV-2","summary":"bad thing"}`)
		case "/vulns/RUSTSEC-2024-0388":
			fmt.Fprint(w, `{"id":"RUSTSEC-2024-0388","summary":"derivative is unmaintained"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func harnessConfig(server *httptest.Server, lockPath string) config {
	return config{
		apiBase:       server.URL,
		cargoLockPath: lockPath,
		batchSize:     10,
		concurrency:   2,
		httpTimeout:   2 * time.Second,
	}
}

func TestRunHarnessCaseRust(t *testing.T) {
	lock := writeTempCargoLock(t, `version = 4

[[package]]
name = "clean"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "vulnerable"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "derivative"
version = "2.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`)
	server := harnessOSVServer(t)
	var stdout, stderr bytes.Buffer
	code := runHarnessTest(context.Background(), harnessConfig(server, lock), "rust:all", &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit = %d, want 1; stderr: %s", code, stderr.String())
	}
	for _, want := range []string{
		"\n[FAIL] vulnerable@2.0.0\n",
		"result: PASS cargo/clean@1.0.0 -\n",
		"result: FAIL cargo/vulnerable@2.0.0 - 1 blocking advisory group(s): OSV-2\n",
		"result: PASS cargo/derivative@2.2.0 - 1 excepted advisory group(s)\n",
		"result-details: [FAIL] vulnerable@2.0.0\n",
		"result-details: [EXEMPT] derivative@2.2.0\n",
		"Scanned 3 packages: 1 clean, 2 affected; 2 advisory groups (1 blocking, 1 excepted).",
		"result: FAIL rust-packages ",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("output is missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestRunHarnessCaseRustClean(t *testing.T) {
	lock := writeTempCargoLock(t, `version = 4

[[package]]
name = "clean"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`)
	server := harnessOSVServer(t)
	var stdout, stderr bytes.Buffer
	code := runHarnessTest(context.Background(), harnessConfig(server, lock), "rust:all", &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0; stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "result: PASS cargo/clean@1.0.0 -\n") ||
		!strings.Contains(stdout.String(), "result: PASS rust-packages ") {
		t.Fatalf("unexpected output:\n%s", stdout.String())
	}
}

func TestRunHarnessCaseGeneric(t *testing.T) {
	server := harnessOSVServer(t)
	cfg := harnessConfig(server, "")
	auditor := &mockAuditor{responses: []auditResponse{
		{
			"depot-third-party//": {
				"meta.3p": rawJSON(t, []string{"foo"}),
			},
		},
		{
			"depot-third-party//foo": {
				"meta.version": rawJSON(t, "1.2.3"),
				"meta.osv": rawJSON(t, genericMetadata{
					Type: "OsvPurlInfo", PURL: "pkg:generic/example/foo", Version: "1.2.3",
				}),
			},
		},
	}}
	var stdout, stderr bytes.Buffer
	code := runHarnessCase(context.Background(), cfg, "generic", genericCaseName, auditor, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0; stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "result: PASS third-party//foo -\n") ||
		!strings.Contains(stdout.String(), "result: PASS generic-packages ") {
		t.Fatalf("unexpected output:\n%s", stdout.String())
	}
}

func TestRunHarnessTestRejectsUnknownFilter(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runHarnessTest(context.Background(), config{}, "bogus:filter", &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "unknown test filter") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("unexpected stdout: %q", stdout.String())
	}
}

func TestRealMainHarnessFlags(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := realMain(context.Background(), []string{"-list-tests", "rust"}, &stdout, &stderr)
	if code != 0 || stdout.String() != "test: rust:all rust-packages\n" {
		t.Fatalf("exit = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	code = realMain(context.Background(), []string{"-list-tests", "-run-test"}, &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "mutually exclusive") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	code = realMain(context.Background(), []string{"-run-test"}, &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "requires a test filter") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
}

func TestWriteReportExitDecision(t *testing.T) {
	subjects := []subject{{Name: "crate", Display: "pkg:cargo/crate@1"}}
	findings := []finding{{Subject: subjects[0], Groups: []advisoryGroup{{Primary: "OSV-1", Summary: "bad"}}}}
	var output bytes.Buffer
	if !writeReport(&output, subjects, findings) {
		t.Fatal("blocking advisory did not fail the report")
	}
	if !strings.Contains(output.String(), "[FAIL] crate") || !strings.Contains(output.String(), "1 blocking") {
		t.Fatalf("unexpected report:\n%s", output.String())
	}

	findings[0].Groups[0].ExceptionReason = "accepted temporarily"
	output.Reset()
	if writeReport(&output, subjects, findings) {
		t.Fatal("excepted advisory failed the report")
	}
}
