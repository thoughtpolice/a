// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSeed(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/repos/demo/epochs" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		var seed seedRequest
		if err := json.NewDecoder(request.Body).Decode(&seed); err != nil {
			t.Fatal(err)
		}
		if seed.Revision != "r1" || seed.Queue != "default" {
			t.Errorf("seed = %#v", seed)
		}
		response.Header().Set("content-type", "application/json")
		response.WriteHeader(http.StatusCreated)
		fmt.Fprint(response, `{"repo":"demo","revision":"r1","epoch_id":"e000001","created":true}`)
	}))
	defer server.Close()

	c, err := newClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	created, err := c.seed("demo", fakeSeed("r1", "default"))
	if err != nil {
		t.Fatal(err)
	}
	if created.EpochID != "e000001" || !created.Created {
		t.Fatalf("created = %#v", created)
	}
}

func TestAgentDrainsQueue(t *testing.T) {
	t.Parallel()
	claims := 0
	completionKinds := []string{}
	artifacts := map[string]json.RawMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/queues/default/claim":
			claims++
			if claims > 3 {
				response.WriteHeader(http.StatusNoContent)
				return
			}
			response.Header().Set("content-type", "application/json")
			switch claims {
			case 1:
				writeClaimFixture(response, `{"id":"plan-1","kind":"plan_epoch","base_revision":null,"revision":"r1","lease_token":7}`, "agent-a")
			case 2:
				writeClaimFixture(response, `{"id":"batch-1","kind":"run_tests","platform":"linux-x86_64","tests":[{"id":"t0001","test_key":"buck-test:v1:lib","label":"root//lib:unit"},{"id":"t0002","test_key":"buck-test:v1:service","label":"root//service:integration"}],"lease_token":8}`, "agent-a")
			case 3:
				writeClaimFixture(response, `{"id":"batch-2","kind":"run_tests","platform":"darwin-arm64","tests":[{"id":"t0003","test_key":"buck-test:v1:cli","label":"root//cli:smoke"}],"lease_token":9}`, "agent-a")
			}
		case "/v1/queues/default/renew":
			writeRenewFixture(response, request)
		case "/v1/artifacts":
			contents, err := io.ReadAll(request.Body)
			if err != nil {
				t.Error(err)
			}
			ref := fixtureArtifactRef(contents)
			artifacts[ref.Key] = contents
			json.NewEncoder(response).Encode(ref)
		case "/v1/queues/default/complete":
			var completion map[string]any
			if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
				t.Fatal(err)
			}
			ref, ok := completion["result_ref"].(map[string]any)
			if !ok {
				t.Fatalf("completion result_ref = %#v", completion["result_ref"])
			}
			var result map[string]any
			if err := json.Unmarshal(artifacts[ref["key"].(string)], &result); err != nil {
				t.Error(err)
			}
			completionKinds = append(completionKinds, result["kind"].(string))
			fmt.Fprint(response, `{}`)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	c, err := newClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	completed, err := c.runAgent(agentOptions{
		Queue:        "default",
		AgentID:      "agent-a",
		Drain:        true,
		Lease:        defaultAgentLease,
		Planner:      fakeManifestPlanner{},
		Executor:     fakeTestExecutor{},
		IdleGrace:    time.Millisecond,
		PollInterval: time.Millisecond,
	}, &output)
	if err != nil {
		t.Fatal(err)
	}
	if completed != 3 || len(completionKinds) != 3 {
		t.Fatalf("completed=%d kinds=%v", completed, completionKinds)
	}
	if strings.Join(completionKinds, ",") != "plan_epoch,run_tests,run_tests" {
		t.Fatalf("completion kinds = %v", completionKinds)
	}
	if !strings.Contains(output.String(), "planned 3 tests") || !strings.Contains(output.String(), "root//lib:unit") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestBadServiceURL(t *testing.T) {
	t.Parallel()
	if _, err := newClient("localhost:8080"); err == nil {
		t.Fatal("accepted URL without a scheme")
	}
}

func TestHelp(t *testing.T) {
	t.Parallel()
	var output strings.Builder
	if err := run([]string{"help"}, &output, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "orchestra") {
		t.Fatalf("output = %q", output.String())
	}
}

