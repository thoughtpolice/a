// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This module implements Orchestra's execution-agent boundary. The real
// backend writes one target at-file per coarse queue batch, runs the local
// Buck2 client, and reduces Buck's JSON-lines TestResult events to Orchestra's
// target-level pass/fail/infra protocol. The fake backend keeps control-plane
// tests deterministic and independent of a repository checkout.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const defaultExecutorTimeout = 4*time.Minute + 30*time.Second

// testExecutor runs one platform-specific queue batch and returns every result.
type testExecutor interface {
	Execute(context.Context, job, io.Writer) ([]testExecution, error)
}

// executorOptions configure the fake or local Buck execution backend.
type executorOptions struct {
	Kind         string
	BuckPath     string
	JJPath       string
	Mode         string
	IsolationDir string
	Timeout      time.Duration
	Workspaces   revisionWorkspaceProvider
}

// fakeTestExecutor returns predictable target outcomes without invoking Buck.
type fakeTestExecutor struct{}

func (fakeTestExecutor) Execute(_ context.Context, claimed job, output io.Writer) ([]testExecution, error) {
	results := make([]testExecution, 0, len(claimed.Tests))
	for _, test := range claimed.Tests {
		outcome, duration := fakeTestOutcome(test.Label)
		// Named fixtures make the complete history/deflake flows observable
		// without pretending that these outcomes came from Buck execution.
		if strings.HasPrefix(claimed.Revision, "fake-pass-") ||
			(strings.HasPrefix(claimed.Revision, "fake-flaky-") && claimed.Purpose == "deflake") {
			outcome = "pass"
		}
		results = append(results, testExecution{TestID: test.ID, Outcome: outcome, DurationMS: duration})
		fmt.Fprintf(output, "%s: %s on %s at lease %d\n", outcome, test.Label, claimed.Platform, claimed.LeaseToken)
	}
	return results, nil
}

// buckCommandRunner is injectable so tests can produce a pinned event stream.
type buckCommandRunner func(context.Context, string, []string, string) ([]byte, []byte, error)

// revisionVerifier proves that a runner checkout contains the queued revision.
type revisionVerifier func(context.Context, string, string) error

// buckTestExecutor invokes a Buck client from an exact local JJ checkout.
type buckTestExecutor struct {
	command        string
	jjCommand      string
	mode           string
	isolationDir   string
	timeout        time.Duration
	hostPlatform   string
	workspaces     revisionWorkspaceProvider
	runCommand     buckCommandRunner
	verifyRevision revisionVerifier
}

// buckEventRecord is the minimal projection of Buck's JSON-lines event log.
type buckEventRecord struct {
	Event *struct {
		Data struct {
			Instant *struct {
				Data struct {
					TestResult       *buckTestResult `json:"TestResult"`
					EndOfTestResults *struct {
						ExitCode int `json:"exit_code"`
					} `json:"EndOfTestResults"`
				} `json:"data"`
			} `json:"Instant"`
		} `json:"data"`
	} `json:"Event"`
}

// buckTestResult contains one test-case result and its configured target.
type buckTestResult struct {
	Status     int    `json:"status"`
	DurationUS int64  `json:"duration_us"`
	Name       string `json:"name"`
	Target     struct {
		Label struct {
			Package string `json:"package"`
			Name    string `json:"name"`
		} `json:"label"`
	} `json:"target_label"`
}

// buckTargetAggregate reduces all cases belonging to one requested target.
type buckTargetAggregate struct {
	seen       bool
	rank       int
	durationUS int64
}

// buckEventSummary contains parsed target aggregates and stream completion.
type buckEventSummary struct {
	targets     map[string]buckTargetAggregate
	endExitCode *int
}

const (
	buckOutcomePass = iota
	buckOutcomeFail
	buckOutcomeInfra
)

