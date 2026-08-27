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

// popularNPMLock is a package-lock.json in the shape npm 7 and newer write:
// popular registry packages, plus one of every entry the scanner has to
// classify as something other than a plain registry install.
const popularNPMLock = `{
  "name": "example-app",
  "version": "0.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "example-app",
      "version": "0.0.0",
      "workspaces": ["packages/*"],
      "dependencies": {"svelte": "^5.56.7", "react": "^19.2.8"}
    },
    "node_modules/@example/ui": {"resolved": "packages/ui", "link": true},
    "node_modules/@sveltejs/kit": {
      "version": "2.70.1",
      "resolved": "https://registry.npmjs.org/@sveltejs/kit/-/kit-2.70.1.tgz",
      "dev": true
    },
    "node_modules/@sveltejs/kit/node_modules/cookie": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/cookie/-/cookie-1.0.2.tgz",
      "dev": true
    },
    "node_modules/chalk": {
      "version": "5.6.2",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz"
    },
    "node_modules/esbuild": {
      "version": "0.28.1",
      "resolved": "https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz",
      "dev": true
    },
    "node_modules/is-plain-obj": {
      "version": "4.1.0",
      "resolved": "git+https://github.com/sindresorhus/is-plain-obj.git#97f38e8836f86a642cce98fc6ab3058bc36df181"
    },
    "node_modules/react": {
      "version": "19.2.8",
      "resolved": "https://registry.npmjs.org/react/-/react-19.2.8.tgz"
    },
    "node_modules/react-dom": {
      "version": "19.2.8",
      "resolved": "https://registry.npmjs.org/react-dom/-/react-dom-19.2.8.tgz"
    },
    "node_modules/svelte": {
      "version": "5.56.7",
      "resolved": "https://registry.npmjs.org/svelte/-/svelte-5.56.7.tgz"
    },
    "node_modules/typescript": {
      "version": "7.0.2",
      "resolved": "https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz",
      "dev": true
    },
    "node_modules/vite": {
      "version": "8.1.5",
      "resolved": "https://registry.npmjs.org/vite/-/vite-8.1.5.tgz",
      "dev": true
    },
    "node_modules/vite/node_modules/esbuild": {
      "version": "0.28.1",
      "resolved": "https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz",
      "dev": true
    },
    "node_modules/vue": {
      "version": "3.5.40",
      "resolved": "https://registry.npmjs.org/vue/-/vue-3.5.40.tgz"
    },
    "node_modules/zod": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz"
    },
    "node_modules/zod-v3": {
      "name": "zod",
      "version": "3.25.76",
      "resolved": "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz"
    },
    "packages/ui": {"name": "@example/ui", "version": "0.0.0"}
  }
}
`

func TestParsePackageLock(t *testing.T) {
	packages, skips, err := parsePackageLock(strings.NewReader(popularNPMLock))
	if err != nil {
		t.Fatal(err)
	}
	want := []npmPackage{
		{Name: "@sveltejs/kit", Version: "2.70.1"},
		{Name: "cookie", Version: "1.0.2"},
		{Name: "chalk", Version: "5.6.2"},
		{Name: "esbuild", Version: "0.28.1"},
		{Name: "react", Version: "19.2.8"},
		{Name: "react-dom", Version: "19.2.8"},
		{Name: "svelte", Version: "5.56.7"},
		{Name: "typescript", Version: "7.0.2"},
		{Name: "vite", Version: "8.1.5"},
		{Name: "vue", Version: "3.5.40"},
		{Name: "zod", Version: "4.4.3"},
		{Name: "zod", Version: "3.25.76"},
	}
	if !reflect.DeepEqual(packages, want) {
		t.Fatalf("packages = %#v, want %#v", packages, want)
	}
	// The root project, the workspace member, and the symlink to it are local;
	// the git checkout has no registry identity; vite's nested esbuild copy is
	// the same package at the same version as the hoisted one.
	if (skips != npmSkips{Local: 3, NonRegistry: 1, Duplicate: 1}) {
		t.Fatalf("skips = %#v", skips)
	}

	subjects, err := npmSubjects(packages)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjects) != len(want) {
		t.Fatalf("got %d subjects, want %d", len(subjects), len(want))
	}
	if subjects[0].Query.Package.PURL != "pkg:npm/%40sveltejs/kit" || subjects[0].Display != "pkg:npm/%40sveltejs/kit@2.70.1" {
		t.Fatalf("unexpected scoped subject: %#v", subjects[0])
	}
	if subjects[0].Kind != npmSubject || resultName(subjects[0]) != "npm/@sveltejs/kit@2.70.1" {
		t.Fatalf("unexpected result name %q", resultName(subjects[0]))
	}
	for _, item := range subjects {
		if err := item.Query.validate(); err != nil {
			t.Fatalf("%s: %v", item.Name, err)
		}
		if !protocolSafe(resultName(item)) {
			t.Fatalf("%q cannot be reported as a test name", resultName(item))
		}
	}
}

