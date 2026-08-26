// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These protocol tests run real heartbeat/watchdog goroutines against local
// HTTP servers. Short internal leases keep failure injection bounded without
// changing the production CLI's one-second minimum requested lease.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type leaseTestPlanner func(context.Context) error

func (plan leaseTestPlanner) Plan(ctx context.Context, base *string, revision string) (targetManifest, error) {
	if err := plan(ctx); err != nil {
		return targetManifest{}, err
	}
	return fakeManifest(base, revision)
}

type leaseTestExecutor func(context.Context) error

func (execute leaseTestExecutor) Execute(ctx context.Context, claimed job, output io.Writer) ([]testExecution, error) {
	if err := execute(ctx); err != nil {
		return nil, err
	}
	return (fakeTestExecutor{}).Execute(ctx, claimed, output)
}

// leaseTestServer supplies a single fenced claim with injectable renew/upload
// behavior. Atomics make counters safe even while a canceled HTTP handler exits.
type leaseTestServer struct {
	t          *testing.T
	server     *httptest.Server
	lease      time.Duration
	kind       string
	renew      func(http.ResponseWriter, *http.Request, leaseReceipt, int64)
	upload     func(context.Context) error
	finish     func(context.Context) error
	renewals   atomic.Int64
	uploads    atomic.Int64
	completed  atomic.Int64
	resultKind atomic.Value
}

func newLeaseTestServer(t *testing.T, lease time.Duration) *leaseTestServer {
	t.Helper()
	s := &leaseTestServer{t: t, lease: lease, kind: "plan_epoch"}
	s.server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.server.Close)
	return s
}

func (s *leaseTestServer) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1/queues/default/claim":
		json.NewEncoder(w).Encode(job{
			ID: "work", Kind: s.kind, Revision: "r1", Platform: "linux-x86_64",
			AgentID: "agent", LeaseToken: 7,
			// An intentionally skewed clock proves local deadlines do not use it.
			LeaseUntil: time.Now().Add(-24 * time.Hour).UnixMilli(),
		})
	case "/v1/queues/default/renew":
		var receipt leaseReceipt
		if err := json.NewDecoder(r.Body).Decode(&receipt); err != nil {
			s.t.Error(err)
		}
		count := s.renewals.Add(1)
		receipt.LeaseUntil = time.Now().Add(-24 * time.Hour).UnixMilli()
		if s.renew != nil {
			s.renew(w, r, receipt, count)
		} else {
			json.NewEncoder(w).Encode(receipt)
		}
	case "/v1/artifacts":
		s.uploads.Add(1)
		contents, _ := io.ReadAll(r.Body)
		var value struct {
			Kind string `json:"kind"`
		}
		json.Unmarshal(contents, &value)
		s.resultKind.Store(value.Kind)
		if s.upload != nil {
			if err := s.upload(r.Context()); err != nil {
				return
			}
		}
		json.NewEncoder(w).Encode(fixtureArtifactRef(contents))
	case "/v1/queues/default/complete":
		if s.finish != nil {
			if err := s.finish(r.Context()); err != nil {
				return
			}
		}
		s.completed.Add(1)
		fmt.Fprint(w, `{}`)
	default:
		http.NotFound(w, r)
	}
}

func (s *leaseTestServer) run(planner manifestPlanner, executor testExecutor) (int, error) {
	c, _ := newClient(s.server.URL)
	return c.runAgent(agentOptions{
		Queue: "default", AgentID: "agent", Lease: s.lease,
		Planner: planner, Executor: executor, Timeout: 3 * time.Second,
	}, io.Discard)
}

