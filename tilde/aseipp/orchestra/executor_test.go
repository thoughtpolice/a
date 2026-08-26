// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These tests pin the Buck client argument contract and the reduction from
// Buck's case-level JSON events to Orchestra's target-level result protocol.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestBuckExecutorAggregatesRequestedTargets(t *testing.T) {
	t.Parallel()
	verificationCalls := 0
	executor := buckTestExecutor{
		command:      "/tools/buck2",
		jjCommand:    "/tools/jj",
		mode:         "local",
		isolationDir: "orchestra-test",
		timeout:      time.Minute,
		hostPlatform: "linux-x86_64",
		verifyRevision: func(_ context.Context, command, revision string) error {
			verificationCalls++
			if command != "/tools/jj" || revision != "head-commit" {
				t.Fatalf("revision verification = %q %q", command, revision)
			}
			return nil
		},
		runCommand: func(_ context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
			if command != "/tools/buck2" {
				t.Fatalf("command = %q", command)
			}
			if directory != "" {
				t.Fatalf("directory = %q", directory)
			}
			if !containsAdjacent(args, "--isolation-dir", "orchestra-test") ||
				!containsArgument(args, "--local-only") ||
				!containsArgument(args, "--ignore-tests-attribute") ||
				!containsArgument(args, "--no-default-test-filters") {
				t.Fatalf("args = %#v", args)
			}
			eventLog := argumentAfter(t, args, "--event-log")
			targetFile := strings.TrimPrefix(argumentWithPrefix(t, args, "@"), "@")
			contents, err := os.ReadFile(targetFile)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := string(contents), "root//pkg:alpha-test\nroot//pkg:beta-test\n"; got != want {
				t.Fatalf("target manifest = %q, want %q", got, want)
			}
			writeBuckEvents(t, eventLog,
				buckResultLine(t, "root//pkg", "alpha-test", 1, 1_500),
				buckResultLine(t, "root//pkg", "alpha-test", 3, 500),
				buckResultLine(t, "root//pkg", "beta-test", 1, 1_000),
				buckResultLine(t, "root//pkg", "beta-test", 2, 2_500),
				buckEndLine(t, 32),
			)
			return nil, []byte("test failure summary"), errors.New("exit status 32")
		},
	}
	claimed := job{
		Kind:       "run_tests",
		Revision:   "head-commit",
		Platform:   "linux-x86_64",
		LeaseToken: 7,
		Tests: []plannedTest{
			{ID: "t-alpha", Label: "root//pkg:alpha-test"},
			{ID: "t-beta", Label: "root//pkg:beta-test"},
		},
	}
	var output strings.Builder
	results, err := executor.Execute(context.Background(), claimed, &output)
	if err != nil {
		t.Fatal(err)
	}
	if verificationCalls != 1 {
		t.Fatalf("verification calls = %d", verificationCalls)
	}
	want := []testExecution{
		{TestID: "t-alpha", Outcome: "infra_failure", DurationMS: 2},
		{TestID: "t-beta", Outcome: "fail", DurationMS: 4},
	}
	if !equalJSON(results, want) {
		t.Fatalf("results = %+v, want %+v", results, want)
	}
	if !strings.Contains(output.String(), "Buck command returned") ||
		!strings.Contains(output.String(), "fail: root//pkg:beta-test") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestBuckIndependentObservationsDisableRemoteCaching(t *testing.T) {
	t.Parallel()
	for _, purpose := range []string{"deflake", "culprit", "infra_retry"} {
		t.Run(purpose, func(t *testing.T) {
			t.Parallel()
			calls := 0
			executor := buckTestExecutor{
				command: "buck2", mode: "default", isolationDir: "orchestra-test",
				timeout: time.Minute, hostPlatform: "linux-x86_64",
				verifyRevision: func(context.Context, string, string) error { return nil },
				runCommand: func(_ context.Context, _ string, args []string, _ string) ([]byte, []byte, error) {
					calls++
					if !containsArgument(args, "--no-remote-cache") || !containsArgument(args, "--local-only") {
						t.Fatalf("independent observation arguments = %v", args)
					}
					writeBuckEvents(t, argumentAfter(t, args, "--event-log"),
						buckResultLine(t, "root//pkg", "test", 1, 1_000), buckEndLine(t, 0))
					return nil, nil, nil
				},
			}
			claimed := job{
				Kind: "run_tests", Revision: "head", Platform: "linux-x86_64", Purpose: purpose,
				Tests: []plannedTest{{ID: "t1", Label: "root//pkg:test"}},
			}
			for round := 1; round <= 2; round++ {
				claimed.Round = round
				results, err := executor.Execute(context.Background(), claimed, &strings.Builder{})
				if err != nil || len(results) != 1 || results[0].Outcome != "pass" {
					t.Fatalf("results=%v error=%v", results, err)
				}
			}
			if calls != 2 {
				t.Fatalf("Buck invocations=%d, want 2 independent observations", calls)
			}
		})
	}
}