func TestParsePackageLockRejectsUnsupportedInput(t *testing.T) {
	tests := map[string]string{
		"legacy format":       `{"lockfileVersion": 1, "dependencies": {"svelte": {"version": "5.56.7"}}}`,
		"future format":       `{"lockfileVersion": 4, "packages": {"node_modules/svelte": {"version": "5.56.7"}}}`,
		"missing version key": `{"packages": {"node_modules/svelte": {"version": "5.56.7"}}}`,
		"no packages":         `{"lockfileVersion": 3, "packages": {}}`,
		"no registry packages": `{"lockfileVersion": 3, "packages": {
			"": {"name": "example-app"},
			"node_modules/@example/ui": {"resolved": "packages/ui", "link": true}
		}}`,
		"package without a version": `{"lockfileVersion": 3, "packages": {
			"node_modules/svelte": {"resolved": "https://registry.npmjs.org/svelte/-/svelte-5.56.7.tgz"}
		}}`,
		"invalid package name": `{"lockfileVersion": 3, "packages": {
			"node_modules/bad name": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"}
		}}`,
		"unscoped name with a slash": `{"lockfileVersion": 3, "packages": {
			"node_modules/svelte": {"name": "not/scoped", "version": "1.0.0", "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"}
		}}`,
		"truncated json": `{"lockfileVersion": 3, "packages": {`,
		"trailing content": `{"lockfileVersion": 3, "packages": {
			"node_modules/svelte": {"version": "5.56.7", "resolved": "https://registry.npmjs.org/svelte/-/svelte-5.56.7.tgz"}
		}}{}`,
	}
	for name, input := range tests {
		t.Run(name, func(t *testing.T) {
			if _, _, err := parsePackageLock(strings.NewReader(input)); err == nil {
				t.Fatal("parsePackageLock unexpectedly succeeded")
			}
		})
	}
}

func TestNPMPackageNameHandlesInstallPaths(t *testing.T) {
	tests := []struct {
		treePath  string
		entryName string
		want      string
		installed bool
	}{
		{treePath: "", want: "", installed: false},
		{treePath: "packages/ui", want: "", installed: false},
		{treePath: "node_modules/svelte", want: "svelte", installed: true},
		{treePath: "node_modules/@sveltejs/kit", want: "@sveltejs/kit", installed: true},
		{treePath: "node_modules/vite/node_modules/esbuild", want: "esbuild", installed: true},
		{treePath: "node_modules/zod-v3", entryName: "zod", want: "zod", installed: true},
		// "node_modules" has to be a whole path segment, not a suffix.
		{treePath: "packages/my_node_modules/thing", want: "", installed: false},
	}
	for _, test := range tests {
		name, installed := npmPackageName(test.treePath, test.entryName)
		if name != test.want || installed != test.installed {
			t.Errorf("npmPackageName(%q, %q) = (%q, %t), want (%q, %t)",
				test.treePath, test.entryName, name, installed, test.want, test.installed)
		}
	}
}

type mockAuditor struct {
	responses      []auditResponse
	calls          int
	wolfiResponses []wolfiTargetResponse
	wolfiCalls     int
}

