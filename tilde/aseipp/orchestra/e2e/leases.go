// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Lease probes exercise the public agent protocol against the real celld node.
// A test-owned proxy stalls an artifact upload while the unmodified CLI renews
// its assignment; a separate epoch demonstrates abandoned-work reclamation and
// rejection of late writes. Neither probe needs a real repository or test-only
// behavior in the production Worker or agent.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"time"
)

// leaseReceipt accepts claim, renewal, and broker-summary views without losing
// the identity and expiry fields needed to detect stale-fence mutations.
type leaseReceipt struct {
	ID         string `json:"id"`
	JobID      string `json:"job_id"`
	AgentID    string `json:"agent_id"`
	LeaseToken int    `json:"lease_token"`
	LeaseUntil int64  `json:"lease_until"`
	Attempts   int    `json:"attempts"`
	State      string `json:"state"`
}

// delayedUploadProxy forwards all traffic normally except the first artifact
// POST. The delay is cancellable and renewals remain concurrent with that POST.
// Observations are guarded because HTTP handlers and proxy callbacks overlap.
type delayedUploadProxy struct {
	proxy *httputil.ReverseProxy
	delay time.Duration
	mu    sync.Mutex
	claim leaseReceipt
	start time.Time
	end   time.Time
	count int
	err   error
}

// newDelayedUploadProxy accepts an injectable transport so the observation and
// cancellation guards themselves can be tested without listening on a socket.
func newDelayedUploadProxy(target string, delay time.Duration, transport http.RoundTripper) (*delayedUploadProxy, error) {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || delay <= 0 {
		return nil, fmt.Errorf("invalid lease-probe target or delay: %q, %s", target, delay)
	}
	probe := &delayedUploadProxy{proxy: httputil.NewSingleHostReverseProxy(parsed), delay: delay}
	probe.proxy.Transport = transport
	probe.proxy.ModifyResponse = probe.observeResponse
	return probe, nil
}

// ServeHTTP delays only one upload, never the independent heartbeat requests.
func (probe *delayedUploadProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	probe.mu.Lock()
	delay := r.Method == http.MethodPost && r.URL.Path == "/v1/artifacts" && probe.start.IsZero()
	if delay {
		probe.start = time.Now()
	}
	probe.mu.Unlock()
	if delay {
		timer := time.NewTimer(probe.delay)
		defer timer.Stop()
		select {
		case <-r.Context().Done():
			return
		case <-timer.C:
		}
		probe.mu.Lock()
		probe.end = time.Now()
		probe.mu.Unlock()
	}
	probe.proxy.ServeHTTP(w, r)
}

// observeResponse inspects successful broker responses without changing the
// bytes delivered to the agent. Counts include only renewals during the stall.
func (probe *delayedUploadProxy) observeResponse(response *http.Response) error {
	path := response.Request.URL.Path
	if response.StatusCode != http.StatusOK ||
		(!hasLeaseOperation(path, "claim") && !hasLeaseOperation(path, "renew")) {
		return nil
	}
	contents, err := readLeaseBody(response.Body)
	_ = response.Body.Close()
	if err != nil {
		return err
	}
	response.Body = io.NopCloser(bytes.NewReader(contents))
	var receipt leaseReceipt
	if err := json.Unmarshal(contents, &receipt); err != nil {
		return fmt.Errorf("decode observed broker response: %w", err)
	}
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if hasLeaseOperation(path, "claim") {
		probe.claim = receipt
		return nil
	}
	if receipt.JobID != probe.claim.ID || receipt.AgentID != probe.claim.AgentID ||
		receipt.LeaseToken != probe.claim.LeaseToken || receipt.LeaseUntil < probe.claim.LeaseUntil {
		probe.err = fmt.Errorf("renewal changed claimed identity or shortened expiry: claim=%+v renewal=%+v", probe.claim, receipt)
	}
	if !probe.start.IsZero() && probe.end.IsZero() {
		probe.count++
	}
	return nil
}

// hasLeaseOperation excludes unrelated paths with the same final component.
func hasLeaseOperation(path, operation string) bool {
	parts := bytes.Split([]byte(path), []byte("/"))
	return len(parts) == 5 && string(parts[1]) == "v1" && string(parts[2]) == "queues" &&
		len(parts[3]) != 0 && string(parts[4]) == operation
}

