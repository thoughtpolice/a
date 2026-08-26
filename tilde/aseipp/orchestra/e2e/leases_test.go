// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These harness contracts prevent a green lease E2E when the proxy failed to
// delay the upload, counted rejected renewals, or hid a changed ownership fence.
// The transport is entirely in-process for Buck's network-restricted unit tests.
package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// leaseTransport also sets Request, matching the real net/http transport's
// contract required by the reverse proxy's response observer.
type leaseTransport struct{ handler http.Handler }

func (transport leaseTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response := httptest.NewRecorder()
	transport.handler.ServeHTTP(response, request)
	result := response.Result()
	result.Request = request
	return result, nil
}

func TestDelayedUploadProxyCountsOnlyAcceptedRenewals(t *testing.T) {
	status := http.StatusConflict
	contents := `{"job_id":"job-1","agent_id":"agent-a","lease_token":7,"lease_until":200}`
	probe, err := newDelayedUploadProxy("http://celld.test", time.Second, leaseTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/queues/q/renew" {
			t.Errorf("proxy forwarded wrong path: %s", r.URL.Path)
		}
		w.WriteHeader(status)
		fmt.Fprint(w, contents)
	})})
	if err != nil {
		t.Fatal(err)
	}
	probe.claim = leaseReceipt{ID: "job-1", AgentID: "agent-a", LeaseToken: 7, LeaseUntil: 100}
	probe.start = time.Now()
	for _, code := range []int{http.StatusConflict, http.StatusOK, http.StatusOK} {
		status = code
		response := httptest.NewRecorder()
		probe.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "http://proxy.test/v1/queues/q/renew", nil))
		if response.Code != code || response.Body.String() != contents {
			t.Fatalf("proxy changed response: HTTP %d %s", response.Code, response.Body.String())
		}
	}
	if probe.count != 2 {
		t.Fatalf("counted %d accepted renewals, want 2", probe.count)
	}
	probe.end = time.Now()
	probe.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "http://proxy.test/v1/queues/q/renew", nil))
	if probe.count != 2 {
		t.Fatal("counted renewal after the upload stall ended")
	}
	if err := probe.verify(); err != nil {
		t.Fatal(err)
	}
}

func TestDelayedUploadProxyRejectsChangedOwnership(t *testing.T) {
	for _, contents := range []string{
		`{"job_id":"different","agent_id":"agent-a","lease_token":7,"lease_until":200}`,
		`{"job_id":"job-1","agent_id":"different","lease_token":7,"lease_until":200}`,
		`{"job_id":"job-1","agent_id":"agent-a","lease_token":8,"lease_until":200}`,
		`{"job_id":"job-1","agent_id":"agent-a","lease_token":7,"lease_until":99}`,
	} {
		t.Run(contents, func(t *testing.T) {
			probe, err := newDelayedUploadProxy("http://celld.test", time.Second, leaseTransport{http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, contents)
			})})
			if err != nil {
				t.Fatal(err)
			}
			probe.claim = leaseReceipt{ID: "job-1", AgentID: "agent-a", LeaseToken: 7, LeaseUntil: 100}
			probe.start = time.Now()
			probe.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "http://proxy.test/v1/queues/q/renew", nil))
			if err := probe.verify(); err == nil || !strings.Contains(err.Error(), "changed claimed identity or shortened expiry") {
				t.Fatalf("verify() = %v", err)
			}
		})
	}
}

func TestDelayedUploadProxyCancellationDoesNotForward(t *testing.T) {
	forwarded := false
	probe, err := newDelayedUploadProxy("http://celld.test", time.Hour, leaseTransport{http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		forwarded = true
	})})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "http://proxy.test/v1/artifacts", nil).WithContext(ctx)
	probe.ServeHTTP(httptest.NewRecorder(), request)
	if forwarded || !probe.end.IsZero() || probe.verify() == nil {
		t.Fatal("cancelled upload was forwarded or passed the renewal probe")
	}
}

func TestDelayedUploadProxyDelaysOnlyFirstUpload(t *testing.T) {
	forwarded := 0
	probe, err := newDelayedUploadProxy("http://celld.test", time.Millisecond, leaseTransport{http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		forwarded++
		w.WriteHeader(http.StatusCreated)
	})})
	if err != nil {
		t.Fatal(err)
	}
	probe.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "http://proxy.test/v1/artifacts", nil))
	start, end := probe.start, probe.end
	probe.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "http://proxy.test/v1/artifacts", nil))
	if forwarded != 2 || start.IsZero() || end.Sub(start) < time.Millisecond || probe.start != start || probe.end != end {
		t.Fatalf("unexpected upload delay observation: forwarded=%d start=%s end=%s", forwarded, probe.start, probe.end)
	}
}

func TestDelayedUploadVerificationRequiresLiveEvidence(t *testing.T) {
	now := time.Now()
	for _, mode := range []string{"missing-claim", "missing-upload", "incomplete-upload", "short-upload", "one-renewal"} {
		t.Run(mode, func(t *testing.T) {
			probe := delayedUploadProxy{claim: leaseReceipt{ID: "job-1", LeaseUntil: now.UnixMilli()}, start: now, end: now.Add(time.Second), count: 2}
			switch mode {
			case "missing-claim":
				probe.claim = leaseReceipt{}
			case "missing-upload":
				probe.start = time.Time{}
			case "incomplete-upload":
				probe.end = time.Time{}
			case "short-upload":
				probe.end = now
			case "one-renewal":
				probe.count = 1
			}
			if probe.verify() == nil {
				t.Fatal("incomplete lease evidence unexpectedly passed")
			}
		})
	}
}

func TestLeaseRequestsRejectUnexpectedResponses(t *testing.T) {
	for _, code := range []int{http.StatusOK, http.StatusNoContent, http.StatusConflict, http.StatusBadRequest, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			client := &http.Client{Transport: handlerTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("invalid protocol request: %s %+v", r.Method, r.Header)
				}
				if _, ok := r.Context().Deadline(); !ok {
					t.Error("protocol request has no deadline")
				}
				w.WriteHeader(code)
				if code != http.StatusNoContent {
					fmt.Fprint(w, `{"lease_token":7}`)
				}
			})}}
			var receipt leaseReceipt
			status, err := requestLeaseJSON(client, "http://celld.test/v1/queues/q/renew", map[string]any{"lease_token": 7}, &receipt)
			wantError := code == http.StatusBadRequest || code == http.StatusServiceUnavailable
			if status != code || (err != nil) != wantError || (code == http.StatusOK && receipt.LeaseToken != 7) {
				t.Fatalf("lease request = %d, %+v, %v", status, receipt, err)
			}
		})
	}
}

func TestLeaseBodyRejectsOversizedResponse(t *testing.T) {
	if _, err := readLeaseBody(strings.NewReader(strings.Repeat("x", (1<<20)+1))); err == nil {
		t.Fatal("oversized lease response was accepted")
	}
}

func TestLeaseExpiryRejectsInvalidDeadline(t *testing.T) {
	for _, receipt := range []leaseReceipt{{}, {ID: "job-1", LeaseToken: 1, LeaseUntil: time.Now().Add(time.Hour).UnixMilli()}} {
		if err := waitForLeaseExpiry(receipt); err == nil {
			t.Fatalf("accepted unbounded test lease: %+v", receipt)
		}
	}
}
