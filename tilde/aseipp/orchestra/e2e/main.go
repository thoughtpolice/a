// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Package main contains Orchestra's black-box celld test harness.
//
// chaos3's shared LocalResourceInfo setup supplies the already-running S3 server
// and credentials. This harness owns only Orchestra deployment and assertions.
//
// The deploy command publishes the Queue consumer before the public Worker;
// celld's last deployment is its HTTP entrypoint. The test command uses that
// same ordering in an isolated S3 bucket, restarts a real celld node while its
// Workflow is waiting, and verifies replay, Queue transport, immutable R2
// artifacts, external-agent leases, and the D1 history projection.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	region         = "us-east-1"
	startupTimeout = 30 * time.Second
)

type counts struct {
	Expected     int `json:"expected"`
	Completed    int `json:"completed"`
	Pass         int `json:"pass"`
	Fail         int `json:"fail"`
	InfraFailure int `json:"infra_failure"`
}

type epochView struct {
	EpochID        string              `json:"epoch_id"`
	WorkflowID     string              `json:"workflow_id"`
	State          string              `json:"state"`
	Counts         counts              `json:"counts"`
	ManifestDigest string              `json:"manifest_digest"`
	ManifestRef    artifactRef         `json:"manifest_ref"`
	ReportRef      artifactRef         `json:"report_ref"`
	TestOrder      []string            `json:"test_order"`
	Tests          map[string]testView `json:"tests"`
	BatchOrder     []string            `json:"batch_order"`
	Batches        map[string]struct {
		Platform string   `json:"platform"`
		TestIDs  []string `json:"test_ids"`
		State    string   `json:"state"`
	} `json:"batches"`
}

// testView separates original milestone outcomes from diagnostic observations.
type testView struct {
	ID             string `json:"id"`
	Platform       string `json:"platform"`
	Changed        bool   `json:"changed"`
	Classification string `json:"classification"`
	Observations   []struct {
		Outcome string `json:"outcome"`
	} `json:"observations"`
	Finding struct {
		Kind       string  `json:"kind"`
		Revision   string  `json:"revision"`
		Confidence float64 `json:"confidence"`
	} `json:"finding"`
	Diagnosis struct {
		Observations []struct {
			Revision string `json:"revision"`
			Outcome  string `json:"outcome"`
		} `json:"observations"`
	} `json:"diagnosis"`
}