// verify fails closed if the upload did not outlive the initial lease or the
// agent's successful completion could have happened without repeated renewal.
// The harness and celld share this machine's wall clock; this comparison is a
// local test assertion, not the production agent's clock-skew handling policy.
func (probe *delayedUploadProxy) verify() error {
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if probe.err != nil {
		return probe.err
	}
	if probe.claim.ID == "" || probe.claim.LeaseUntil == 0 || probe.start.IsZero() || probe.end.IsZero() ||
		probe.end.UnixMilli() <= probe.claim.LeaseUntil || probe.count < 2 {
		return fmt.Errorf("upload did not demonstrate renewed ownership: claim=%+v start=%s end=%s renewals=%d",
			probe.claim, probe.start, probe.end, probe.count)
	}
	return nil
}

// runRenewingPlanner binds a private proxy only for this one CLI invocation.
// Explicit server/request cancellation and transport cleanup bound failure paths.
func runRenewingPlanner(orchestraPath, baseURL, queue string) error {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 10 * time.Second
	defer transport.CloseIdleConnections()
	probe, err := newDelayedUploadProxy(baseURL, 5*time.Second, transport)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for lease probe: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := &http.Server{Handler: probe, ReadHeaderTimeout: 5 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	defer func() {
		cancel()
		_ = server.Close()
		<-done
	}()
	if _, err := runOrchestra(orchestraPath, "agent", "--url", "http://"+listener.Addr().String(), "--queue", queue,
		"--agent", "e2e-planner", "--lease", "2s", "--drain=false", "--retry-completions"); err != nil {
		return err
	}
	if err := probe.verify(); err != nil {
		return err
	}
	fmt.Println("verified repeated lease renewal during a 5-second artifact upload with a 2-second initial lease")
	return nil
}

// verifyAbandonedLease uses a separate broker so deliberately abandoned leases
// cannot interfere with the replay/FACF fixtures. The normal agent subsequently
// reclaims and completes the epoch, leaving no background Workflow behind.
func verifyAbandonedLease(client *http.Client, orchestraPath, baseURL, repo, queue, revision string, ref artifactRef) error {
	if _, err := runOrchestra(orchestraPath, "seed", "--url", baseURL, "--repo", repo,
		"--queue", queue, "--revision", revision); err != nil {
		return err
	}
	queueURL := baseURL + "/v1/queues/" + url.PathEscape(queue)
	var abandoned leaseReceipt
	if err := waitFor("abandoned planner assignment", startupTimeout, func() (bool, error) {
		status, err := requestLeaseJSON(client, queueURL+"/claim", map[string]any{
			"agent_id": "e2e-abandoned", "lease_ms": 1000,
			"platforms": []string{"linux-x86_64"}, "kinds": []string{"plan_epoch"},
		}, &abandoned)
		return status == http.StatusOK, err
	}); err != nil {
		return err
	}
	if err := waitForLeaseExpiry(abandoned); err != nil {
		return err
	}
	stale := map[string]any{"job_id": abandoned.ID, "agent_id": abandoned.AgentID,
		"lease_token": abandoned.LeaseToken, "lease_ms": 1000}
	if status, err := requestLeaseJSON(client, queueURL+"/renew", stale, nil); err != nil || status != http.StatusConflict {
		return fmt.Errorf("expired renewal: status=%d error=%v", status, err)
	}
	var replacement leaseReceipt
	status, err := requestLeaseJSON(client, queueURL+"/claim", map[string]any{
		"agent_id": "e2e-replacement", "lease_ms": 3000,
		"platforms": []string{"linux-x86_64"}, "kinds": []string{"plan_epoch"},
	}, &replacement)
	if err != nil || status != http.StatusOK || replacement.ID != abandoned.ID || replacement.LeaseToken <= abandoned.LeaseToken {
		return fmt.Errorf("abandoned job not reclaimed with a newer fence: old=%+v new=%+v status=%d error=%v", abandoned, replacement, status, err)
	}
	if status, err := requestLeaseJSON(client, queueURL+"/renew", stale, nil); err != nil || status != http.StatusConflict {
		return fmt.Errorf("replaced renewal: status=%d error=%v", status, err)
	}
	stale["result_ref"] = ref
	if status, err := requestLeaseJSON(client, queueURL+"/complete", stale, nil); err != nil || status != http.StatusConflict {
		return fmt.Errorf("late completion: status=%d error=%v", status, err)
	}
	var broker struct {
		Jobs []leaseReceipt `json:"jobs"`
	}
	if err := getJSON(client, queueURL, &broker); err != nil {
		return err
	}
	if len(broker.Jobs) != 1 {
		return fmt.Errorf("unexpected replacement broker size: %+v", broker.Jobs)
	}
	current := broker.Jobs[0]
	if current.ID != replacement.ID || current.AgentID != replacement.AgentID ||
		current.LeaseToken != replacement.LeaseToken || current.LeaseUntil != replacement.LeaseUntil ||
		current.Attempts != replacement.Attempts || current.State != "leased" {
		return fmt.Errorf("stale operations changed replacement lease: replacement=%+v ledger=%+v", replacement, current)
	}
	if err := waitForLeaseExpiry(replacement); err != nil {
		return err
	}
	if _, err := runOrchestra(orchestraPath, "demo", "--url", baseURL, "--repo", repo,
		"--queue", queue, "--revision", revision, "--agent", "e2e-recovered"); err != nil {
		return err
	}
	if err := waitFor("reclaimed epoch Workflow completion", startupTimeout, func() (bool, error) {
		var workflow workflowView
		if err := getJSON(client, baseURL+"/v1/repos/"+url.PathEscape(repo)+"/epochs/e000001/workflow", &workflow); err != nil {
			return false, err
		}
		if workflow.Status == "errored" || workflow.Status == "terminated" {
			return false, fmt.Errorf("reclaimed Workflow failed: %+v", workflow)
		}
		return workflow.Status == "complete", nil
	}); err != nil {
		return err
	}
	if err := getJSON(client, queueURL, &broker); err != nil {
		return err
	}
	if len(broker.Jobs) == 0 || broker.Jobs[0].ID != abandoned.ID || broker.Jobs[0].Attempts != replacement.Attempts+1 {
		return fmt.Errorf("recovery agent did not take the next fence: %+v", broker.Jobs)
	}
	for _, job := range broker.Jobs {
		if job.State != "complete" {
			return fmt.Errorf("recovered epoch left work outstanding: %+v", job)
		}
	}
	fmt.Println("verified abandoned lease reclamation, stale renewal/completion fencing, and recovery to a completed epoch")
	return nil
}

// waitForLeaseExpiry follows the server's observable deadline, with a small
// clock/timer margin. Invalid or unexpectedly long deadlines fail immediately.
// celld and this test run on the same machine and therefore share a wall clock.
func waitForLeaseExpiry(receipt leaseReceipt) error {
	delay := time.Until(time.UnixMilli(receipt.LeaseUntil).Add(100 * time.Millisecond))
	if receipt.ID == "" || receipt.LeaseToken <= 0 || receipt.LeaseUntil <= 0 || delay > 5*time.Second {
		return fmt.Errorf("invalid or unbounded test lease: %+v", receipt)
	}
	if delay > 0 {
		time.Sleep(delay)
	}
	return nil
}

// requestLeaseJSON allows the two expected non-success protocol outcomes (204
// no work and 409 conflict), while surfacing storage failures and bounded bodies.
func requestLeaseJSON(client *http.Client, target string, input, output any) (int, error) {
	contents, err := json.Marshal(input)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(contents))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	contents, err = readLeaseBody(response.Body)
	if err != nil {
		return response.StatusCode, err
	}
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusConflict {
		return response.StatusCode, nil
	}
	if response.StatusCode != http.StatusOK {
		return response.StatusCode, fmt.Errorf("lease protocol HTTP %d: %s", response.StatusCode, contents)
	}
	if output != nil {
		err = json.Unmarshal(contents, output)
	}
	return response.StatusCode, err
}

// readLeaseBody detects oversized responses rather than silently truncating
// JSON or accepting an HTTP failure with arbitrarily large diagnostics.
func readLeaseBody(body io.Reader) ([]byte, error) {
	const limit = 1 << 20
	contents, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err == nil && len(contents) > limit {
		err = errors.New("lease protocol response exceeds 1 MiB")
	}
	return contents, err
}