func (m *mockAuditor) read(_ context.Context, _ ...string) (auditResponse, error) {
	if m.calls >= len(m.responses) {
		return nil, fmt.Errorf("unexpected audit call")
	}
	response := m.responses[m.calls]
	m.calls++
	return response, nil
}

func (m *mockAuditor) readWolfiTargets(_ context.Context) (wolfiTargetResponse, error) {
	if m.wolfiCalls >= len(m.wolfiResponses) {
		return nil, fmt.Errorf("unexpected Wolfi target audit call")
	}
	response := m.wolfiResponses[m.wolfiCalls]
	m.wolfiCalls++
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
				"meta.3p": rawJSON(t, []string{"foo", "rust", wolfiPackagePath, "bar"}),
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

func TestCollectWolfiSubjects(t *testing.T) {
	auditor := &mockAuditor{wolfiResponses: []wolfiTargetResponse{{
		"depot-third-party//by-name/wo/wolfi:update": {},
		"depot-third-party//by-name/wo/wolfi:zlib.apk": {
			SHA256: strings.Repeat("a", 64),
			URLs:   []string{wolfiRepository + "zlib-1.3.2-r3.apk"},
		},
		"depot-third-party//by-name/wo/wolfi:libpcre2-8-0.apk": {
			SHA256: strings.Repeat("b", 64),
			URLs:   []string{wolfiRepository + "libpcre2-8-0-10.47-r0.apk"},
		},
	}}}
	subjects, err := collectWolfiSubjects(context.Background(), auditor)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjects) != 2 {
		t.Fatalf("got %d subjects, want 2", len(subjects))
	}
	first := subjects[0]
	if first.Kind != wolfiSubject || first.Name != "libpcre2-8-0@10.47-r0" || first.Display != "pkg:apk/wolfi/libpcre2-8-0@10.47-r0" {
		t.Fatalf("unexpected first subject: %#v", first)
	}
	if first.Query.Version != "10.47-r0" || first.Query.Package == nil || first.Query.Package.PURL != "pkg:apk/wolfi/libpcre2-8-0" {
		t.Fatalf("unexpected Wolfi query: %#v", first.Query)
	}
	if strings.Contains(first.Query.Package.PURL, "arch=") {
		t.Fatalf("Wolfi query unexpectedly has an architecture qualifier: %q", first.Query.Package.PURL)
	}
}

func TestWolfiSubjectsReportsAllTargetProblems(t *testing.T) {
	validSHA := strings.Repeat("c", 64)
	targets := wolfiTargetResponse{
		"depot-third-party//by-name/wo/wolfi:bad-digest.apk": {
			SHA256: strings.Repeat("A", 64),
			URLs:   []string{wolfiRepository + "bad-digest-1-r0.apk"},
		},
		"depot-third-party//by-name/wo/wolfi:many-urls.apk": {
			SHA256: validSHA,
			URLs: []string{
				wolfiRepository + "many-urls-1-r0.apk",
				wolfiRepository + "many-urls-2-r0.apk",
			},
		},
		"depot-third-party//by-name/wo/wolfi:mismatch.apk": {
			SHA256: validSHA,
			URLs:   []string{wolfiRepository + "another-package-1-r0.apk"},
		},
		"depot-third-party//somewhere:wrong-package.apk": {
			SHA256: validSHA,
			URLs:   []string{wolfiRepository + "wrong-package-1-r0.apk"},
		},
		"depot-third-party//by-name/wo/wolfi:update": {},
	}
	_, err := wolfiSubjects(targets)
	if err == nil {
		t.Fatal("wolfiSubjects unexpectedly accepted invalid targets")
	}
	for _, want := range []string{
		"bad-digest.apk: sha256",
		"many-urls.apk: expected exactly one package URL",
		"mismatch.apk: URL",
		"somewhere:wrong-package.apk: target is not in",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error is missing %q:\n%s", want, err)
		}
	}
}

