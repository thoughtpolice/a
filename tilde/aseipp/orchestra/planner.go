// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This module adapts tdutil's repository-level affected-target document into
// Orchestra's durable target manifest. It deliberately stops at planning:
// Buck execution is a separate adapter and flake-aware culprit inference is a
// later policy, while the fake planner keeps control-plane tests hermetic.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	targetManifestVersion = 2
	maxManifestTests      = 10_000
	defaultAgentLease     = 5 * time.Minute
	defaultPlannerTimeout = 4*time.Minute + 30*time.Second
	minimumAgentLease     = time.Second
	maximumAgentLease     = 5 * time.Minute
	maximumBackendTimeout = 24 * time.Hour
	// Adaptive Workflow polling can leave a 30-second gap before follow-up jobs.
	// Keep draining agents warm across that gap, with room for reconciliation.
	defaultIdleGrace    = time.Minute
	defaultPollInterval = 250 * time.Millisecond
	defaultDemoTimeout  = 2 * time.Minute
)

// agentOptions configures one queue-draining external agent process.
type agentOptions struct {
	Context          context.Context
	Queue            string
	AgentID          string
	Drain            bool
	RetryCompletions bool
	Lease            time.Duration
	Planner          manifestPlanner
	Executor         testExecutor
	Platforms        []string
	Kinds            []string
	IdleGrace        time.Duration
	PollInterval     time.Duration
	UntilRepo        string
	UntilEpoch       string
	Timeout          time.Duration
}

// manifestPlanner turns one immutable revision interval into a target manifest.
type manifestPlanner interface {
	Plan(context.Context, *string, string) (targetManifest, error)
}

// plannerOptions are shared by the standalone plan command and tdutil agent.
type plannerOptions struct {
	Kind        string
	TDUtilPath  string
	BuckPath    string
	JJPath      string
	Universes   []string
	Platform    string
	InitialBase string
	Workspaces  revisionWorkspaceProvider
	Timeout     time.Duration
}

// stringListFlag implements a repeatable standard-library command-line flag.
type stringListFlag []string

func (values *stringListFlag) String() string {
	return strings.Join(*values, ",")
}

func (values *stringListFlag) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("value must not be empty")
	}
	*values = append(*values, value)
	return nil
}

// fakeManifestPlanner returns a deterministic plan without inspecting a repo.
type fakeManifestPlanner struct{}

func (fakeManifestPlanner) Plan(_ context.Context, baseRevision *string, revision string) (targetManifest, error) {
	return fakeManifest(baseRevision, revision)
}

// tdutilCommandRunner is injectable so unit tests can pin the adapter contract.
type tdutilCommandRunner func(context.Context, string, []string, string) ([]byte, []byte, error)

// tdutilManifestPlanner invokes tdutil directly, with no shell or wrapper CLI.
type tdutilManifestPlanner struct {
	command      string
	buckCommand  string
	jjCommand    string
	universes    []string
	platform     string
	initialBase  string
	workspaces   revisionWorkspaceProvider
	timeout      time.Duration
	runCommand   tdutilCommandRunner
	runJJCommand sourceCommandRunner
}

// tdutilDocument mirrors tdutil --format json, including resolved VCS commits.
type tdutilDocument struct {
	Base       string         `json:"base"`
	Head       string         `json:"head"`
	BaseCommit string         `json:"base_commit"`
	HeadCommit string         `json:"head_commit"`
	Universe   []string       `json:"universe"`
	Count      int            `json:"count"`
	Targets    []tdutilTarget `json:"targets"`
}

// tdutilTarget retains selection provenance for one affected Buck target.
type tdutilTarget struct {
	Target      string  `json:"target"`
	RuleType    string  `json:"rule_type"`
	Depth       int     `json:"depth"`
	Reason      string  `json:"reason"`
	AffectedDep *string `json:"affected_dep"`
}

// newManifestPlanner validates flags and constructs the selected backend.
func newManifestPlanner(options plannerOptions) (manifestPlanner, error) {
	switch options.Kind {
	case "fake":
		return fakeManifestPlanner{}, nil
	case "tdutil":
		if strings.TrimSpace(options.TDUtilPath) == "" {
			return nil, errors.New("--tdutil must name an executable")
		}
		if len(options.Universes) == 0 {
			return nil, errors.New("the tdutil planner requires at least one --universe")
		}
		for _, universe := range options.Universes {
			if strings.TrimSpace(universe) == "" {
				return nil, errors.New("--universe must not be empty")
			}
		}
		if strings.TrimSpace(options.Platform) == "" {
			return nil, errors.New("--platform must not be empty")
		}
		if strings.TrimSpace(options.InitialBase) == "" {
			return nil, errors.New("--initial-base must not be empty")
		}
		if options.Timeout <= 0 || options.Timeout > maximumBackendTimeout {
			return nil, errors.New("--planner-timeout must be positive and at most 24h")
		}
		return tdutilManifestPlanner{
			command:     options.TDUtilPath,
			buckCommand: options.BuckPath,
			jjCommand:   options.JJPath,
			universes:   append([]string(nil), options.Universes...),
			platform:    options.Platform,
			initialBase: options.InitialBase,
			workspaces:  options.Workspaces,
			timeout:     options.Timeout,
			runCommand:  runTDUtilCommand,
		}, nil
	default:
		return nil, fmt.Errorf("unknown planner %q (expected fake or tdutil)", options.Kind)
	}
}