// newTestExecutor validates flags and constructs the selected execution backend.
func newTestExecutor(options executorOptions) (testExecutor, error) {
	switch options.Kind {
	case "fake":
		return fakeTestExecutor{}, nil
	case "buck":
		if strings.TrimSpace(options.BuckPath) == "" {
			return nil, errors.New("--buck must name an executable")
		}
		if strings.TrimSpace(options.JJPath) == "" {
			return nil, errors.New("--jj must name an executable")
		}
		if options.Mode != "default" && options.Mode != "local" && options.Mode != "remote" {
			return nil, fmt.Errorf("unknown --buck-mode %q (expected default, local, or remote)", options.Mode)
		}
		if strings.TrimSpace(options.IsolationDir) == "" {
			return nil, errors.New("--buck-isolation-dir must not be empty")
		}
		if options.Timeout <= 0 || options.Timeout > maximumBackendTimeout {
			return nil, errors.New("--buck-timeout must be positive and at most 24h")
		}
		return buckTestExecutor{
			command:        options.BuckPath,
			jjCommand:      options.JJPath,
			mode:           options.Mode,
			isolationDir:   options.IsolationDir,
			timeout:        options.Timeout,
			hostPlatform:   hostPlatform(),
			workspaces:     options.Workspaces,
			runCommand:     runBuckCommand,
			verifyRevision: verifyWorkingRevision,
		}, nil
	default:
		return nil, fmt.Errorf("unknown executor %q (expected fake or buck)", options.Kind)
	}
}

// runExecuteCommand exercises a real Buck batch without a celld server.
func runExecuteCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("execute", flag.ContinueOnError)
	flags.SetOutput(stderr)
	buckPath := flags.String("buck", "buck2", "Buck2 executable")
	jjPath := flags.String("jj", "jj", "JJ executable used to verify --revision")
	mode := flags.String("buck-mode", "local", "Buck execution mode: default, local, or remote")
	isolationDir := flags.String("buck-isolation-dir", "orchestra-agent", "Buck daemon isolation directory")
	timeout := flags.Duration("timeout", defaultExecutorTimeout, "maximum Buck invocation duration")
	platform := flags.String("platform", hostPlatform(), "logical execution platform for this batch")
	revision := flags.String("revision", "", "immutable revision to execute; the ambient checkout must match when unmanaged")
	sourceURL := flags.String("source-url", "", "Git repository URL or path for an agent-managed JJ clone")
	sourceCache := flags.String("source-cache", "", "persistent directory for the agent-managed JJ clone")
	sourceRemote := flags.String("source-remote", "origin", "Git remote name used by the managed clone")
	sourceTimeout := flags.Duration("source-timeout", defaultSourceTimeout, "maximum clone/fetch duration")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() == 0 {
		return errors.New("execute requires at least one Buck test target")
	}
	if (*sourceURL != "" || *sourceCache != "") && *revision == "" {
		return errors.New("--revision is required with a managed source clone")
	}
	repository, created, sourceErr := prepareJJSourceRepository(
		context.Background(),
		sourceRepositoryOptions{
			JJPath: *jjPath,
			Source: *sourceURL,
			Cache:  *sourceCache,
			Remote: *sourceRemote,
		},
		*sourceTimeout,
	)
	if sourceErr != nil {
		return sourceErr
	}
	var workspaces revisionWorkspaceProvider
	if repository != nil {
		action := "refreshed"
		if created {
			action = "cloned"
		}
		fmt.Fprintf(stderr, "%s source repository at %s\n", action, repository.Directory())
		workspaces = repository
	}
	executor, err := newTestExecutor(executorOptions{
		Kind:         "buck",
		BuckPath:     *buckPath,
		JJPath:       *jjPath,
		Mode:         *mode,
		IsolationDir: *isolationDir,
		Timeout:      *timeout,
		Workspaces:   workspaces,
	})
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, flags.NArg())
	tests := make([]plannedTest, 0, flags.NArg())
	for _, label := range flags.Args() {
		if _, duplicate := seen[label]; duplicate {
			return fmt.Errorf("duplicate test target %s", label)
		}
		seen[label] = struct{}{}
		id, testKey := stableTestIdentity(*platform, label)
		tests = append(tests, plannedTest{ID: id, TestKey: testKey, Label: label})
	}
	results, err := executor.Execute(context.Background(), job{
		Kind:     "run_tests",
		Revision: *revision,
		Platform: *platform,
		Tests:    tests,
	}, stderr)
	if err != nil {
		return err
	}
	return writeJSON(stdout, struct {
		Kind  string          `json:"kind"`
		Tests []testExecution `json:"tests"`
	}{Kind: "run_tests", Tests: results})
}

