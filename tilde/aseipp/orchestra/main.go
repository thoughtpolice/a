// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type client struct {
	baseURL string
	http    *http.Client
}

type seedRequest struct {
	Revision string `json:"revision"`
	Queue    string `json:"queue"`
}

type seedResponse struct {
	Repo     string `json:"repo"`
	Revision string `json:"revision"`
	EpochID  string `json:"epoch_id"`
	Created  bool   `json:"created"`
}

type job struct {
	ID             string        `json:"id"`
	Kind           string        `json:"kind"`
	BaseRevision   *string       `json:"base_revision"`
	Revision       string        `json:"revision"`
	ManifestDigest string        `json:"manifest_digest"`
	BatchID        string        `json:"batch_id"`
	Platform       string        `json:"platform"`
	Shard          int           `json:"shard"`
	Tests          []plannedTest `json:"tests"`
	LeaseToken     int           `json:"lease_token"`
	LeaseUntil     int64         `json:"lease_until"`
	AgentID        string        `json:"agent_id"`
	Purpose        string        `json:"purpose,omitempty"`
	Round          int           `json:"round,omitempty"`
}

// artifactRef identifies an immutable JSON result stored in Orchestra's R2
// bucket. Agents verify every returned field before acknowledging their lease.
type artifactRef struct {
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

type plannedTest struct {
	ID                 string  `json:"id"`
	TestKey            string  `json:"test_key"`
	Label              string  `json:"label"`
	RuleType           string  `json:"rule_type,omitempty"`
	Platform           string  `json:"platform,omitempty"`
	Changed            *bool   `json:"changed,omitempty"`
	SelectionDepth     int     `json:"selection_depth"`
	SelectionReason    string  `json:"selection_reason,omitempty"`
	AffectedDependency *string `json:"affected_dependency"`
}

type targetManifest struct {
	Version        int           `json:"version"`
	Digest         string        `json:"digest"`
	BaseRevision   *string       `json:"base_revision"`
	Revision       string        `json:"revision"`
	BaseCommit     string        `json:"base_commit"`
	RevisionCommit string        `json:"revision_commit"`
	Universe       []string      `json:"universe"`
	Tests          []plannedTest `json:"tests"`
}

type testExecution struct {
	TestID     string `json:"test_id"`
	Outcome    string `json:"outcome"`
	DurationMS int    `json:"duration_ms"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "orchestra: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stderr)
		return errors.New("a command is required")
	}
	switch args[0] {
	case "seed":
		return runSeed(args[1:], stdout, stderr)
	case "agent":
		return runAgentCommand(args[1:], stdout, stderr)
	case "plan":
		return runPlanCommand(args[1:], stdout, stderr)
	case "execute":
		return runExecuteCommand(args[1:], stdout, stderr)
	case "show":
		return runShow(args[1:], stdout, stderr)
	case "queue":
		return runQueue(args[1:], stdout, stderr)
	case "demo":
		return runDemo(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		usage(stdout)
		return nil
	default:
		usage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage(output io.Writer) {
	fmt.Fprintln(output, "usage: orchestra <seed|plan|execute|agent|show|queue|demo> [options]")
}

func newClient(rawURL string) (*client, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid service URL %q", rawURL)
	}
	return &client{
		baseURL: strings.TrimRight(rawURL, "/"),
		http:    &http.Client{Timeout: 20 * time.Second},
	}, nil
}

func commonFlags(name string, stderr io.Writer) (*flag.FlagSet, *string) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	serviceURL := flags.String("url", "http://127.0.0.1:8080", "orchestra service URL")
	return flags, serviceURL
}

func fakeSeed(revision, queue string) seedRequest {
	return seedRequest{
		Revision: revision,
		Queue:    queue,
	}
}

func runSeed(args []string, stdout, stderr io.Writer) error {
	flags, serviceURL := commonFlags("seed", stderr)
	repo := flags.String("repo", "demo", "repository name")
	revision := flags.String("revision", "fake-0001", "immutable revision")
	queue := flags.String("queue", "default", "runner queue")
	if err := flags.Parse(args); err != nil {
		return err
	}
	c, err := newClient(*serviceURL)
	if err != nil {
		return err
	}
	created, err := c.seed(*repo, fakeSeed(*revision, *queue))
	if err != nil {
		return err
	}
	return writeJSON(stdout, created)
}

func runAgentCommand(args []string, stdout, stderr io.Writer) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	flags, serviceURL := commonFlags("agent", stderr)
	queue := flags.String("queue", "default", "runner queue")
	agentID := flags.String("agent", "local-agent", "agent identity")
	drain := flags.Bool("drain", true, "exit after the queue stays empty for --idle-grace")
	idleGrace := flags.Duration("idle-grace", defaultIdleGrace, "continuous idle time before a draining agent exits")
	pollInterval := flags.Duration("poll-interval", defaultPollInterval, "delay between idle queue polls")
	retryCompletions := flags.Bool("retry-completions", false, "repeat successful completions to verify idempotency")
	plannerKind := flags.String("planner", "fake", "planning backend: fake or tdutil")
	tdutilPath := flags.String("tdutil", "tdutil", "tdutil executable used by the real planner")
	platform := flags.String("platform", hostPlatform(), "execution platform assigned to selected tests")
	initialBase := flags.String("initial-base", "root()", "tdutil base revset for the repository's first epoch")
	plannerTimeout := flags.Duration("planner-timeout", defaultPlannerTimeout, "maximum duration of one tdutil plan")
	executorKind := flags.String("executor", "fake", "test execution backend: fake or buck")
	buckPath := flags.String("buck", "buck2", "Buck2 executable used by the real executor")
	jjPath := flags.String("jj", "jj", "JJ executable used for checkout verification and managed workspaces")
	buckMode := flags.String("buck-mode", "local", "Buck execution mode: default, local, or remote")
	buckIsolationDir := flags.String("buck-isolation-dir", "orchestra-agent", "Buck daemon isolation directory")
	buckTimeout := flags.Duration("buck-timeout", defaultExecutorTimeout, "maximum duration of one Buck test batch")
	sourceURL := flags.String("source-url", "", "Git repository URL or path for an agent-managed JJ clone")
	sourceCache := flags.String("source-cache", "", "persistent directory for the agent-managed JJ clone")
	sourceRemote := flags.String("source-remote", "origin", "Git remote name used by the managed clone")
	sourceTimeout := flags.Duration("source-timeout", defaultSourceTimeout, "maximum clone/fetch duration before queue draining")
	lease := flags.Duration("lease", defaultAgentLease, "renewable ownership window requested for each job")
	var universes stringListFlag
	flags.Var(&universes, "universe", "Buck universe pattern for tdutil (repeatable)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	sourceRepository, created, sourceErr := prepareJJSourceRepository(
		ctx,
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
	if sourceRepository != nil {
		action := "refreshed"
		if created {
			action = "cloned"
		}
		fmt.Fprintf(stderr, "%s source repository at %s\n", action, sourceRepository.Directory())
	}
	var workspaces revisionWorkspaceProvider
	if sourceRepository != nil {
		workspaces = sourceRepository
	}
	planner, err := newManifestPlanner(plannerOptions{
		Kind:        *plannerKind,
		TDUtilPath:  *tdutilPath,
		BuckPath:    *buckPath,
		Universes:   universes,
		Platform:    *platform,
		InitialBase: *initialBase,
		JJPath:      *jjPath,
		Workspaces:  workspaces,
		Timeout:     *plannerTimeout,
	})
	if err != nil {
		return err
	}
	if *idleGrace <= 0 || *pollInterval <= 0 {
		return errors.New("--idle-grace and --poll-interval must be positive")
	}
	if *executorKind == "buck" && *platform != hostPlatform() {
		return fmt.Errorf("Buck agents require --platform %s; cross-platform execution is not configured", hostPlatform())
	}
	executor, err := newTestExecutor(executorOptions{
		Kind:         *executorKind,
		BuckPath:     *buckPath,
		JJPath:       *jjPath,
		Mode:         *buckMode,
		IsolationDir: *buckIsolationDir,
		Timeout:      *buckTimeout,
		Workspaces:   workspaces,
	})
	if err != nil {
		return err
	}
	if err := validateLease(
		*lease,
		*plannerTimeout,
		*plannerKind,
		*buckTimeout,
		*executorKind,
	); err != nil {
		return err
	}
	c, err := newClient(*serviceURL)
	if err != nil {
		return err
	}
	count, err := c.runAgent(agentOptions{
		Context:          ctx,
		Queue:            *queue,
		AgentID:          *agentID,
		Drain:            *drain,
		RetryCompletions: *retryCompletions,
		Lease:            *lease,
		Planner:          planner,
		Executor:         executor,
		Platforms:        agentPlatforms(*plannerKind, *executorKind, *platform),
		IdleGrace:        *idleGrace,
		PollInterval:     *pollInterval,
	}, stdout)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "agent %s completed %d job(s)\n", *agentID, count)
	return nil
}

func runShow(args []string, stdout, stderr io.Writer) error {
	flags, serviceURL := commonFlags("show", stderr)
	repo := flags.String("repo", "demo", "repository name")
	epoch := flags.String("epoch", "", "epoch id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *epoch == "" {
		return errors.New("--epoch is required")
	}
	c, err := newClient(*serviceURL)
	if err != nil {
		return err
	}
	var value any
	if _, err := c.request(http.MethodGet, "/v1/repos/"+url.PathEscape(*repo)+"/epochs/"+url.PathEscape(*epoch), nil, &value); err != nil {
		return err
	}
	return writeJSON(stdout, value)
}

func runQueue(args []string, stdout, stderr io.Writer) error {
	flags, serviceURL := commonFlags("queue", stderr)
	queue := flags.String("queue", "default", "runner queue")
	if err := flags.Parse(args); err != nil {
		return err
	}
	c, err := newClient(*serviceURL)
	if err != nil {
		return err
	}
	var value any
	if _, err := c.request(http.MethodGet, "/v1/queues/"+url.PathEscape(*queue), nil, &value); err != nil {
		return err
	}
	return writeJSON(stdout, value)
}

func runDemo(args []string, stdout, stderr io.Writer) error {
	flags, serviceURL := commonFlags("demo", stderr)
	repo := flags.String("repo", "demo", "repository name")
	revision := flags.String("revision", "fake-0001", "immutable revision")
	queue := flags.String("queue", "default", "runner queue")
	agentID := flags.String("agent", "demo-agent", "agent identity")
	retryCompletions := flags.Bool("retry-completions", false, "repeat successful completions to verify idempotency")
	timeout := flags.Duration("timeout", defaultDemoTimeout, "maximum time to wait for the seeded epoch to finish")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *timeout <= 0 {
		return errors.New("--timeout must be positive")
	}
	c, err := newClient(*serviceURL)
	if err != nil {
		return err
	}
	created, err := c.seed(*repo, fakeSeed(*revision, *queue))
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "epoch %s at %s (created=%t)\n", created.EpochID, created.Revision, created.Created)
	retried, err := c.seed(*repo, fakeSeed(*revision, *queue))
	if err != nil {
		return err
	}
	if retried.EpochID != created.EpochID || retried.Created {
		return fmt.Errorf("revision retry was not idempotent: %#v", retried)
	}
	fmt.Fprintf(stdout, "revision retry reused epoch %s\n", retried.EpochID)
	count, err := c.runAgent(agentOptions{
		Queue:            *queue,
		AgentID:          *agentID,
		Drain:            true,
		RetryCompletions: *retryCompletions,
		Lease:            defaultAgentLease,
		Planner:          fakeManifestPlanner{},
		Executor:         fakeTestExecutor{},
		UntilRepo:        *repo,
		UntilEpoch:       created.EpochID,
		Timeout:          *timeout,
	}, stdout)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "agent %s completed %d job(s)\n", *agentID, count)
	var epoch any
	if _, err := c.request(http.MethodGet, "/v1/repos/"+url.PathEscape(*repo)+"/epochs/"+url.PathEscape(created.EpochID), nil, &epoch); err != nil {
		return err
	}
	return writeJSON(stdout, epoch)
}

func (c *client) seed(repo string, request seedRequest) (seedResponse, error) {
	var response seedResponse
	_, err := c.request(http.MethodPost, "/v1/repos/"+url.PathEscape(repo)+"/epochs", request, &response)
	return response, err
}

func (c *client) runAgent(options agentOptions, output io.Writer) (int, error) {
	if options.IdleGrace <= 0 {
		options.IdleGrace = defaultIdleGrace
	}
	if options.PollInterval <= 0 {
		options.PollInterval = defaultPollInterval
	}
	if len(options.Platforms) == 0 {
		options.Platforms = agentPlatformsForBackends(options.Planner, options.Executor)
	}
	if len(options.Kinds) == 0 {
		options.Kinds = []string{"plan_epoch", "run_tests"}
		if _, supported := options.Planner.(culpritPlanner); supported {
			options.Kinds = append(options.Kinds, "plan_culprit")
		}
	}
	ctx := options.Context
	if ctx == nil {
		ctx = context.Background()
	}
	if options.Lease == 0 {
		options.Lease = defaultAgentLease
	}
	if options.UntilEpoch != "" && options.Timeout <= 0 {
		options.Timeout = defaultDemoTimeout
	}
	if options.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, options.Timeout)
		defer cancel()
	}
	completed := 0
	var idleSince time.Time
	for {
		if err := ctx.Err(); err != nil {
			return completed, fmt.Errorf("agent waiting for work or epoch completion: %w", err)
		}
		if options.UntilEpoch != "" {
			var epoch struct {
				State string `json:"state"`
			}
			if _, err := c.requestContext(ctx, http.MethodGet, "/v1/repos/"+url.PathEscape(options.UntilRepo)+"/epochs/"+url.PathEscape(options.UntilEpoch), nil, &epoch); err != nil {
				return completed, err
			}
			if epoch.State == "complete" {
				return completed, nil
			}
			if epoch.State == "failed" {
				return completed, fmt.Errorf("epoch %s failed", options.UntilEpoch)
			}
		}
		var claimed job
		claimStarted := time.Now()
		status, err := c.requestContext(ctx, http.MethodPost, "/v1/queues/"+url.PathEscape(options.Queue)+"/claim", map[string]any{
			"agent_id":  options.AgentID,
			"lease_ms":  options.Lease.Milliseconds(),
			"platforms": options.Platforms,
			"kinds":     options.Kinds,
		}, &claimed)
		if err != nil {
			return completed, err
		}
		if status == http.StatusNoContent {
			if idleSince.IsZero() {
				idleSince = time.Now()
			}
			if options.Drain && options.UntilEpoch == "" && time.Since(idleSince) >= options.IdleGrace {
				return completed, nil
			}
			if err := waitForAgentPoll(ctx, options.PollInterval); err != nil {
				return completed, fmt.Errorf("agent waiting for work or epoch completion: %w", err)
			}
			continue
		}
		idleSince = time.Time{}
		if !containsString(options.Kinds, claimed.Kind) {
			return completed, fmt.Errorf("server leased unadvertised job kind %q", claimed.Kind)
		}
		if claimed.Kind != "plan_epoch" && !containsString(options.Platforms, claimed.Platform) {
			return completed, fmt.Errorf("server leased incompatible platform %q", claimed.Platform)
		}
		if err := c.runLeasedJob(ctx, options, claimed, claimStarted, output); err != nil {
			return completed, err
		}
		completed++
		if !options.Drain {
			return completed, nil
		}
	}
}

// runLeasedJob keeps ownership live across computation and artifact storage.
// Only backend errors while still owning the lease become durable job_error
// evidence; cancellation or uncertain ownership leaves reclamation to the broker.
func (c *client) runLeasedJob(ctx context.Context, options agentOptions, claimed job, started time.Time, output io.Writer) error {
	lease, err := c.startJobLease(ctx, options, claimed, started)
	if err != nil {
		return err
	}
	defer lease.close()
	result, err := jobResult(lease.ctx, claimed, options.Planner, options.Executor, output)
	if ownershipErr := lease.err(); ownershipErr != nil {
		return ownershipErr
	}
	if err != nil {
		fmt.Fprintf(output, "job %s: %v\n", claimed.ID, err)
		result = struct {
			Kind    string `json:"kind"`
			Message string `json:"message"`
		}{Kind: "job_error", Message: boundedDiagnostic([]byte(err.Error()), 4<<10)}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode job result: %w", err)
	}
	ref, err := c.uploadArtifact(lease.ctx, encoded)
	if ownershipErr := lease.err(); ownershipErr != nil {
		return ownershipErr
	}
	if err != nil {
		return err
	}
	completion := map[string]any{
		"job_id": claimed.ID, "agent_id": options.AgentID,
		"lease_token": claimed.LeaseToken, "result_ref": ref,
	}
	return lease.complete(c, options.Queue, func(completionContext context.Context) error {
		path := "/v1/queues/" + url.PathEscape(options.Queue) + "/complete"
		if _, err := c.requestContext(completionContext, http.MethodPost, path, completion, nil); err != nil {
			return err
		}
		if options.RetryCompletions {
			if _, err := c.uploadArtifact(completionContext, encoded); err != nil {
				return fmt.Errorf("retry artifact for %s: %w", claimed.ID, err)
			}
			if _, err := c.requestContext(completionContext, http.MethodPost, path, completion, nil); err != nil {
				return fmt.Errorf("retry completion for %s: %w", claimed.ID, err)
			}
		}
		return nil
	})
}

// uploadArtifact uses content-addressed R2 storage as the bulk-result boundary;
// only a verified, small immutable reference enters the leased work queue.
func (c *client) uploadArtifact(ctx context.Context, contents []byte) (artifactRef, error) {
	var ref artifactRef
	if _, err := c.requestBytesContext(ctx, http.MethodPost, "/v1/artifacts", contents, &ref); err != nil {
		return artifactRef{}, fmt.Errorf("upload result artifact: %w", err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(contents))
	if ref.SHA256 != digest || ref.Size != len(contents) || ref.Key != "sha256/"+digest+".json" {
		return artifactRef{}, fmt.Errorf("server returned an invalid result artifact reference: %#v", ref)
	}
	return ref, nil
}

// waitForAgentPoll makes asynchronous fanout waits bounded by the caller's
// deadline without confusing a temporarily empty lease index with completion.
func waitForAgentPoll(ctx context.Context, interval time.Duration) error {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// agentPlatforms restricts real planning/execution to its configured platform;
// only the hermetic fake adapter advertises the demo's virtual platforms.
func agentPlatforms(plannerKind, executorKind, platform string) []string {
	if executorKind == "buck" {
		return []string{hostPlatform()}
	}
	if plannerKind == "tdutil" {
		return []string{platform}
	}
	return []string{"linux-x86_64", "darwin-arm64"}
}

func agentPlatformsForBackends(planner manifestPlanner, executor testExecutor) []string {
	if backend, real := executor.(buckTestExecutor); real {
		return []string{backend.hostPlatform}
	}
	if backend, real := planner.(tdutilManifestPlanner); real {
		return []string{backend.platform}
	}
	return agentPlatforms("fake", "fake", "")
}

func jobResult(
	ctx context.Context,
	claimed job,
	planner manifestPlanner,
	executor testExecutor,
	output io.Writer,
) (any, error) {
	switch claimed.Kind {
	case "plan_epoch":
		manifest, err := planner.Plan(ctx, claimed.BaseRevision, claimed.Revision)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(output, "planned %d tests for %s at lease %d (%s)\n", len(manifest.Tests), claimed.Revision, claimed.LeaseToken, manifest.Digest)
		return struct {
			Kind     string         `json:"kind"`
			Manifest targetManifest `json:"manifest"`
		}{Kind: "plan_epoch", Manifest: manifest}, nil
	case "run_tests":
		results, err := executor.Execute(ctx, claimed, output)
		if err != nil {
			return nil, err
		}
		return struct {
			Kind  string          `json:"kind"`
			Tests []testExecution `json:"tests"`
		}{Kind: "run_tests", Tests: results}, nil
	case "plan_culprit":
		backend, supported := planner.(culpritPlanner)
		if !supported {
			return nil, errors.New("configured planner does not support culprit intervals")
		}
		plan, err := backend.PlanCulprit(ctx, claimed)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(output, "planned %d culprit suspects for %s at lease %d\n", len(plan.Suspects), claimed.Revision, claimed.LeaseToken)
		return struct {
			Kind string      `json:"kind"`
			Plan culpritPlan `json:"plan"`
		}{Kind: "plan_culprit", Plan: plan}, nil
	default:
		return nil, fmt.Errorf("agent received unsupported job kind %q", claimed.Kind)
	}
}

func (c *client) request(method, path string, input, output any) (int, error) {
	return c.requestContext(context.Background(), method, path, input, output)
}

func (c *client) requestContext(ctx context.Context, method, path string, input, output any) (int, error) {
	var encoded []byte
	if input != nil {
		var err error
		encoded, err = json.Marshal(input)
		if err != nil {
			return 0, err
		}
	}
	return c.requestBytesContext(ctx, method, path, encoded, output)
}

// requestBytesContext sends pre-encoded JSON without reformatting it, preserving
// exactly the bytes whose digest is used for immutable artifact references.
func (c *client) requestBytesContext(ctx context.Context, method, path string, encoded []byte, output any) (int, error) {
	var body io.Reader
	if encoded != nil {
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return 0, err
	}
	if encoded != nil {
		request.Header.Set("content-type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return response.StatusCode, nil
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return response.StatusCode, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("%s %s: %s", method, path, strings.TrimSpace(string(contents)))
	}
	if output != nil && len(contents) > 0 {
		if err := json.Unmarshal(contents, output); err != nil {
			return response.StatusCode, fmt.Errorf("decode response: %w", err)
		}
	}
	return response.StatusCode, nil
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