// validateLease bounds each renewable ownership interval independently of a
// backend's total execution timeout; long jobs survive by renewing ownership.
func validateLease(
	lease time.Duration,
	plannerTimeout time.Duration,
	plannerKind string,
	executorTimeout time.Duration,
	executorKind string,
) error {
	if lease < minimumAgentLease || lease > maximumAgentLease {
		return fmt.Errorf("--lease must be between %s and %s", minimumAgentLease, maximumAgentLease)
	}
	if plannerKind == "tdutil" && (plannerTimeout <= 0 || plannerTimeout > maximumBackendTimeout) {
		return errors.New("--planner-timeout must be positive and at most 24h")
	}
	if executorKind == "buck" && (executorTimeout <= 0 || executorTimeout > maximumBackendTimeout) {
		return errors.New("--buck-timeout must be positive and at most 24h")
	}
	return nil
}

// runPlanCommand emits a manifest without requiring a running celld service.
func runPlanCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("plan", flag.ContinueOnError)
	flags.SetOutput(stderr)
	tdutilPath := flags.String("tdutil", "tdutil", "tdutil executable")
	buckPath := flags.String("buck", "buck2", "Buck2 executable used by tdutil")
	jjPath := flags.String("jj", "jj", "JJ executable used by a managed source clone")
	base := flags.String("base", "", "immutable base revision; empty denotes the first epoch")
	revision := flags.String("revision", "", "immutable revision to plan")
	platform := flags.String("platform", hostPlatform(), "execution platform assigned to selected tests")
	initialBase := flags.String("initial-base", "root()", "tdutil base revset used when --base is empty")
	timeout := flags.Duration("timeout", defaultPlannerTimeout, "maximum tdutil duration")
	sourceURL := flags.String("source-url", "", "Git repository URL or path for an agent-managed JJ clone")
	sourceCache := flags.String("source-cache", "", "persistent directory for the agent-managed JJ clone")
	sourceRemote := flags.String("source-remote", "origin", "Git remote name used by the managed clone")
	sourceTimeout := flags.Duration("source-timeout", defaultSourceTimeout, "maximum clone/fetch duration")
	var universes stringListFlag
	flags.Var(&universes, "universe", "Buck universe pattern for tdutil (repeatable)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional argument %q", flags.Arg(0))
	}
	if strings.TrimSpace(*revision) == "" {
		return errors.New("--revision is required")
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
	planner, err := newManifestPlanner(plannerOptions{
		Kind:        "tdutil",
		TDUtilPath:  *tdutilPath,
		BuckPath:    *buckPath,
		Universes:   universes,
		Platform:    *platform,
		InitialBase: *initialBase,
		JJPath:      *jjPath,
		Workspaces:  workspaces,
		Timeout:     *timeout,
	})
	if err != nil {
		return err
	}
	var baseRevision *string
	if *base != "" {
		baseRevision = base
	}
	manifest, err := planner.Plan(context.Background(), baseRevision, *revision)
	if err != nil {
		return err
	}
	return writeJSON(stdout, manifest)
}

// Plan invokes tdutil and normalizes affected Buck test rules into a manifest.
func (planner tdutilManifestPlanner) Plan(
	ctx context.Context,
	baseRevision *string,
	revision string,
) (manifest targetManifest, resultErr error) {
	if strings.TrimSpace(revision) == "" {
		return targetManifest{}, errors.New("planner revision must not be empty")
	}
	commandContext, cancel := context.WithTimeout(ctx, planner.timeout)
	defer cancel()
	directory := ""
	if planner.workspaces != nil {
		workspace, err := planner.workspaces.OpenWorkspace(commandContext, revision)
		if err != nil {
			return targetManifest{}, fmt.Errorf("open tdutil head workspace: %w", err)
		}
		directory = workspace.Directory()
		defer func() {
			cleanupContext, cleanupCancel := context.WithTimeout(
				context.WithoutCancel(ctx),
				sourceWorkspaceCleanupTimeout,
			)
			defer cleanupCancel()
			if cleanupErr := workspace.Close(cleanupContext); cleanupErr != nil {
				if resultErr != nil {
					resultErr = fmt.Errorf("%v; additionally clean tdutil head workspace: %w", resultErr, cleanupErr)
				} else {
					resultErr = fmt.Errorf("clean tdutil head workspace: %w", cleanupErr)
				}
			}
		}()
	}
	return planner.planInDirectory(commandContext, baseRevision, revision, directory)
}