// Execute runs one at-file Buck invocation and aggregates its event log.
func (executor buckTestExecutor) Execute(
	ctx context.Context,
	claimed job,
	output io.Writer,
) ([]testExecution, error) {
	if len(claimed.Tests) == 0 {
		return nil, errors.New("Buck execution job contains no tests")
	}
	if executor.mode == "local" && claimed.Platform != executor.hostPlatform {
		return nil, fmt.Errorf(
			"local Buck agent platform %s cannot execute job platform %s",
			executor.hostPlatform,
			claimed.Platform,
		)
	}

	executionContext, cancel := context.WithTimeout(ctx, executor.timeout)
	defer cancel()
	if executor.workspaces == nil {
		if claimed.Revision != "" {
			verifier := executor.verifyRevision
			if verifier == nil {
				verifier = verifyWorkingRevision
			}
			if err := verifier(executionContext, executor.jjCommand, claimed.Revision); err != nil {
				return nil, fmt.Errorf("verify Buck checkout: %w", err)
			}
		}
		return executor.executeInDirectory(executionContext, claimed, output, "")
	}

	workspace, err := executor.workspaces.OpenWorkspace(executionContext, claimed.Revision)
	if err != nil {
		return nil, fmt.Errorf("open Buck revision workspace: %w", err)
	}
	results, executionErr := executor.executeInDirectory(
		executionContext,
		claimed,
		output,
		workspace.Directory(),
	)
	cleanupContext, cleanupCancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		sourceWorkspaceCleanupTimeout,
	)
	defer cleanupCancel()
	cleanupErr := workspace.Close(cleanupContext)
	if executionErr != nil {
		if cleanupErr != nil {
			return nil, fmt.Errorf("%v; additionally clean Buck revision workspace: %w", executionErr, cleanupErr)
		}
		return nil, executionErr
	}
	if cleanupErr != nil {
		return nil, fmt.Errorf("clean Buck revision workspace: %w", cleanupErr)
	}
	return results, nil
}