// fixtureArtifactRef mirrors the server's raw-byte content addressing, so
// transport tests catch accidental hashing of a re-serialized JSON document.
func fixtureArtifactRef(contents []byte) artifactRef {
	digest := fmt.Sprintf("%x", sha256.Sum256(contents))
	return artifactRef{Key: "sha256/" + digest + ".json", SHA256: digest, Size: len(contents)}
}

// writeClaimFixture supplies the broker metadata required to prove ownership.
func writeClaimFixture(response http.ResponseWriter, contents, agent string) {
	var claimed job
	json.Unmarshal([]byte(contents), &claimed)
	claimed.AgentID = agent
	claimed.LeaseUntil = time.Now().Add(defaultAgentLease).UnixMilli()
	json.NewEncoder(response).Encode(claimed)
}

// writeRenewFixture echoes the current fence with a renewed server deadline.
func writeRenewFixture(response http.ResponseWriter, request *http.Request) {
	var receipt leaseReceipt
	json.NewDecoder(request.Body).Decode(&receipt)
	receipt.LeaseUntil = time.Now().Add(defaultAgentLease).UnixMilli()
	json.NewEncoder(response).Encode(receipt)
}

func TestAgentUploadsAndRetriesImmutableArtifacts(t *testing.T) {
	t.Parallel()
	uploads, completions := 0, 0
	var firstContents string
	var firstCompletion string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/queues/default/claim":
			var claim struct {
				Platforms []string `json:"platforms"`
				Kinds     []string `json:"kinds"`
			}
			if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
				t.Error(err)
			}
			if !containsString(claim.Platforms, "linux-x86_64") || !containsString(claim.Kinds, "plan_culprit") {
				t.Errorf("capabilities = %#v", claim)
			}
			writeClaimFixture(response, `{"id":"plan-1","kind":"plan_epoch","base_revision":null,"revision":"r1","lease_token":7}`, "test")
		case "/v1/queues/default/renew":
			writeRenewFixture(response, request)
		case "/v1/artifacts":
			uploads++
			contents, err := io.ReadAll(request.Body)
			if err != nil {
				t.Error(err)
			}
			if request.Header.Get("Content-Type") != "application/json" {
				t.Errorf("content type = %q", request.Header.Get("Content-Type"))
			}
			if uploads == 1 {
				firstContents = string(contents)
			} else if string(contents) != firstContents {
				t.Error("artifact retry changed raw bytes")
			}
			json.NewEncoder(response).Encode(fixtureArtifactRef(contents))
		case "/v1/queues/default/complete":
			completions++
			contents, err := io.ReadAll(request.Body)
			if err != nil {
				t.Error(err)
			}
			if completions == 1 {
				firstCompletion = string(contents)
			} else if string(contents) != firstCompletion {
				t.Error("completion retry changed reference or fencing token")
			}
			var completion map[string]json.RawMessage
			json.Unmarshal(contents, &completion)
			if _, inline := completion["result"]; inline {
				t.Error("completion contains an inline result")
			}
			var ref artifactRef
			json.Unmarshal(completion["result_ref"], &ref)
			if ref != fixtureArtifactRef([]byte(firstContents)) {
				t.Errorf("completion ref = %#v", ref)
			}
			fmt.Fprint(response, `{}`)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	c, _ := newClient(server.URL)
	count, err := c.runAgent(agentOptions{
		Queue: "default", AgentID: "test", Lease: defaultAgentLease,
		Planner: fakeManifestPlanner{}, Executor: fakeTestExecutor{}, RetryCompletions: true,
	}, io.Discard)
	if err != nil || count != 1 || uploads != 2 || completions != 2 {
		t.Fatalf("count=%d uploads=%d completions=%d err=%v", count, uploads, completions, err)
	}
}