func (planner tdutilManifestPlanner) planInDirectory(
	ctx context.Context,
	baseRevision *string,
	revision string,
	directory string,
) (targetManifest, error) {
	base := planner.initialBase
	if baseRevision != nil {
		base = *baseRevision
	}
	args := []string{
		"--format", "json",
		"--ignore-working-copy",
		"--from", base,
		"--to", revision,
	}
	if planner.buckCommand != "" {
		args = append(args, "--buck", planner.buckCommand)
	}
	for _, universe := range planner.universes {
		args = append(args, "--universe", universe)
	}

	runner := planner.runCommand
	if runner == nil {
		runner = runTDUtilCommand
	}
	stdout, stderr, err := runner(ctx, planner.command, args, directory)
	if err != nil {
		if ctx.Err() != nil {
			return targetManifest{}, fmt.Errorf("tdutil planning %s..%s: %w", base, revision, ctx.Err())
		}
		diagnostic := boundedDiagnostic(stderr, 4<<10)
		if diagnostic == "" {
			return targetManifest{}, fmt.Errorf("tdutil planning %s..%s: %w", base, revision, err)
		}
		return targetManifest{}, fmt.Errorf("tdutil planning %s..%s: %w: %s", base, revision, err, diagnostic)
	}

	var document tdutilDocument
	if err := json.Unmarshal(stdout, &document); err != nil {
		return targetManifest{}, fmt.Errorf("decode tdutil JSON: %w", err)
	}
	if document.Base != base || document.Head != revision {
		return targetManifest{}, fmt.Errorf(
			"tdutil returned endpoints %q..%q, want %q..%q",
			document.Base,
			document.Head,
			base,
			revision,
		)
	}
	if document.BaseCommit == "" || document.HeadCommit == "" {
		return targetManifest{}, errors.New("tdutil returned an empty resolved commit")
	}
	if document.Count != len(document.Targets) {
		return targetManifest{}, fmt.Errorf("tdutil count is %d but returned %d targets", document.Count, len(document.Targets))
	}
	if len(document.Universe) == 0 {
		return targetManifest{}, errors.New("tdutil returned an empty universe")
	}
	for index, universe := range document.Universe {
		if strings.TrimSpace(universe) == "" {
			return targetManifest{}, fmt.Errorf("tdutil universe %d is empty", index)
		}
	}
	seen := make(map[string]struct{}, len(document.Targets))
	selected := make([]tdutilTarget, 0, len(document.Targets))
	for index, target := range document.Targets {
		if target.Target == "" || target.RuleType == "" || target.Reason == "" {
			return targetManifest{}, fmt.Errorf("tdutil target %d is missing target, rule_type, or reason", index)
		}
		if _, duplicate := seen[target.Target]; duplicate {
			return targetManifest{}, fmt.Errorf("tdutil returned duplicate target %s", target.Target)
		}
		seen[target.Target] = struct{}{}
		if target.Depth < 0 {
			return targetManifest{}, fmt.Errorf("tdutil target %s has negative depth", target.Target)
		}
		if (target.Depth == 0) != (target.AffectedDep == nil) {
			return targetManifest{}, fmt.Errorf("tdutil target %s has inconsistent depth and affected_dep", target.Target)
		}
		if target.AffectedDep != nil && *target.AffectedDep == "" {
			return targetManifest{}, fmt.Errorf("tdutil target %s has an empty affected_dep", target.Target)
		}
		if isBuckTestRule(target.RuleType) {
			selected = append(selected, target)
		}
	}
	if len(selected) > maxManifestTests {
		return targetManifest{}, fmt.Errorf("tdutil selected %d tests; maximum is %d", len(selected), maxManifestTests)
	}
	sort.Slice(selected, func(left, right int) bool {
		return selected[left].Target < selected[right].Target
	})

	tests := make([]plannedTest, 0, len(selected))
	for _, target := range selected {
		id, testKey := stableTestIdentity(planner.platform, target.Target)
		changed := target.Depth == 0
		tests = append(tests, plannedTest{
			ID:                 id,
			TestKey:            testKey,
			Label:              target.Target,
			RuleType:           target.RuleType,
			Platform:           planner.platform,
			Changed:            &changed,
			SelectionDepth:     target.Depth,
			SelectionReason:    target.Reason,
			AffectedDependency: cloneStringPointer(target.AffectedDep),
		})
	}
	return newTargetManifest(
		baseRevision,
		revision,
		document.BaseCommit,
		document.HeadCommit,
		document.Universe,
		tests,
	)
}