func TestBuckIndependentObservationsRejectRemoteDeduplication(t *testing.T) {
	t.Parallel()
	executor := buckTestExecutor{
		command: "buck2", mode: "remote", isolationDir: "orchestra-test",
		timeout: time.Minute, hostPlatform: "linux-x86_64",
		verifyRevision: func(context.Context, string, string) error { return nil },
		runCommand: func(context.Context, string, []string, string) ([]byte, []byte, error) {
			t.Fatal("unsafe remote rerun was executed")
			return nil, nil, nil
		},
	}
	_, err := executor.Execute(context.Background(), job{
		Kind: "run_tests", Revision: "head", Platform: "linux-x86_64", Purpose: "deflake",
		Tests: []plannedTest{{ID: "t1", Label: "root//pkg:test"}},
	}, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "deduplication") {
		t.Fatalf("error=%v", err)
	}
}

func TestFakeRevisionFixtures(t *testing.T) {
	t.Parallel()
	for _, fixture := range []struct{ revision, purpose, outcome string }{
		{"fake-0001", "initial", "fail"},
		{"fake-pass-baseline", "initial", "pass"},
		{"fake-flaky-head", "initial", "fail"},
		{"fake-flaky-head", "deflake", "pass"},
		{"fake-stable-head", "deflake", "fail"},
	} {
		results, err := (fakeTestExecutor{}).Execute(context.Background(), job{
			Revision: fixture.revision, Purpose: fixture.purpose,
			Tests: []plannedTest{{ID: "t1", Label: "root//service:integration"}},
		}, &strings.Builder{})
		if err != nil || results[0].Outcome != fixture.outcome {
			t.Fatalf("fixture=%+v results=%v error=%v", fixture, results, err)
		}
	}
}