// executeInDirectory invokes Buck in either the caller's checkout or a
// managed, revision-pinned JJ workspace.
func (executor buckTestExecutor) executeInDirectory(
	executionContext context.Context,
	claimed job,
	output io.Writer,
	directory string,
) ([]testExecution, error) {
	temporaryDirectory, err := os.MkdirTemp("", "orchestra-buck-*")
	if err != nil {
		return nil, fmt.Errorf("create Buck invocation directory: %w", err)
	}
	defer os.RemoveAll(temporaryDirectory)
	targetsPath := filepath.Join(temporaryDirectory, "targets")
	eventLogPath := filepath.Join(temporaryDirectory, "events.json-lines")
	labels := make([]string, 0, len(claimed.Tests))
	seenLabels := make(map[string]struct{}, len(claimed.Tests))
	for _, test := range claimed.Tests {
		if test.Label == "" || strings.ContainsAny(test.Label, "\r\n") {
			return nil, fmt.Errorf("test %s has an invalid Buck label", test.ID)
		}
		if _, duplicate := seenLabels[test.Label]; duplicate {
			return nil, fmt.Errorf("Buck execution job repeats target %s", test.Label)
		}
		seenLabels[test.Label] = struct{}{}
		labels = append(labels, test.Label)
	}
	if err := os.WriteFile(targetsPath, []byte(strings.Join(labels, "\n")+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write Buck target manifest: %w", err)
	}

	args := []string{
		"test",
		"--console", "none",
		"--no-interactive-console",
		"--event-log", eventLogPath,
		"--ignore-tests-attribute",
		"--no-default-test-filters",
		"--isolation-dir", executor.isolationDir,
	}
	if claimed.Purpose != "" && claimed.Purpose != "initial" {
		// Independent observations must not reuse a cached test result. Both
		// bundled Buck runners disable execution caching (listing/build
		// caches remain useful); additionally disable remote action caching
		// for reruns. Force these observations local until RE can provide a
		// per-observation action nonce and prove deduplication is disabled.
		if executor.mode == "remote" {
			return nil, errors.New("independent reruns require local execution; remote action deduplication is not configured")
		}
		args = append(args, "--no-remote-cache")
		if executor.mode == "default" {
			args = append(args, "--local-only")
		}
	}
	switch executor.mode {
	case "local":
		args = append(args, "--local-only")
	case "remote":
		args = append(args, "--remote-only")
	}
	args = append(args, "@"+targetsPath)
	runner := executor.runCommand
	if runner == nil {
		runner = runBuckCommand
	}
	started := time.Now()
	commandStdout, commandStderr, commandErr := runner(executionContext, executor.command, args, directory)
	elapsed := time.Since(started)

	summary, parseErr := parseBuckEventLog(eventLogPath)
	if commandErr != nil {
		diagnostic := boundedDiagnostic(commandStderr, 4<<10)
		if diagnostic == "" {
			diagnostic = boundedDiagnostic(commandStdout, 4<<10)
		}
		fmt.Fprintf(output, "Buck command returned %v", commandErr)
		if diagnostic != "" {
			fmt.Fprintf(output, ": %s", diagnostic)
		}
		fmt.Fprintln(output)
	}
	if parseErr != nil {
		fmt.Fprintf(output, "Buck event log was unusable: %v\n", parseErr)
	}
	complete := parseErr == nil && summary.endExitCode != nil
	results := make([]testExecution, 0, len(claimed.Tests))
	for _, test := range claimed.Tests {
		aggregate, found := summary.targets[test.Label]
		outcome := "infra_failure"
		durationMS := int(elapsed.Milliseconds())
		if complete && found && aggregate.seen {
			outcome = buckOutcomeName(aggregate.rank)
			durationMS = microsecondsToMilliseconds(aggregate.durationUS)
		}
		results = append(results, testExecution{
			TestID:     test.ID,
			Outcome:    outcome,
			DurationMS: durationMS,
		})
		fmt.Fprintf(output, "%s: %s on %s at lease %d\n", outcome, test.Label, claimed.Platform, claimed.LeaseToken)
	}
	return results, nil
}

// parseBuckEventLog streams only TestResult and EndOfTestResults records.
func parseBuckEventLog(path string) (buckEventSummary, error) {
	summary := buckEventSummary{targets: make(map[string]buckTargetAggregate)}
	input, err := os.Open(path)
	if err != nil {
		return summary, err
	}
	defer input.Close()
	decoder := json.NewDecoder(input)
	for {
		var record buckEventRecord
		if err := decoder.Decode(&record); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return summary, fmt.Errorf("decode Buck event: %w", err)
		}
		if record.Event == nil || record.Event.Data.Instant == nil {
			continue
		}
		instant := record.Event.Data.Instant.Data
		if instant.EndOfTestResults != nil {
			if summary.endExitCode != nil {
				return summary, errors.New("Buck event log contains multiple EndOfTestResults records")
			}
			exitCode := instant.EndOfTestResults.ExitCode
			summary.endExitCode = &exitCode
		}
		if instant.TestResult == nil {
			continue
		}
		result := instant.TestResult
		label := configuredTargetLabel(result)
		if label == "" {
			return summary, fmt.Errorf("Buck test result %q has no target label", result.Name)
		}
		aggregate := summary.targets[label]
		aggregate.seen = true
		rank := buckStatusRank(result.Status)
		if rank > aggregate.rank {
			aggregate.rank = rank
		}
		if result.DurationUS < 0 || result.DurationUS > int64(^uint64(0)>>1)-aggregate.durationUS {
			aggregate.rank = buckOutcomeInfra
		} else {
			aggregate.durationUS += result.DurationUS
		}
		summary.targets[label] = aggregate
	}
	return summary, nil
}