// isBuckTestRule mirrors the repository's documented kind('.*_test', ...) filter.
func isBuckTestRule(ruleType string) bool {
	shortName := ruleType
	if separator := strings.LastIndexByte(shortName, ':'); separator >= 0 {
		shortName = shortName[separator+1:]
	}
	return strings.Contains(shortName, "_test")
}

// stableTestIdentity separates long-lived identity from an epoch-local handle.
func stableTestIdentity(platform, label string) (string, string) {
	digest := sha256.Sum256([]byte(platform + "\x00" + label))
	hexDigest := fmt.Sprintf("%x", digest)
	return "t-" + hexDigest, "buck-test:v1:sha256:" + hexDigest
}

// newTargetManifest hashes the normalized content, excluding only the digest.
func newTargetManifest(
	baseRevision *string,
	revision string,
	baseCommit string,
	revisionCommit string,
	universe []string,
	tests []plannedTest,
) (targetManifest, error) {
	content := struct {
		Version        int           `json:"version"`
		BaseRevision   *string       `json:"base_revision"`
		Revision       string        `json:"revision"`
		BaseCommit     string        `json:"base_commit"`
		RevisionCommit string        `json:"revision_commit"`
		Universe       []string      `json:"universe"`
		Tests          []plannedTest `json:"tests"`
	}{
		Version:        targetManifestVersion,
		BaseRevision:   cloneStringPointer(baseRevision),
		Revision:       revision,
		BaseCommit:     baseCommit,
		RevisionCommit: revisionCommit,
		Universe:       append([]string(nil), universe...),
		Tests:          append([]plannedTest{}, tests...),
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return targetManifest{}, fmt.Errorf("encode target manifest: %w", err)
	}
	return targetManifest{
		Version:        content.Version,
		Digest:         fmt.Sprintf("sha256:%x", sha256.Sum256(encoded)),
		BaseRevision:   content.BaseRevision,
		Revision:       content.Revision,
		BaseCommit:     content.BaseCommit,
		RevisionCommit: content.RevisionCommit,
		Universe:       content.Universe,
		Tests:          content.Tests,
	}, nil
}

// fakeManifest supplies predictable selection provenance for E2E tests.
func fakeManifest(baseRevision *string, revision string) (targetManifest, error) {
	changed := true
	unchanged := false
	affectedDependency := "root//lib:unit"
	tests := []plannedTest{
		{
			ID:                 "t0001",
			TestKey:            fakeTestKey("linux-x86_64", "root//lib:unit"),
			Label:              "root//lib:unit",
			RuleType:           "prelude//rules.bzl:rust_test",
			Platform:           "linux-x86_64",
			Changed:            &changed,
			SelectionDepth:     0,
			SelectionReason:    "input `lib/lib.rs` changed",
			AffectedDependency: nil,
		},
		{
			ID:                 "t0002",
			TestKey:            fakeTestKey("linux-x86_64", "root//service:integration"),
			Label:              "root//service:integration",
			RuleType:           "prelude//rules.bzl:rust_test",
			Platform:           "linux-x86_64",
			Changed:            &unchanged,
			SelectionDepth:     1,
			SelectionReason:    "input `lib/lib.rs` changed",
			AffectedDependency: &affectedDependency,
		},
		{
			ID:                 "t0003",
			TestKey:            fakeTestKey("darwin-arm64", "root//cli:smoke"),
			Label:              "root//cli:smoke",
			RuleType:           "prelude//rules.bzl:rust_test",
			Platform:           "darwin-arm64",
			Changed:            &changed,
			SelectionDepth:     0,
			SelectionReason:    "target definition changed",
			AffectedDependency: nil,
		},
	}
	baseCommit := "root-commit"
	if baseRevision != nil {
		baseCommit = *baseRevision
	}
	return newTargetManifest(baseRevision, revision, baseCommit, revision, []string{"root//..."}, tests)
}

func fakeTestKey(platform, label string) string {
	_, key := stableTestIdentity(platform, label)
	return key
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func runTDUtilCommand(ctx context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
	return runCapturedCommand(ctx, command, args, directory, tdutilJSONLimit, true)
}

func boundedDiagnostic(contents []byte, maximum int) string {
	if len(contents) > maximum {
		contents = contents[:maximum]
	}
	return strings.TrimSpace(string(contents))
}

func hostPlatform() string {
	osName := runtime.GOOS
	if osName == "darwin" {
		osName = "macos"
	}
	architecture := runtime.GOARCH
	if architecture == "amd64" {
		architecture = "x86_64"
	} else if architecture == "arm64" {
		architecture = "aarch64"
	}
	return osName + "-" + architecture
}