func TestBuckExecutorFailsClosedOnIncompleteEventLog(t *testing.T) {
	t.Parallel()
	executor := buckTestExecutor{
		command:      "buck2",
		jjCommand:    "jj",
		mode:         "local",
		isolationDir: "orchestra-test",
		timeout:      time.Minute,
		hostPlatform: "linux-x86_64",
		verifyRevision: func(context.Context, string, string) error {
			return nil
		},
		runCommand: func(_ context.Context, _ string, args []string, _ string) ([]byte, []byte, error) {
			eventLog := argumentAfter(t, args, "--event-log")
			writeBuckEvents(t, eventLog, buckResultLine(t, "root//pkg", "test", 2, 1_000))
			return nil, nil, nil
		},
	}
	results, err := executor.Execute(context.Background(), job{
		Kind:     "run_tests",
		Revision: "head",
		Platform: "linux-x86_64",
		Tests:    []plannedTest{{ID: "t1", Label: "root//pkg:test"}},
	}, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Outcome != "infra_failure" {
		t.Fatalf("results = %+v", results)
	}
}

func TestBuckExecutorRejectsTheWrongCheckout(t *testing.T) {
	t.Parallel()
	ranBuck := false
	executor := buckTestExecutor{
		command:      "buck2",
		jjCommand:    "jj",
		mode:         "local",
		isolationDir: "orchestra-test",
		timeout:      time.Minute,
		hostPlatform: "linux-x86_64",
		verifyRevision: func(context.Context, string, string) error {
			return errors.New("checkout mismatch")
		},
		runCommand: func(context.Context, string, []string, string) ([]byte, []byte, error) {
			ranBuck = true
			return nil, nil, nil
		},
	}
	_, err := executor.Execute(context.Background(), job{
		Kind:     "run_tests",
		Revision: "head",
		Platform: "linux-x86_64",
		Tests:    []plannedTest{{ID: "t1", Label: "root//pkg:test"}},
	}, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "checkout mismatch") || ranBuck {
		t.Fatalf("error = %v, ran Buck = %t", err, ranBuck)
	}
}

func TestBuckExecutorUsesManagedRevisionWorkspace(t *testing.T) {
	t.Parallel()
	workspace := &fakeRevisionWorkspace{directory: "/cache/workspaces/job/checkout"}
	provider := &fakeWorkspaceProvider{workspace: workspace}
	executor := buckTestExecutor{
		command:      "buck2",
		jjCommand:    "jj",
		mode:         "local",
		isolationDir: "orchestra-test",
		timeout:      time.Minute,
		hostPlatform: "linux-x86_64",
		workspaces:   provider,
		verifyRevision: func(context.Context, string, string) error {
			t.Fatal("managed workspace unexpectedly used the ambient checkout verifier")
			return nil
		},
		runCommand: func(_ context.Context, _ string, args []string, directory string) ([]byte, []byte, error) {
			if directory != workspace.directory {
				t.Fatalf("Buck directory = %q", directory)
			}
			eventLog := argumentAfter(t, args, "--event-log")
			writeBuckEvents(t, eventLog,
				buckResultLine(t, "root//pkg", "test", 1, 1_000),
				buckEndLine(t, 0),
			)
			return nil, nil, nil
		},
	}
	results, err := executor.Execute(context.Background(), job{
		Kind:     "run_tests",
		Revision: "abcdef",
		Platform: "linux-x86_64",
		Tests:    []plannedTest{{ID: "t1", Label: "root//pkg:test"}},
	}, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if provider.revision != "abcdef" || workspace.closeCalls != 1 {
		t.Fatalf("provider revision=%q close calls=%d", provider.revision, workspace.closeCalls)
	}
	if len(results) != 1 || results[0].Outcome != "pass" {
		t.Fatalf("results = %+v", results)
	}
}

func TestBuckStatusClassification(t *testing.T) {
	t.Parallel()
	cases := map[int]int{
		1:  buckOutcomePass,
		2:  buckOutcomeFail,
		3:  buckOutcomeInfra,
		4:  buckOutcomeInfra,
		5:  buckOutcomeInfra,
		6:  buckOutcomeInfra,
		7:  buckOutcomeInfra,
		8:  buckOutcomeInfra,
		99: buckOutcomeInfra,
	}
	for status, want := range cases {
		if got := buckStatusRank(status); got != want {
			t.Errorf("status %d = rank %d, want %d", status, got, want)
		}
	}
}

func TestBuckSkippedCasesNeverBecomePassingEvidence(t *testing.T) {
	t.Parallel()
	for _, statuses := range [][]int{{3}, {7}, {3, 7}, {1, 3}, {7, 1}, {2, 3}} {
		executor := buckTestExecutor{
			command: "buck2", mode: "local", isolationDir: "orchestra-test",
			timeout: time.Minute, hostPlatform: "linux-x86_64",
			verifyRevision: func(context.Context, string, string) error { return nil },
			runCommand: func(_ context.Context, _ string, args []string, _ string) ([]byte, []byte, error) {
				lines := [][]byte{}
				for _, status := range statuses {
					lines = append(lines, buckResultLine(t, "root//pkg", "test", status, 1_000))
				}
				lines = append(lines, buckEndLine(t, 0))
				writeBuckEvents(t, argumentAfter(t, args, "--event-log"), lines...)
				return nil, nil, nil
			},
		}
		results, err := executor.Execute(context.Background(), job{
			Kind: "run_tests", Revision: "head", Platform: "linux-x86_64",
			Tests: []plannedTest{{ID: "t1", Label: "root//pkg:test"}},
		}, &strings.Builder{})
		if err != nil || len(results) != 1 || results[0].Outcome != "infra_failure" {
			t.Fatalf("statuses=%v results=%v error=%v", statuses, results, err)
		}
	}
}

type fakeWorkspaceProvider struct {
	revision  string
	workspace revisionWorkspace
}

func (provider *fakeWorkspaceProvider) OpenWorkspace(_ context.Context, revision string) (revisionWorkspace, error) {
	provider.revision = revision
	return provider.workspace, nil
}

type fakeRevisionWorkspace struct {
	directory  string
	closeCalls int
}

func (workspace *fakeRevisionWorkspace) Directory() string {
	return workspace.directory
}

func (workspace *fakeRevisionWorkspace) Close(context.Context) error {
	workspace.closeCalls++
	return nil
}

func buckResultLine(t *testing.T, packageName, targetName string, status int, durationUS int64) []byte {
	t.Helper()
	value := map[string]any{
		"Event": map[string]any{
			"data": map[string]any{
				"Instant": map[string]any{
					"data": map[string]any{
						"TestResult": map[string]any{
							"name":        targetName + " case",
							"status":      status,
							"duration_us": durationUS,
							"target_label": map[string]any{
								"label": map[string]any{
									"package": packageName,
									"name":    targetName,
								},
							},
						},
					},
				},
			},
		},
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func buckEndLine(t *testing.T, exitCode int) []byte {
	t.Helper()
	value := map[string]any{
		"Event": map[string]any{
			"data": map[string]any{
				"Instant": map[string]any{
					"data": map[string]any{
						"EndOfTestResults": map[string]any{"exit_code": exitCode},
					},
				},
			},
		},
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func writeBuckEvents(t *testing.T, path string, lines ...[]byte) {
	t.Helper()
	contents := bytesJoin(lines, []byte("\n"))
	contents = append(contents, '\n')
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
}

func bytesJoin(values [][]byte, separator []byte) []byte {
	var result []byte
	for index, value := range values {
		if index != 0 {
			result = append(result, separator...)
		}
		result = append(result, value...)
	}
	return result
}

func containsArgument(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func containsAdjacent(args []string, first, second string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == first && args[index+1] == second {
			return true
		}
	}
	return false
}

func argumentAfter(t *testing.T, args []string, flagName string) string {
	t.Helper()
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flagName {
			return args[index+1]
		}
	}
	t.Fatalf("missing %s in %#v", flagName, args)
	return ""
}

func argumentWithPrefix(t *testing.T, args []string, prefix string) string {
	t.Helper()
	for _, arg := range args {
		if strings.HasPrefix(arg, prefix) {
			return arg
		}
	}
	t.Fatalf("missing prefix %q in %#v", prefix, args)
	return ""
}

func equalJSON(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}