func TestAgentRenewsDuringPlanningExecutionAndUpload(t *testing.T) {
	for _, phase := range []string{"plan", "execute", "upload", "error-upload"} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			s := newLeaseTestServer(t, 300*time.Millisecond)
			wait := func(ctx context.Context) error { return waitForAgentPoll(ctx, 1100*time.Millisecond) }
			var planner manifestPlanner = fakeManifestPlanner{}
			var executor testExecutor = fakeTestExecutor{}
			if phase == "plan" {
				planner = leaseTestPlanner(wait)
			} else if phase == "execute" {
				s.kind = "run_tests"
				executor = leaseTestExecutor(wait)
			} else {
				s.upload = wait
				if phase == "error-upload" {
					planner = leaseTestPlanner(func(context.Context) error { return errors.New("backend failed") })
				}
			}
			count, err := s.run(planner, executor)
			if err != nil || count != 1 || s.renewals.Load() < 3 || s.completed.Load() != 1 {
				t.Fatalf("count=%d renewals=%d completions=%d err=%v", count, s.renewals.Load(), s.completed.Load(), err)
			}
			if phase == "error-upload" && s.resultKind.Load() != "job_error" {
				t.Fatalf("error upload kind = %v", s.resultKind.Load())
			}
			renewals := s.renewals.Load()
			time.Sleep(80 * time.Millisecond)
			if s.renewals.Load() != renewals {
				t.Fatal("heartbeat outlived its completed job")
			}
		})
	}
}

func TestAgentCancelsWorkOnRejectedOrInvalidRenewal(t *testing.T) {
	for _, failure := range []string{"conflict", "forbidden", "job", "agent", "token", "deadline", "missing", "json"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			s := newLeaseTestServer(t, 200*time.Millisecond)
			s.renew = func(w http.ResponseWriter, _ *http.Request, receipt leaseReceipt, _ int64) {
				switch failure {
				case "conflict":
					w.WriteHeader(http.StatusConflict)
					return
				case "forbidden":
					w.WriteHeader(http.StatusForbidden)
					return
				case "job":
					receipt.JobID = "other"
				case "agent":
					receipt.AgentID = "other"
				case "token":
					receipt.LeaseToken++
				case "deadline":
					receipt.LeaseUntil = 1
				case "missing":
					w.WriteHeader(http.StatusNoContent)
					return
				case "json":
					fmt.Fprint(w, "invalid json")
					return
				}
				json.NewEncoder(w).Encode(receipt)
			}
			var canceled atomic.Bool
			planner := leaseTestPlanner(func(ctx context.Context) error {
				<-ctx.Done()
				canceled.Store(true)
				return ctx.Err()
			})
			count, err := s.run(planner, fakeTestExecutor{})
			if count != 0 || !errors.Is(err, errLeaseLost) || !canceled.Load() || s.uploads.Load() != 0 || s.completed.Load() != 0 {
				t.Fatalf("count=%d uploads=%d completed=%d canceled=%t err=%v", count, s.uploads.Load(), s.completed.Load(), canceled.Load(), err)
			}
			if s.renewals.Load() != 1 {
				t.Fatalf("retried permanent failure %d times", s.renewals.Load())
			}
		})
	}
}

func TestAgentRetriesTransientRenewalWithinLease(t *testing.T) {
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusTooManyRequests} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			t.Parallel()
			s := newLeaseTestServer(t, 240*time.Millisecond)
			s.renew = func(w http.ResponseWriter, _ *http.Request, receipt leaseReceipt, count int64) {
				if count <= 2 {
					w.WriteHeader(status)
					return
				}
				json.NewEncoder(w).Encode(receipt)
			}
			planner := leaseTestPlanner(func(ctx context.Context) error { return waitForAgentPoll(ctx, 500*time.Millisecond) })
			count, err := s.run(planner, fakeTestExecutor{})
			if err != nil || count != 1 || s.renewals.Load() < 4 {
				t.Fatalf("count=%d renewals=%d err=%v", count, s.renewals.Load(), err)
			}
		})
	}
}