func TestArtifactReferenceValidation(t *testing.T) {
	t.Parallel()
	for _, field := range []string{"key", "sha256", "size", "uppercase"} {
		t.Run(field, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				contents, _ := io.ReadAll(request.Body)
				ref := fixtureArtifactRef(contents)
				switch field {
				case "key":
					ref.Key = "untrusted/path.json"
				case "sha256":
					ref.SHA256 = strings.Repeat("0", 64)
				case "size":
					ref.Size++
				case "uppercase":
					ref.SHA256 = strings.ToUpper(ref.SHA256)
				}
				json.NewEncoder(response).Encode(ref)
			}))
			defer server.Close()
			c, _ := newClient(server.URL)
			if _, err := c.uploadArtifact(context.Background(), []byte(`{"kind":"run_tests","tests":[]}`)); err == nil {
				t.Fatal("accepted invalid artifact reference")
			}
		})
	}
}

func TestArtifactUploadPreservesExactBytes(t *testing.T) {
	t.Parallel()
	contents := []byte(" { \"input\": \"<unicode Ω>\", \"count\": 1 }\n")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		got, _ := io.ReadAll(request.Body)
		if string(got) != string(contents) {
			t.Errorf("upload reformatted raw JSON: %q", got)
		}
		json.NewEncoder(response).Encode(fixtureArtifactRef(got))
	}))
	defer server.Close()
	c, _ := newClient(server.URL)
	ref, err := c.uploadArtifact(context.Background(), contents)
	if err != nil || ref != fixtureArtifactRef(contents) {
		t.Fatalf("ref=%+v error=%v", ref, err)
	}
}

func TestAgentWaitsThroughAsynchronousFanout(t *testing.T) {
	t.Parallel()
	claims, completions, epochReads := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/repos/demo/epochs/e1":
			epochReads++
			if completions == 1 && claims >= 7 {
				fmt.Fprint(response, `{"state":"complete"}`)
			} else {
				fmt.Fprint(response, `{"state":"running"}`)
			}
		case "/v1/queues/default/claim":
			claims++
			if claims == 4 {
				writeClaimFixture(response, `{"id":"plan-1","kind":"plan_epoch","base_revision":null,"revision":"r1","lease_token":7}`, "test")
			} else {
				response.WriteHeader(http.StatusNoContent)
			}
		case "/v1/artifacts":
			contents, _ := io.ReadAll(request.Body)
			json.NewEncoder(response).Encode(fixtureArtifactRef(contents))
		case "/v1/queues/default/renew":
			writeRenewFixture(response, request)
		case "/v1/queues/default/complete":
			completions++
			fmt.Fprint(response, `{}`)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	c, _ := newClient(server.URL)
	count, err := c.runAgent(agentOptions{
		Queue: "default", AgentID: "test", Lease: defaultAgentLease, Drain: true,
		Planner: fakeManifestPlanner{}, Executor: fakeTestExecutor{},
		UntilRepo: "demo", UntilEpoch: "e1", Timeout: time.Second,
		IdleGrace: time.Millisecond, PollInterval: time.Millisecond,
	}, io.Discard)
	if err != nil || count != 1 || claims != 7 || epochReads != 8 {
		t.Fatalf("count=%d claims=%d epoch reads=%d err=%v", count, claims, epochReads, err)
	}
}