// configuredTargetLabel reconstructs the label spelling used by tdutil.
func configuredTargetLabel(result *buckTestResult) string {
	if result.Target.Label.Package == "" || result.Target.Label.Name == "" {
		return ""
	}
	return result.Target.Label.Package + ":" + result.Target.Label.Name
}

// buckStatusRank maps Buck's TestStatus discriminants to target-level policy.
func buckStatusRank(status int) int {
	// Buck statuses: 1 pass, 2 fail, 3 skip, 4 fatal, 5 timeout,
	// 7 omitted, and 8 infrastructure failure. A skipped/omitted case is not
	// a passing execution and cannot supply FACF evidence. Conservatively mark
	// the target incomplete even when some of its other cases did execute.
	switch status {
	case 1:
		return buckOutcomePass
	case 2:
		return buckOutcomeFail
	default:
		return buckOutcomeInfra
	}
}

func buckOutcomeName(rank int) string {
	switch rank {
	case buckOutcomePass:
		return "pass"
	case buckOutcomeFail:
		return "fail"
	default:
		return "infra_failure"
	}
}

func microsecondsToMilliseconds(duration int64) int {
	if duration <= 0 {
		return 0
	}
	milliseconds := duration / 1_000
	if duration%1_000 != 0 {
		milliseconds++
	}
	return int(milliseconds)
}

// verifyWorkingRevision compares the job endpoint with the local JJ checkout.
func verifyWorkingRevision(ctx context.Context, jjCommand, revision string) error {
	want, err := resolveJJCommit(ctx, jjCommand, revision)
	if err != nil {
		return fmt.Errorf("resolve job revision %q: %w", revision, err)
	}
	current, err := resolveJJCommit(ctx, jjCommand, "@")
	if err != nil {
		return fmt.Errorf("resolve working-copy revision: %w", err)
	}
	if current != want {
		return fmt.Errorf("working-copy commit %s does not match job commit %s", current, want)
	}
	return nil
}

func resolveJJCommit(ctx context.Context, jjCommand, revision string) (string, error) {
	// Do not use JJ's --ignore-working-copy option here. Its normal snapshot is
	// what makes an uncommitted filesystem edit change @ and fail the equality
	// check against an immutable queued commit.
	command := exec.CommandContext(
		ctx,
		jjCommand,
		"log",
		"--no-graph",
		"--revisions", revision,
		"--template", `commit_id ++ "\n"`,
	)
	command.WaitDelay = time.Second
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		diagnostic := boundedDiagnostic(stderr.Bytes(), 4<<10)
		if diagnostic == "" {
			return "", err
		}
		return "", fmt.Errorf("%w: %s", err, diagnostic)
	}
	fields := strings.Fields(stdout.String())
	if len(fields) != 1 {
		return "", fmt.Errorf("revision resolved to %d commits", len(fields))
	}
	return fields[0], nil
}

func runBuckCommand(ctx context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
	return runCapturedCommand(ctx, command, args, directory, commandDiagnosticLimit, false)
}

func fakeTestOutcome(label string) (string, int) {
	switch label {
	case "root//service:integration":
		return "fail", 15
	case "root//cli:smoke":
		return "pass", 5
	default:
		return "pass", 10
	}
}