func TestWolfiSubjectsRejectsEmptySet(t *testing.T) {
	if _, err := wolfiSubjects(wolfiTargetResponse{}); err == nil {
		t.Fatal("wolfiSubjects unexpectedly accepted an empty target set")
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

	for _, kind := range []subjectKind{genericSubject, npmSubject, wolfiSubject} {
		groups, err = groupAdvisories(kind, references, details)
		if err != nil {
			t.Fatal(err)
		}
		if groups[0].ExceptionReason != "" {
			t.Fatalf("Rust exception was incorrectly applied to subject kind %d", kind)
		}
	}
}

func TestGroupAdvisoriesKeepsGenericExceptionsOutOfOtherEcosystems(t *testing.T) {
	withExceptions(t, genericSubject, exception{ID: "OSV-generic-excepted", Reason: "accepted for a generic package"})
	references := []vulnerabilityRef{{ID: "OSV-generic-excepted"}}
	details := map[string]vulnerability{
		"OSV-generic-excepted": {ID: "OSV-generic-excepted", Summary: "fuzzer crash on malformed input"},
	}
	groups, err := groupAdvisories(genericSubject, references, details)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].ExceptionReason == "" {
		t.Fatalf("the generic exception did not apply: %#v", groups)
	}

	for _, kind := range []subjectKind{rustSubject, npmSubject, wolfiSubject} {
		groups, err := groupAdvisories(kind, references, details)
		if err != nil {
			t.Fatal(err)
		}
		if groups[0].ExceptionReason != "" {
			t.Fatalf("the generic exception was incorrectly applied to subject kind %d", kind)
		}
	}
}

func TestWriteTestListing(t *testing.T) {
	var output bytes.Buffer
	writeTestListing("all", &output)
	want := "test: generic:all generic-packages\ntest: rust:all rust-packages\n" +
		"test: npm:all npm-packages\ntest: wolfi:all wolfi-packages\n"
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

	output.Reset()
	writeTestListing("npm", &output)
	if output.String() != "test: npm:all npm-packages\n" {
		t.Fatalf("unexpected npm listing %q", output.String())
	}

	output.Reset()
	writeTestListing("wolfi", &output)
	if output.String() != "test: wolfi:all wolfi-packages\n" {
		t.Fatalf("unexpected Wolfi listing %q", output.String())
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

// exceptedCommit is the only commit the stub OSV server reports an advisory
// against, standing in for a pinned third-party//by-name git checkout.
var exceptedCommit = strings.Repeat("a", 40)

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
				if query.Commit != "" {
					if query.Commit == exceptedCommit {
						results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "OSV-generic-excepted"}}}
					}
					continue
				}
				if query.Package == nil {
					continue
				}
				switch query.Package.PURL {
				case "pkg:cargo/vulnerable":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "OSV-2"}}}
				case "pkg:cargo/derivative":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "RUSTSEC-2024-0388"}}}
				case "pkg:npm/vite":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "OSV-3"}}}
				case "pkg:npm/%40sveltejs/kit":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "GHSA-npm-excepted"}}}
				case "pkg:apk/wolfi/vulnerable":
					results[index] = osvResult{Vulns: []vulnerabilityRef{{ID: "OSV-2"}}}
				}
			}
			if err := json.NewEncoder(w).Encode(batchResponse{Results: results}); err != nil {
				t.Errorf("encode response: %v", err)
			}
		case "/vulns/OSV-2":
			fmt.Fprint(w, `{"id":"OSV-2","summary":"bad thing"}`)
		case "/vulns/OSV-3":
			fmt.Fprint(w, `{"id":"OSV-3","summary":"dev server exposes the filesystem"}`)
		case "/vulns/RUSTSEC-2024-0388":
			fmt.Fprint(w, `{"id":"RUSTSEC-2024-0388","summary":"derivative is unmaintained"}`)
		case "/vulns/GHSA-npm-excepted":
			fmt.Fprint(w, `{"id":"GHSA-npm-excepted","summary":"kit request smuggling"}`)
		case "/vulns/OSV-generic-excepted":
			fmt.Fprint(w, `{"id":"OSV-generic-excepted","summary":"fuzzer crash on malformed input"}`)
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