// artifactRef is the small R2 content address carried through Workflow state.
type artifactRef struct {
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

// workflowView is the celld lifecycle record, distinct from epoch coverage.
type workflowView struct {
	Status        string          `json:"status"`
	Output        json.RawMessage `json:"output"`
	Error         json.RawMessage `json:"error"`
	WorkflowID    string          `json:"workflow_id"`
	EpochStatus   string          `json:"epoch_status"`
	EngineHistory string          `json:"engine_history"`
}

// seedView captures the ingress idempotency receipt used before and after replay.
type seedView struct {
	Created bool   `json:"created"`
	EpochID string `json:"epoch_id"`
}

type queueView struct {
	Counts struct {
		Pending  int `json:"pending"`
		Leased   int `json:"leased"`
		Complete int `json:"complete"`
	} `json:"counts"`
	Jobs []struct {
		ID        string      `json:"id"`
		Kind      string      `json:"kind"`
		State     string      `json:"state"`
		ResultRef artifactRef `json:"result_ref"`
	} `json:"jobs"`
}

type historyView struct {
	Epochs []struct {
		EpochID     string `json:"epoch_id"`
		State       string `json:"state"`
		Expected    int    `json:"expected"`
		Completed   int    `json:"completed"`
		Passed      int    `json:"passed"`
		Failed      int    `json:"failed"`
		InfraFailed int    `json:"infra_failed"`
	} `json:"epochs"`
}

type runningProcess struct {
	command *exec.Cmd
	done    <-chan error
	logPath string
	stopped bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "orchestra e2e: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("expected deploy or test command")
	}
	switch args[0] {
	case "deploy":
		if len(args) < 4 {
			return errors.New("usage: e2e-runner deploy CELLD CONSUMER_PROJECT PROJECT [FLAGS...]")
		}
		return deployProjects(args[1], args[2:4], args[4:], os.Environ(), os.Stdout, os.Stderr)
	case "test":
		if len(args) != 5 {
			return errors.New("usage: e2e-runner test CELLD CONSUMER_PROJECT PROJECT ORCHESTRA")
		}
		return runTest(args[1], args[2], args[3], args[4])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

// deployProjects preserves the order supplied by the Buck rule. Every command
// must finish successfully before the next script's fleet pointer is published.
func deployProjects(celldPath string, projects, flags, environment []string, stdout, stderr io.Writer) error {
	for _, project := range projects {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		command := exec.CommandContext(ctx, celldPath, append([]string{"deploy", project}, flags...)...)
		command.Env = environment
		command.Stdout = stdout
		command.Stderr = stderr
		err := command.Run()
		cancel()
		if err != nil {
			return fmt.Errorf("deploy %s: %w", project, err)
		}
	}
	return nil
}

// runTest executes the deployed Worker through celld's public HTTP listener.
func runTest(celldPath, consumerProjectPath, projectPath, orchestraPath string) (testErr error) {
	endpoint := strings.TrimRight(os.Getenv("CHAOS3_ENDPOINT"), "/")
	if endpoint == "" {
		return errors.New("Buck did not provide CHAOS3_ENDPOINT")
	}
	unique := fmt.Sprintf("%x-%x", os.Getpid(), time.Now().UnixNano())
	bucket := "orchestra-e2e-" + unique
	repo := "repo-" + unique
	queue := "queue-" + unique
	revision := "revision-" + unique

	if err := createBucket(endpoint, bucket); err != nil {
		return withChaos3Log(err)
	}
	baseEnvironment := environmentWith(os.Environ(), map[string]string{
		"CELLD_BUCKET": "s3://" + bucket,
		"S3_ENDPOINT":  endpoint,
		"AWS_REGION":   region,
	})

	var deploymentLog bytes.Buffer
	if err := deployProjects(celldPath, []string{consumerProjectPath, projectPath}, nil, baseEnvironment, &deploymentLog, &deploymentLog); err != nil {
		return withChaos3Log(fmt.Errorf("deploy Workers: %w\n%s", err, deploymentLog.String()))
	}
	fmt.Printf("deployed Queue consumer and Orchestra API to s3://%s\n", bucket)

	address, err := availableLoopbackAddress()
	if err != nil {
		return err
	}
	temporaryDirectory, err := os.MkdirTemp("", "orchestra-celld-e2e-*")
	if err != nil {
		return fmt.Errorf("create celld working directory: %w", err)
	}
	defer func() {
		if testErr != nil || os.Getenv("ORCHESTRA_E2E_KEEP_STATE") == "1" {
			fmt.Fprintf(os.Stderr, "preserved E2E state and logs in %s\n", temporaryDirectory)
		} else {
			_ = os.RemoveAll(temporaryDirectory)
		}
	}()
	celldEnvironment := environmentWith(baseEnvironment, map[string]string{
		"CELLD_ADDR":  address,
		"CELLD_NODE":  "e2e-" + unique,
		"CELLD_WATCH": filepath.Join(temporaryDirectory, "state"),
	})
	node, err := startCelld(celldPath, celldEnvironment, address, filepath.Join(temporaryDirectory, "celld.log"))
	if err != nil {
		return withChaos3Log(err)
	}
	defer func() { node.stop() }()
	baseURL := "http://" + address
	fmt.Printf("started celld at %s\n", baseURL)

	client := &http.Client{Timeout: 10 * time.Second}
	seedArguments := []string{"seed", "--url", baseURL, "--repo", repo, "--revision", revision, "--queue", queue}
	seedOutput, err := runOrchestra(orchestraPath, seedArguments...)
	if err != nil {
		return fmt.Errorf("seed epoch: %w\ncelld log:\n%s", err, node.log())
	}
	var seeded seedView
	if err := json.Unmarshal(seedOutput, &seeded); err != nil || !seeded.Created || seeded.EpochID != "e000001" {
		return fmt.Errorf("unexpected seed receipt: %s (decode error: %v)", seedOutput, err)
	}
	epochURL := baseURL + "/v1/repos/" + url.PathEscape(repo) + "/epochs/" + seeded.EpochID
	// One-job mode waits through asynchronous Queue kickoff, completes the plan,
	// and leaves execution jobs unclaimed so the restart checkpoint is durable.
	if err := runRenewingPlanner(orchestraPath, baseURL, queue); err != nil {
		return fmt.Errorf("plan epoch: %w\ncelld log:\n%s", err, node.log())
	}
	if err := waitFor("planned Workflow to wait", startupTimeout, func() (bool, error) {
		var epoch epochView
		var workflow workflowView
		if err := getJSON(client, epochURL, &epoch); err != nil {
			return false, err
		}
		if err := getJSON(client, epochURL+"/workflow", &workflow); err != nil {
			return false, err
		}
		if workflow.Status == "errored" || epoch.State == "failed" {
			return false, fmt.Errorf("epoch failed before restart: epoch=%+v workflow=%+v", epoch, workflow)
		}
		return epoch.State == "running" && workflow.Status == "waiting" && len(epoch.BatchOrder) == 2, nil
	}); err != nil {
		return fmt.Errorf("%w\ncelld log:\n%s", err, node.log())
	}
	if err := node.kill(); err != nil {
		return err
	}
	node, err = startCelld(celldPath, celldEnvironment, address, filepath.Join(temporaryDirectory, "celld-restarted.log"))
	if err != nil {
		return withChaos3Log(err)
	}
	fmt.Println("restarted celld after a durable Workflow wait; resuming external-agent work")
	if _, err := runOrchestra(orchestraPath, "demo", "--url", baseURL, "--repo", repo,
		"--revision", revision, "--queue", queue, "--agent", "e2e-runner", "--retry-completions"); err != nil {
		return fmt.Errorf("resume epoch: %w\ncelld log:\n%s", err, node.log())
	}
	// Epoch coverage can become terminal before the Workflow's final projection
	// step settles. Wait for both the engine and Queue before asserting snapshots.
	var workflow workflowView
	if err := waitFor("Workflow completion", startupTimeout, func() (bool, error) {
		if err := getJSON(client, epochURL+"/workflow", &workflow); err != nil {
			return false, err
		}
		if workflow.Status == "errored" || workflow.Status == "terminated" {
			return false, fmt.Errorf("Workflow did not complete: %+v", workflow)
		}
		return workflow.Status == "complete", nil
	}); err != nil {
		return fmt.Errorf("%w\ncelld log:\n%s", err, node.log())
	}
	if workflow.EngineHistory != "available" || workflow.EpochStatus != "complete" || workflow.WorkflowID == "" {
		return fmt.Errorf("missing retained engine/epoch lifecycle distinction: %+v", workflow)
	}
	if err := waitFor("Queue notifications to settle", startupTimeout, func() (bool, error) {
		var metrics struct {
			BacklogCount *int `json:"backlogCount"`
		}
		var delivery struct {
			NotificationsReceived int `json:"notifications_received"`
		}
		if err := getJSON(client, baseURL+"/v1/events", &metrics); err != nil {
			return false, err
		}
		if metrics.BacklogCount == nil {
			return false, errors.New("Queue metrics omitted backlogCount")
		}
		if err := getJSON(client, epochURL, &delivery); err != nil {
			return false, err
		}
		return *metrics.BacklogCount == 0 && delivery.NotificationsReceived >= 2, nil
	}); err != nil {
		return fmt.Errorf("%w\ncelld log:\n%s", err, node.log())
	}
	var epoch epochView
	if err := getJSON(client, epochURL, &epoch); err != nil {
		return fmt.Errorf("read completed epoch: %w", err)
	}
	wantCounts := counts{Expected: 3, Completed: 3, Pass: 2, Fail: 1, InfraFailure: 0}
	if epoch.EpochID != "e000001" || epoch.State != "complete" || epoch.Counts != wantCounts {
		return fmt.Errorf("unexpected epoch state: %+v", epoch)
	}
	if !strings.HasPrefix(epoch.ManifestDigest, "sha256:") || len(epoch.Tests) != 3 || len(epoch.TestOrder) != 3 {
		return fmt.Errorf("unexpected planner manifest digest/tests: %+v", epoch)
	}
	if len(epoch.BatchOrder) != 2 || len(epoch.Batches) != 2 {
		return fmt.Errorf("expected two coarse test batches: order=%v batches=%+v", epoch.BatchOrder, epoch.Batches)
	}
	platforms := map[string]int{}
	for _, batchID := range epoch.BatchOrder {
		batch, ok := epoch.Batches[batchID]
		if !ok || batch.State != "complete" {
			return fmt.Errorf("batch %s was not complete: %+v", batchID, batch)
		}
		platforms[batch.Platform] += len(batch.TestIDs)
	}
	if platforms["linux-x86_64"] != 2 || platforms["darwin-arm64"] != 1 {
		return fmt.Errorf("unexpected platform partition: %+v", platforms)
	}

	var queueState queueView
	if err := getJSON(client, baseURL+"/v1/queues/"+url.PathEscape(queue), &queueState); err != nil {
		return fmt.Errorf("read drained queue: %w", err)
	}
	if queueState.Counts.Pending != 0 || queueState.Counts.Leased != 0 ||
		queueState.Counts.Complete != len(queueState.Jobs) {
		return fmt.Errorf("unexpected queue state: %+v", queueState.Counts)
	}
	jobKinds := map[string]int{}
	for _, job := range queueState.Jobs {
		if job.State != "complete" || job.ResultRef.Key == "" {
			return fmt.Errorf("broker job %s did not retain its completed artifact receipt", job.ID)
		}
		jobKinds[job.Kind]++
	}
	if jobKinds["plan_epoch"] != 1 || jobKinds["run_tests"] < 2 {
		return fmt.Errorf("unexpected queue job kinds: %+v", jobKinds)
	}

	var history historyView
	if err := getJSON(client, baseURL+"/v1/repos/"+url.PathEscape(repo)+"/history?limit=10", &history); err != nil {
		return fmt.Errorf("read D1 history: %w", err)
	}
	if len(history.Epochs) != 1 {
		return fmt.Errorf("expected one history row, got %d", len(history.Epochs))
	}
	historyEpoch := history.Epochs[0]
	if historyEpoch.EpochID != "e000001" || historyEpoch.State != "complete" ||
		historyEpoch.Expected != 3 || historyEpoch.Completed != 3 ||
		historyEpoch.Passed != 2 || historyEpoch.Failed != 1 || historyEpoch.InfraFailed != 0 {
		return fmt.Errorf("unexpected D1 history row: %+v", historyEpoch)
	}

	if epoch.WorkflowID == "" || len(workflow.Output) == 0 {
		return fmt.Errorf("missing durable Workflow identity/output: epoch=%+v workflow=%+v", epoch, workflow)
	}
	artifacts, err := verifyArtifacts(client, endpoint, bucket, baseURL)
	if err != nil {
		return err
	}
	references := []artifactRef{epoch.ManifestRef, epoch.ReportRef}
	for _, job := range queueState.Jobs {
		references = append(references, job.ResultRef)
	}
	for _, ref := range references {
		if _, exists := artifacts[ref.Key]; !exists || ref.Key != "sha256/"+ref.SHA256+".json" || ref.Size <= 0 {
			return fmt.Errorf("ledger references a missing or invalid R2 artifact: %+v", ref)
		}
		contents, _, err := getBytes(client, baseURL+"/v1/artifacts/"+ref.Key)
		if err != nil || len(contents) != ref.Size {
			return fmt.Errorf("ledger R2 artifact size mismatch for %+v (read error: %v)", ref, err)
		}
	}

	// celld retains terminal workflow IDs for a bounded period. Duplicate ingress must
	// reuse Orchestra's receipt rather than silently start a new generation.
	seedOutput, err = runOrchestra(orchestraPath, seedArguments...)
	if err != nil {
		return fmt.Errorf("repeat terminal seed: %w", err)
	}
	var repeated seedView
	if err := json.Unmarshal(seedOutput, &repeated); err != nil || repeated.Created || repeated.EpochID != seeded.EpochID {
		return fmt.Errorf("terminal seed was not idempotent: %s (decode error: %v)", seedOutput, err)
	}
	if err := waitFor("terminal seed notifications", startupTimeout, func() (bool, error) {
		var metrics struct {
			BacklogCount *int `json:"backlogCount"`
		}
		if err := getJSON(client, baseURL+"/v1/events", &metrics); err != nil {
			return false, err
		}
		if metrics.BacklogCount == nil {
			return false, errors.New("Queue metrics omitted backlogCount")
		}
		return *metrics.BacklogCount == 0, nil
	}); err != nil {
		return err
	}
	var repeatedEpoch epochView
	var repeatedWorkflow workflowView
	var repeatedQueue queueView
	if err := getJSON(client, epochURL, &repeatedEpoch); err != nil {
		return err
	}
	if err := getJSON(client, epochURL+"/workflow", &repeatedWorkflow); err != nil {
		return err
	}
	if err := getJSON(client, baseURL+"/v1/queues/"+url.PathEscape(queue), &repeatedQueue); err != nil {
		return err
	}
	if !reflect.DeepEqual(epoch, repeatedEpoch) || !reflect.DeepEqual(workflow, repeatedWorkflow) ||
		!reflect.DeepEqual(queueState, repeatedQueue) {
		return fmt.Errorf("terminal seed changed durable epoch, Workflow, or broker state")
	}
	repeatedArtifacts, err := verifyArtifacts(client, endpoint, bucket, baseURL)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(artifacts, repeatedArtifacts) {
		return errors.New("terminal seed rewrote immutable R2 artifacts")
	}
	fmt.Printf("verified Workflow replay, Queue-to-service notifications, %d R2 artifacts, idempotent retries, platform sharding, and D1 history\n", len(artifacts))
	if err := verifyDiagnosis(client, orchestraPath, baseURL, repo+"-history", queue+"-history", unique); err != nil {
		return fmt.Errorf("multi-epoch diagnosis: %w\ncelld log:\n%s", err, node.log())
	}
	if _, err := verifyArtifacts(client, endpoint, bucket, baseURL); err != nil {
		return fmt.Errorf("verify diagnostic R2 evidence: %w", err)
	}
	if err := verifyAbandonedLease(client, orchestraPath, baseURL, repo+"-leases", queue+"-leases",
		"fake-pass-leases-"+unique, epoch.ManifestRef); err != nil {
		return fmt.Errorf("agent lease recovery: %w\ncelld log:\n%s", err, node.log())
	}
	return nil
}

// verifyDiagnosis drives real Queue/Workflow/FACF orchestration over explicitly
// fake source revisions. A passing baseline is followed by a stable regression
// that requires a culprit probe, then a flaky cohort with both fail/pass evidence.
// The fixtures never pretend these executions or commits came from Buck/JJ.
func verifyDiagnosis(client *http.Client, orchestraPath, baseURL, repo, queue, unique string) error {
	revisions := []string{"fake-pass-" + unique, "fake-stable-" + unique, "fake-flaky-" + unique}
	for index, revision := range revisions {
		fmt.Printf("starting diagnosis milestone %d at %s\n", index+1, revision)
		if _, err := runOrchestra(orchestraPath, "demo", "--url", baseURL, "--repo", repo,
			"--revision", revision, "--queue", queue, "--agent", "e2e-history", "--retry-completions"); err != nil {
			return err
		}
		epochID := fmt.Sprintf("e%06d", index+1)
		epochURL := baseURL + "/v1/repos/" + url.PathEscape(repo) + "/epochs/" + epochID
		var epoch epochView
		if err := getJSON(client, epochURL, &epoch); err != nil {
			return err
		}
		if epoch.State != "complete" || epoch.Counts.Expected != 3 || epoch.Counts.Completed != 3 {
			return fmt.Errorf("history epoch %s was not completely accounted for: %+v", epochID, epoch)
		}
		test, exists := epoch.Tests["t0002"]
		if !exists {
			return fmt.Errorf("history epoch %s omitted its unchanged integration test", epochID)
		}
		switch index {
		case 0:
			if test.Classification != "pass" || epoch.Counts.Pass != 3 {
				return fmt.Errorf("baseline did not establish passing coverage: %+v", test)
			}
		case 1:
			if test.Classification != "fail" || test.Finding.Kind != "culprit" || test.Finding.Confidence < 0.9 ||
				test.Finding.Revision != revision+"-fake-candidate-1" || len(test.Diagnosis.Observations) == 0 {
				return fmt.Errorf("stable regression did not complete a real FACF probe: %+v", test)
			}
			fmt.Printf("FACF attributed the fake regression to %s at confidence %.3f after %d independent probe(s)\n",
				test.Finding.Revision, test.Finding.Confidence, len(test.Diagnosis.Observations))
		case 2:
			outcomes := map[string]bool{}
			for _, observation := range test.Observations {
				outcomes[observation.Outcome] = true
			}
			if test.Classification != "flaky" || !outcomes["pass"] || !outcomes["fail"] ||
				test.Finding.Kind != "" || epoch.Counts.Pass != 3 {
				return fmt.Errorf("flaky cohort was not distinguished from a deterministic regression: %+v", test)
			}
		}
		if err := waitFor("history Workflow completion", startupTimeout, func() (bool, error) {
			var workflow workflowView
			if err := getJSON(client, epochURL+"/workflow", &workflow); err != nil {
				return false, err
			}
			if workflow.Status == "errored" || workflow.Status == "terminated" {
				return false, fmt.Errorf("history Workflow failed: %+v", workflow)
			}
			return workflow.Status == "complete", nil
		}); err != nil {
			return err
		}
	}
	var broker queueView
	if err := getJSON(client, baseURL+"/v1/queues/"+url.PathEscape(queue), &broker); err != nil {
		return err
	}
	plans := 0
	for _, job := range broker.Jobs {
		if job.Kind == "plan_culprit" {
			plans++
		}
	}
	if plans != 1 || broker.Counts.Pending != 0 || broker.Counts.Leased != 0 || broker.Counts.Complete != len(broker.Jobs) {
		return fmt.Errorf("expected one completed culprit interval plan and a drained broker: plans=%d counts=%+v", plans, broker.Counts)
	}
	var history historyView
	if err := getJSON(client, baseURL+"/v1/repos/"+url.PathEscape(repo)+"/history", &history); err != nil {
		return err
	}
	if len(history.Epochs) != 3 {
		return fmt.Errorf("D1 omitted diagnosis milestones: got %d rows", len(history.Epochs))
	}
	fmt.Println("verified passing coverage frontier, FACF culprit investigation, and flake-aware multi-epoch history")
	return nil
}

// runOrchestra runs only the public CLI, retaining its output for failed-test
// diagnostics. Its deadline also bounds asynchronous queue-draining regressions.
func runOrchestra(path string, arguments ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, arguments...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("orchestra %s: %w\n%s%s", arguments[0], err, stdout.String(), stderr.String())
	}
	fmt.Printf("orchestra %s completed\n", arguments[0])
	if stderr.Len() != 0 {
		fmt.Fprint(os.Stderr, stderr.String())
	}
	return stdout.Bytes(), nil
}

// waitFor polls observable public state rather than guessing how many event
// loop turns a Queue delivery, Workflow replay, or D1 projection will need.
func waitFor(description string, timeout time.Duration, check func() (bool, error)) error {
	deadline := time.Now().Add(timeout)
	for {
		ready, err := check()
		if err != nil {
			return fmt.Errorf("wait for %s: %w", description, err)
		}
		if ready {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for %s", description)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// verifyArtifacts independently lists the fleet's actual S3 R2 prefix, verifies
// content-addressed bytes, and compares them with the public artifact endpoint.
// The key/ETag snapshot detects changed artifact content or extra artifact keys;
// it does not claim to detect a redundant write of identical bytes.
func verifyArtifacts(client *http.Client, endpoint, bucket, baseURL string) (map[string]string, error) {
	const prefix = "r2/orchestra-artifacts/"
	artifacts := map[string]string{}
	cursor := ""
	for {
		query := url.Values{"list-type": {"2"}, "prefix": {prefix}}
		if cursor != "" {
			query.Set("continuation-token", cursor)
		}
		body, _, err := getBytes(client, endpoint+"/"+bucket+"?"+query.Encode())
		if err != nil {
			return nil, fmt.Errorf("list R2 objects in chaos3: %w", err)
		}
		var listing struct {
			Truncated bool   `xml:"IsTruncated"`
			Cursor    string `xml:"NextContinuationToken"`
			Contents  []struct {
				Key string `xml:"Key"`
			} `xml:"Contents"`
		}
		if err := xml.Unmarshal(body, &listing); err != nil {
			return nil, fmt.Errorf("decode R2 object listing: %w", err)
		}
		for _, entry := range listing.Contents {
			key := strings.TrimPrefix(entry.Key, prefix)
			if key == entry.Key || !strings.HasPrefix(key, "sha256/") || !strings.HasSuffix(key, ".json") {
				return nil, fmt.Errorf("unexpected R2 artifact key %q", entry.Key)
			}
			contents, headers, err := getBytes(client, endpoint+"/"+bucket+"/"+entry.Key)
			if err != nil {
				return nil, fmt.Errorf("read R2 backing object %s: %w", key, err)
			}
			digest := sha256.Sum256(contents)
			if key != fmt.Sprintf("sha256/%x.json", digest) || !json.Valid(contents) {
				return nil, fmt.Errorf("R2 artifact %s does not match its JSON content digest", key)
			}
			public, _, err := getBytes(client, baseURL+"/v1/artifacts/"+key)
			if err != nil {
				return nil, fmt.Errorf("read public artifact %s: %w", key, err)
			}
			if !bytes.Equal(contents, public) {
				return nil, fmt.Errorf("public artifact %s differs from R2 bytes", key)
			}
			artifacts[key] = headers.Get("ETag")
		}
		if !listing.Truncated {
			break
		}
		if listing.Cursor == "" || listing.Cursor == cursor {
			return nil, errors.New("R2 listing returned an invalid continuation cursor")
		}
		cursor = listing.Cursor
	}
	if len(artifacts) < 3 {
		return nil, fmt.Errorf("expected at least a plan and two result artifacts in R2, got %d", len(artifacts))
	}
	return artifacts, nil
}

// getBytes bounds every black-box response, checks status, and closes its body.
func getBytes(client *http.Client, endpoint string) ([]byte, http.Header, error) {
	response, err := client.Get(endpoint)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
	if err != nil {
		return nil, nil, err
	}
	if len(contents) > 16<<20 {
		return nil, nil, errors.New("response exceeds E2E byte limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("HTTP %s: %s", response.Status, strings.TrimSpace(string(contents)))
	}
	return contents, response.Header, nil
}

func createBucket(endpoint, bucket string) error {
	request, err := http.NewRequest(http.MethodPut, endpoint+"/"+bucket, nil)
	if err != nil {
		return fmt.Errorf("construct create-bucket request: %w", err)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("create s3://%s: %w", bucket, err)
	}
	defer response.Body.Close()
	contents, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil {
		return fmt.Errorf("read create-bucket response: %w", readErr)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("create s3://%s: HTTP %s: %s", bucket, response.Status, strings.TrimSpace(string(contents)))
	}
	return nil
}

func availableLoopbackAddress() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("reserve celld listener: %w", err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		return "", fmt.Errorf("release celld listener: %w", err)
	}
	return address, nil
}

func startCelld(path string, environment []string, address, logPath string) (*runningProcess, error) {
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, fmt.Errorf("create celld log: %w", err)
	}
	command := exec.Command(path)
	command.Env = environment
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		logFile.Close()
		return nil, fmt.Errorf("start celld: %w", err)
	}
	_ = logFile.Close()
	done := make(chan error, 1)
	go func() {
		done <- command.Wait()
	}()

	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(startupTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			return nil, fmt.Errorf("celld exited during startup: %w\n%s", err, readLog(logPath))
		default:
		}
		response, err := client.Get("http://" + address + "/.well-known/celld/health")
		if err == nil {
			_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
			response.Body.Close()
			if readErr == nil && response.StatusCode == http.StatusOK {
				return &runningProcess{command: command, done: done, logPath: logPath}, nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = command.Process.Kill()
	<-done
	return nil, fmt.Errorf("celld startup timed out\n%s", readLog(logPath))
}

func (process *runningProcess) stop() {
	if process == nil || process.command.Process == nil || process.stopped {
		return
	}
	_ = process.command.Process.Signal(syscall.SIGTERM)
	select {
	case <-process.done:
	case <-time.After(10 * time.Second):
		_ = process.command.Process.Kill()
		<-process.done
	}
	process.stopped = true
}

// kill simulates an abrupt node loss without allowing a graceful drain. The
// caller keeps the same watch directory and identity when starting its successor.
func (process *runningProcess) kill() error {
	if process == nil || process.stopped {
		return errors.New("cannot crash a stopped celld process")
	}
	if err := process.command.Process.Kill(); err != nil {
		return fmt.Errorf("kill celld at replay checkpoint: %w", err)
	}
	<-process.done
	process.stopped = true
	return nil
}

func (process *runningProcess) log() string {
	if process == nil {
		return ""
	}
	return readLog(process.logPath)
}

func getJSON(client *http.Client, endpoint string, output any) error {
	response, err := client.Get(endpoint)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("HTTP %s: %s", response.Status, strings.TrimSpace(string(contents)))
	}
	if err := json.Unmarshal(contents, output); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func environmentWith(base []string, values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		key := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			key = entry[:index]
		}
		if _, replaced := values[key]; !replaced {
			result = append(result, entry)
		}
	}
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

func withChaos3Log(err error) error {
	logPath := os.Getenv("CHAOS3_LOG")
	if logPath == "" {
		return err
	}
	return fmt.Errorf("%w\nchaos3 log:\n%s", err, readLog(logPath))
}

func readLog(path string) string {
	contents, err := os.ReadFile(path)
	if err != nil {
		return fmt.Sprintf("<could not read %s: %v>", path, err)
	}
	return strings.TrimSpace(string(contents))
}