func TestAgentExpiresOnStalledRenewalOrUpload(t *testing.T) {
	for _, phase := range []string{"renew", "upload", "transient"} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			s := newLeaseTestServer(t, 180*time.Millisecond)
			s.renew = func(w http.ResponseWriter, r *http.Request, _ leaseReceipt, _ int64) {
				if phase == "transient" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				<-r.Context().Done()
			}
			planner := leaseTestPlanner(func(ctx context.Context) error {
				if phase == "upload" {
					return nil
				}
				<-ctx.Done()
				return ctx.Err()
			})
			if phase == "upload" {
				s.upload = func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }
			}
			started := time.Now()
			count, err := s.run(planner, fakeTestExecutor{})
			if count != 0 || !errors.Is(err, errLeaseLost) || s.completed.Load() != 0 || time.Since(started) > time.Second {
				t.Fatalf("count=%d completions=%d duration=%v err=%v", count, s.completed.Load(), time.Since(started), err)
			}
			if phase != "upload" && s.uploads.Load() != 0 {
				t.Fatal("lost ownership became job_error evidence")
			}
		})
	}
}

func TestAgentCompletionCannotRaceRenewal(t *testing.T) {
	t.Parallel()
	s := newLeaseTestServer(t, 300*time.Millisecond)
	s.finish = func(ctx context.Context) error {
		before := s.renewals.Load()
		if err := waitForAgentPoll(ctx, 180*time.Millisecond); err != nil {
			return err
		}
		if s.renewals.Load() != before {
			t.Error("renewal overlapped completion")
		}
		return nil
	}
	count, err := s.run(fakeManifestPlanner{}, fakeTestExecutor{})
	if count != 1 || err != nil || s.renewals.Load() != 1 {
		t.Fatalf("count=%d renewals=%d err=%v", count, s.renewals.Load(), err)
	}
}

func TestAgentLeaseAndBackendTimeoutValidation(t *testing.T) {
	t.Parallel()
	if err := validateLease(time.Second, time.Hour, "tdutil", 2*time.Hour, "buck"); err != nil {
		t.Fatalf("valid long-running backends rejected: %v", err)
	}
	for _, duration := range []time.Duration{0, -time.Second, maximumBackendTimeout + time.Nanosecond} {
		if err := validateLease(time.Second, duration, "tdutil", time.Hour, "buck"); err == nil {
			t.Errorf("accepted planner timeout %v", duration)
		}
		if err := validateLease(time.Second, time.Hour, "tdutil", duration, "buck"); err == nil {
			t.Errorf("accepted executor timeout %v", duration)
		}
	}
	for _, duration := range []time.Duration{time.Millisecond, maximumAgentLease + time.Nanosecond} {
		if err := validateLease(duration, time.Hour, "tdutil", time.Hour, "buck"); err == nil || !strings.Contains(err.Error(), "--lease") {
			t.Errorf("invalid lease %v: %v", duration, err)
		}
	}
}

func TestAgentRejectsInvalidOrLateClaim(t *testing.T) {
	t.Parallel()
	for _, invalid := range []string{"job", "agent", "missing-agent", "token", "deadline", "late", "oversized-lease", "sub-millisecond"} {
		t.Run(invalid, func(t *testing.T) {
			c, _ := newClient("http://127.0.0.1:1")
			options := agentOptions{AgentID: "agent", Lease: time.Second}
			claimed := job{ID: "work", AgentID: "agent", LeaseToken: 7, LeaseUntil: 1}
			started := time.Now()
			switch invalid {
			case "job":
				claimed.ID = ""
			case "agent":
				claimed.AgentID = "other"
			case "missing-agent":
				claimed.AgentID = ""
			case "token":
				claimed.LeaseToken = 0
			case "deadline":
				claimed.LeaseUntil = 0
			case "late":
				started = started.Add(-2 * time.Second)
			case "oversized-lease":
				options.Lease = maximumAgentLease + time.Second
			case "sub-millisecond":
				options.Lease = time.Microsecond
			}
			lease, err := c.startJobLease(context.Background(), options, claimed, started)
			if lease != nil {
				lease.close()
				t.Fatal("invalid claim started a heartbeat")
			}
			if !errors.Is(err, errLeaseLost) {
				t.Fatalf("invalid claim error = %v", err)
			}
		})
	}
}

type leaseRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip leaseRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestLateRenewalCannotResurrectExpiredLease(t *testing.T) {
	t.Parallel()
	started := time.Now()
	claimed := job{ID: "work", AgentID: "agent", LeaseToken: 7, LeaseUntil: 1}
	c, _ := newClient("http://127.0.0.1:1")
	c.http.Transport = leaseRoundTripper(func(*http.Request) (*http.Response, error) {
		// Model a transport that delivers a valid acknowledgement despite
		// cancellation. The watchdog must cancel work independently of it.
		time.Sleep(300 * time.Millisecond)
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"job_id":"work","agent_id":"agent","lease_token":7,"lease_until":2}`)),
		}, nil
	})
	lease, err := c.startJobLease(context.Background(), agentOptions{AgentID: "agent", Lease: 180 * time.Millisecond}, claimed, started)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.close()
	select {
	case <-lease.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("watchdog waited for the stalled renewal")
	}
	<-lease.done
	lease.mu.Lock()
	deadline, until := lease.deadline, lease.until
	lease.mu.Unlock()
	if !errors.Is(lease.err(), errLeaseLost) || !deadline.Equal(started.Add(180*time.Millisecond)) || until != 1 {
		t.Fatalf("late reply changed ownership: deadline=%v until=%d error=%v", deadline, until, lease.err())
	}
}

func TestAgentRetriesRenewalTransportFailure(t *testing.T) {
	t.Parallel()
	s := newLeaseTestServer(t, 300*time.Millisecond)
	c, _ := newClient(s.server.URL)
	var failures atomic.Int64
	c.http.Transport = leaseRoundTripper(func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/renew") && failures.Add(1) <= 2 {
			return nil, errors.New("connection temporarily unavailable")
		}
		return http.DefaultTransport.RoundTrip(request)
	})
	count, err := c.runAgent(agentOptions{
		Queue: "default", AgentID: "agent", Lease: s.lease,
		Planner:  leaseTestPlanner(func(ctx context.Context) error { return waitForAgentPoll(ctx, 650*time.Millisecond) }),
		Executor: fakeTestExecutor{}, Timeout: 2 * time.Second,
	}, io.Discard)
	if err != nil || count != 1 || failures.Load() < 3 || s.renewals.Load() < 2 {
		t.Fatalf("count=%d attempts=%d successful renewals=%d err=%v", count, failures.Load(), s.renewals.Load(), err)
	}
}

func TestAgentParentCancellationDoesNotCreateJobError(t *testing.T) {
	for _, phase := range []string{"plan", "upload"} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			s := newLeaseTestServer(t, time.Second)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			planner := leaseTestPlanner(func(work context.Context) error {
				if phase == "upload" {
					return nil
				}
				cancel()
				<-work.Done()
				return errors.New("subprocess killed")
			})
			if phase == "upload" {
				s.upload = func(uploadContext context.Context) error {
					cancel()
					<-uploadContext.Done()
					return uploadContext.Err()
				}
			}
			c, _ := newClient(s.server.URL)
			count, err := c.runAgent(agentOptions{
				Context: ctx, Queue: "default", AgentID: "agent", Lease: s.lease,
				Planner: planner, Executor: fakeTestExecutor{},
			}, io.Discard)
			if count != 0 || !errors.Is(err, context.Canceled) || s.completed.Load() != 0 || s.resultKind.Load() == "job_error" {
				t.Fatalf("count=%d completions=%d result=%v err=%v", count, s.completed.Load(), s.resultKind.Load(), err)
			}
		})
	}
}

func TestCanceledCommandsBoundInheritedPipeWait(t *testing.T) {
	for name, runCommand := range map[string]func(context.Context, string, []string, string) ([]byte, []byte, error){
		"buck": runBuckCommand, "tdutil": runTDUtilCommand, "source": runSourceCommand,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			started := time.Now()
			// The short-lived child inherits stdout and outlives its canceled
			// shell. WaitDelay must free the agent without killing any daemon.
			_, _, err := runCommand(ctx, "sh", []string{"-c", "sleep 2 & wait"}, "")
			if err == nil || ctx.Err() == nil || time.Since(started) > 1800*time.Millisecond {
				t.Fatalf("cancellation took %v: %v", time.Since(started), err)
			}
		})
	}
}