func writeTempNPMLock(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "package-lock.json")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// withExceptions swaps one ecosystem's exception list for the duration of a
// single test.
func withExceptions(t *testing.T, kind subjectKind, items ...exception) {
	t.Helper()
	for index := range exceptionSets {
		if exceptionSets[index].Kind != kind {
			continue
		}
		original := exceptionSets[index].Items
		exceptionSets[index].Items = items
		t.Cleanup(func() { exceptionSets[index].Items = original })
		return
	}
	t.Fatalf("subject kind %d has no registered exception set", kind)
}

func TestRunHarnessCaseNPM(t *testing.T) {
	withExceptions(t, npmSubject, exception{
		ID:     "GHSA-npm-excepted",
		Reason: "build-time only; awaiting an upstream release",
	})
	lock := writeTempNPMLock(t, popularNPMLock)
	server := harnessOSVServer(t)
	cfg := harnessConfig(server, "")
	cfg.npmLockPath = lock

	var stdout, stderr bytes.Buffer
	code := runHarnessTest(context.Background(), cfg, "npm:all", &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit = %d, want 1; stderr: %s", code, stderr.String())
	}
	for _, want := range []string{
		"Loaded 12 npm registry packages from " + lock + " (3 local, 1 non-registry, 1 duplicate entries skipped).\n",
		"result: PASS npm/svelte@5.56.7 -\n",
		"result: PASS npm/react-dom@19.2.8 -\n",
		"result: PASS npm/zod@3.25.76 -\n",
		"result: FAIL npm/vite@8.1.5 - 1 blocking advisory group(s): OSV-3\n",
		"result: PASS npm/@sveltejs/kit@2.70.1 - 1 excepted advisory group(s)\n",
		"result-details: [FAIL] vite@8.1.5\n",
		"result-details:   pkg:npm/vite@8.1.5\n",
		"result-details: [EXEMPT] @sveltejs/kit@2.70.1\n",
		"result-details:     reason: build-time only; awaiting an upstream release\n",
		"Scanned 12 packages: 10 clean, 2 affected; 2 advisory groups (1 blocking, 1 excepted).",
		"result: FAIL npm-packages ",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("output is missing %q:\n%s", want, stdout.String())
		}
	}
	if strings.Contains(stdout.String(), "Unused npm exceptions") {
		t.Fatalf("the used npm exception was reported as unused:\n%s", stdout.String())
	}
}

func TestRunHarnessCaseNPMReportsUnusedExceptions(t *testing.T) {
	withExceptions(t, npmSubject, exception{ID: "GHSA-stale", Reason: "no longer reachable"})
	lock := writeTempNPMLock(t, `{"lockfileVersion": 3, "packages": {
		"": {"name": "example-app"},
		"node_modules/svelte": {
			"version": "5.56.7",
			"resolved": "https://registry.npmjs.org/svelte/-/svelte-5.56.7.tgz"
		}
	}}`)
	server := harnessOSVServer(t)
	cfg := harnessConfig(server, "")
	cfg.npmLockPath = lock

	var stdout, stderr bytes.Buffer
	code := runHarnessTest(context.Background(), cfg, "npm:all", &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0; stderr: %s", code, stderr.String())
	}
	for _, want := range []string{
		"result: PASS npm/svelte@5.56.7 -\n",
		"result: PASS npm-packages ",
		"Unused npm exceptions (candidates for removal): GHSA-stale\n",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("output is missing %q:\n%s", want, stdout.String())
		}
	}
	// An npm-only scan says nothing about the Rust list.
	if strings.Contains(stdout.String(), "Unused Rust exceptions") {
		t.Fatalf("Rust exceptions were reported for an npm scan:\n%s", stdout.String())
	}
}

