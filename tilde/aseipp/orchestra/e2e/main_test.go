// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These tests check the black-box harness itself: an incorrectly addressed R2
// artifact, missing object, or mismatched HTTP body must not produce a green
// integration test merely because the control-plane counters look complete.
package main

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVerifyArtifacts(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-digest", "wrong-public-body", "empty"} {
		t.Run(mode, func(t *testing.T) {
			objects := map[string]string{}
			for _, content := range []string{`{"kind":"plan"}`, `{"kind":"result","batch":1}`, `{"kind":"result","batch":2}`} {
				digest := sha256.Sum256([]byte(content))
				objects[fmt.Sprintf("sha256/%x.json", digest)] = content
			}
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/fleet" {
					if r.URL.Query().Get("list-type") != "2" || r.URL.Query().Get("prefix") != "r2/orchestra-artifacts/" {
						t.Errorf("listing used wrong query: %s", r.URL.RawQuery)
					}
					fmt.Fprint(w, "<ListBucketResult><IsTruncated>false</IsTruncated>")
					if mode != "empty" {
						for key := range objects {
							fmt.Fprintf(w, "<Contents><Key>r2/orchestra-artifacts/%s</Key></Contents>", key)
						}
					}
					fmt.Fprint(w, "</ListBucketResult>")
					return
				}
				key := strings.TrimPrefix(r.URL.Path, "/fleet/r2/orchestra-artifacts/")
				public := strings.HasPrefix(r.URL.Path, "/v1/artifacts/")
				if public {
					key = strings.TrimPrefix(r.URL.Path, "/v1/artifacts/")
				}
				content, ok := objects[key]
				if !ok {
					http.NotFound(w, r)
					return
				}
				if mode == "wrong-digest" || (mode == "wrong-public-body" && public) {
					content = `{"changed":true}`
				}
				w.Header().Set("ETag", `"immutable"`)
				fmt.Fprint(w, content)
			})
			client := &http.Client{Transport: handlerTransport{handler}}
			artifacts, err := verifyArtifacts(client, "http://orchestra.test", "fleet", "http://orchestra.test")
			if mode != "valid" {
				if err == nil {
					t.Fatalf("%s artifacts unexpectedly passed verification", mode)
				}
				return
			}
			if err != nil || len(artifacts) != 3 {
				t.Fatalf("verifyArtifacts() = %v, %v", artifacts, err)
			}
			for key, etag := range artifacts {
				if etag != `"immutable"` {
					t.Errorf("artifact %s lost its ETag: %q", key, etag)
				}
			}
		})
	}
}

// handlerTransport exercises HTTP requests without binding a local socket, so
// harness unit tests can run inside Buck's network-restricted test sandbox.
type handlerTransport struct{ handler http.Handler }

func (transport handlerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response := httptest.NewRecorder()
	transport.handler.ServeHTTP(response, request)
	return response.Result(), nil
}

func TestWaitForImmediateSuccess(t *testing.T) {
	if err := waitFor("ready", time.Second, func() (bool, error) { return true, nil }); err != nil {
		t.Fatal(err)
	}
}

func TestWaitForPreservesFailure(t *testing.T) {
	err := waitFor("Workflow", time.Second, func() (bool, error) {
		return false, fmt.Errorf("instance failed")
	})
	if err == nil || !strings.Contains(err.Error(), "Workflow: instance failed") {
		t.Fatalf("waitFor() = %v", err)
	}
}

func TestRunRejectsIncompleteCommands(t *testing.T) {
	for _, args := range [][]string{nil, {"deploy"}, {"test"}, {"unknown"}, {"resource", "chaos3"}} {
		if err := run(args); err == nil {
			t.Errorf("run(%v) unexpectedly succeeded", args)
		}
	}
}