// Default draining must outlast the server's 30-second adaptive polling cap.
// Fast injected claim intervals exercise normalization and explicit overrides;
// a final fixture error stops the default case without waiting a real minute.
func TestAgentDefaultIdleGraceAccommodatesWorkflowPolling(t *testing.T) {
	t.Parallel()
	if defaultIdleGrace != time.Minute {
		t.Fatalf("default idle grace = %s, want one minute for the 30-second Workflow polling gap", defaultIdleGrace)
	}
	for _, test := range []struct {
		name      string
		idleGrace time.Duration
		wantJobs  int
	}{
		{name: "normalized default", wantJobs: 1},
		{name: "explicit short override", idleGrace: time.Millisecond},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			claims, completions := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/v1/queues/default/claim":
					claims++
					switch {
					case claims < 4:
						response.WriteHeader(http.StatusNoContent)
					case claims == 4:
						writeClaimFixture(response, `{"id":"plan-1","kind":"plan_epoch","base_revision":null,"revision":"r1","lease_token":7}`, "test")
					default:
						http.Error(response, "fixture fanout complete", http.StatusGone)
					}
				case "/v1/artifacts":
					contents, _ := io.ReadAll(request.Body)
					json.NewEncoder(response).Encode(fixtureArtifactRef(contents))
				case "/v1/queues/default/renew":
					writeRenewFixture(response, request)
				case "/v1/queues/default/complete":
					completions++
					fmt.Fprint(response, `{}`)
				default:
					http.NotFound(response, request)
				}
			}))
			defer server.Close()
			c, _ := newClient(server.URL)
			count, err := c.runAgent(agentOptions{
				Queue: "default", AgentID: "test", Drain: true,
				Planner: fakeManifestPlanner{}, Executor: fakeTestExecutor{},
				IdleGrace: test.idleGrace, PollInterval: time.Millisecond,
				Timeout: time.Second,
			}, io.Discard)
			if count != test.wantJobs || completions != test.wantJobs {
				t.Fatalf("count=%d completions=%d, want=%d: %v", count, completions, test.wantJobs, err)
			}
			if test.wantJobs == 0 {
				if err != nil || claims != 2 {
					t.Fatalf("explicit idle grace did not drain promptly: claims=%d err=%v", claims, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "fixture fanout complete") || claims != 5 {
				t.Fatalf("default idle grace did not span delayed fanout: claims=%d err=%v", claims, err)
			}
		})
	}
}

func TestAgentTerminalWaitIsBounded(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.Contains(request.URL.Path, "/epochs/") {
			fmt.Fprint(response, `{"state":"running"}`)
		} else {
			response.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	c, _ := newClient(server.URL)
	_, err := c.runAgent(agentOptions{
		Queue: "default", Drain: true, UntilRepo: "demo", UntilEpoch: "e1",
		Timeout: 10 * time.Millisecond, PollInterval: time.Millisecond,
	}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatalf("error = %v", err)
	}
}

func TestAgentRefusesUnadvertisedPlatform(t *testing.T) {
	t.Parallel()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		var claim struct {
			Platforms []string `json:"platforms"`
		}
		json.NewDecoder(request.Body).Decode(&claim)
		if len(claim.Platforms) != 1 || claim.Platforms[0] != hostPlatform() {
			t.Errorf("platform filter = %v", claim.Platforms)
		}
		fmt.Fprint(response, `{"id":"bad","kind":"run_tests","platform":"unsupported-cpu","lease_token":7}`)
	}))
	defer server.Close()
	c, _ := newClient(server.URL)
	_, err := c.runAgent(agentOptions{
		Queue: "default", Planner: fakeManifestPlanner{},
		Executor: buckTestExecutor{hostPlatform: hostPlatform()},
	}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "incompatible platform") || requests != 1 {
		t.Fatalf("requests=%d error=%v", requests, err)
	}
}

func TestAgentReportsPlanningErrorAsArtifact(t *testing.T) {
	t.Parallel()
	kind := ""
	completed := false
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/queues/default/claim":
			// A missing base cannot be attributed to a source culprit.
			writeClaimFixture(response, `{"id":"bad","kind":"plan_culprit","revision":"r1","platform":"linux-x86_64","lease_token":7}`, "test")
		case "/v1/queues/default/renew":
			writeRenewFixture(response, request)
		case "/v1/artifacts":
			contents, _ := io.ReadAll(request.Body)
			var result struct {
				Kind    string `json:"kind"`
				Message string `json:"message"`
			}
			json.Unmarshal(contents, &result)
			kind = result.Kind
			if !strings.Contains(result.Message, "passing base") {
				t.Errorf("message = %q", result.Message)
			}
			json.NewEncoder(response).Encode(fixtureArtifactRef(contents))
		case "/v1/queues/default/complete":
			completed = true
			fmt.Fprint(response, `{}`)
		}
	}))
	defer server.Close()
	c, _ := newClient(server.URL)
	count, err := c.runAgent(agentOptions{
		Queue: "default", AgentID: "test", Planner: fakeManifestPlanner{}, Executor: fakeTestExecutor{},
	}, io.Discard)
	if err != nil || count != 1 || kind != "job_error" || !completed {
		t.Fatalf("count=%d kind=%s complete=%v err=%v", count, kind, completed, err)
	}
}