func TestRunHarnessCaseNPMMissingLockfile(t *testing.T) {
	server := harnessOSVServer(t)
	cfg := harnessConfig(server, "")
	cfg.npmLockPath = filepath.Join(t.TempDir(), "package-lock.json")

	var stdout, stderr bytes.Buffer
	code := runHarnessTest(context.Background(), cfg, "npm:all", &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "package-lock.json") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
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

func TestRunHarnessCaseGenericExceptsGitRepoAdvisory(t *testing.T) {
	withExceptions(t, genericSubject, exception{
		ID:     "OSV-generic-excepted",
		Reason: "fuzzer crash with no upstream fix; only trusted inputs reach the tool",
	})
	server := harnessOSVServer(t)
	cfg := harnessConfig(server, "")
	auditor := &mockAuditor{responses: []auditResponse{
		{
			"depot-third-party//": {
				"meta.3p": rawJSON(t, []string{"by-name/wi/widget"}),
			},
		},
		{
			"depot-third-party//by-name/wi/widget": {
				"meta.version": rawJSON(t, "1.0.41+gaaaaaaa"),
				"meta.osv": rawJSON(t, genericMetadata{
					Type:   "OsvGitRepoInfo",
					URL:    "https://github.com/example/widget",
					Commit: exceptedCommit,
				}),
			},
		},
	}}
	var stdout, stderr bytes.Buffer
	code := runHarnessCase(context.Background(), cfg, "generic", genericCaseName, auditor, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0; stderr: %s", code, stderr.String())
	}
	for _, want := range []string{
		"\n[EXEMPT] third-party//by-name/wi/widget\n",
		"result: PASS third-party//by-name/wi/widget - 1 excepted advisory group(s)\n",
		"result-details:     reason: fuzzer crash with no upstream fix; only trusted inputs reach the tool\n",
		"Scanned 1 packages: 0 clean, 1 affected; 1 advisory groups (0 blocking, 1 excepted).",
		"result: PASS generic-packages ",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("output is missing %q:\n%s", want, stdout.String())
		}
	}
	if strings.Contains(stdout.String(), "Unused generic exceptions") {
		t.Fatalf("the used generic exception was reported as unused:\n%s", stdout.String())
	}
}

func TestRunHarnessCaseGenericReportsUnusedExceptions(t *testing.T) {
	withExceptions(t, genericSubject, exception{ID: "OSV-stale", Reason: "upstream fixed this"})
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
	if !strings.Contains(stdout.String(), "Unused generic exceptions (candidates for removal): OSV-stale\n") {
		t.Fatalf("the stale generic exception was not reported:\n%s", stdout.String())
	}
	// A generic-only scan says nothing about the Rust list.
	if strings.Contains(stdout.String(), "Unused Rust exceptions") {
		t.Fatalf("Rust exceptions were reported for a generic scan:\n%s", stdout.String())
	}
}

func TestRunHarnessCaseWolfi(t *testing.T) {
	server := harnessOSVServer(t)
	cfg := harnessConfig(server, "")
	auditor := &mockAuditor{wolfiResponses: []wolfiTargetResponse{{
		"depot-third-party//by-name/wo/wolfi:clean.apk": {
			SHA256: strings.Repeat("d", 64),
			URLs:   []string{wolfiRepository + "clean-1.0-r0.apk"},
		},
		"depot-third-party//by-name/wo/wolfi:vulnerable.apk": {
			SHA256: strings.Repeat("e", 64),
			URLs:   []string{wolfiRepository + "vulnerable-2.0-r1.apk"},
		},
	}}}
	var stdout, stderr bytes.Buffer
	code := runHarnessCase(context.Background(), cfg, "wolfi", wolfiCaseName, auditor, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit = %d, want 1; stderr: %s", code, stderr.String())
	}
	for _, want := range []string{
		"Loaded and validated 2 pinned Wolfi packages",
		"\n[FAIL] vulnerable@2.0-r1\n",
		"pkg:apk/wolfi/vulnerable@2.0-r1",
		"result: PASS wolfi/clean@1.0-r0 -\n",
		"result: FAIL wolfi/vulnerable@2.0-r1 - 1 blocking advisory group(s): OSV-2\n",
		"result: FAIL wolfi-packages ",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("output is missing %q:\n%s", want, stdout.String())
		}
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
	code = realMain(context.Background(), []string{"-list-tests", "npm"}, &stdout, &stderr)
	if code != 0 || stdout.String() != "test: npm:all npm-packages\n" {
		t.Fatalf("exit = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	code = realMain(context.Background(), []string{"-list-tests", "wolfi"}, &stdout, &stderr)
	if code != 0 || stdout.String() != "test: wolfi:all wolfi-packages\n" {
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
