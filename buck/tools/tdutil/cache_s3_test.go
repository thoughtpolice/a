// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The signing itself is pinned against AWS's published example calculations in
// sigv4_test.go. What is exercised here is everything around it: which URL a
// key becomes, which statuses mean what, and which failures are worth
// repeating.
func withAWSEnvironment(t *testing.T, values map[string]string) {
	t.Helper()
	for _, name := range []string{
		"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3",
	} {
		t.Setenv(name, "")
	}
	for name, value := range values {
		t.Setenv(name, value)
	}
}

func testCredentialEnvironment() map[string]string {
	return map[string]string{
		"AWS_ACCESS_KEY_ID":     sigV4TestAccessKey,
		"AWS_SECRET_ACCESS_KEY": sigV4TestSecretKey,
		"AWS_REGION":            sigV4TestRegion,
	}
}

// s3Against points a store at a fake server, which forces path-style
// addressing exactly as a MinIO or R2 endpoint would.
func s3Against(t *testing.T, server *httptest.Server, location string) blobStore {
	t.Helper()
	environment := testCredentialEnvironment()
	environment["AWS_ENDPOINT_URL_S3"] = server.URL
	withAWSEnvironment(t, environment)
	store, err := openBlobStore(location, 0)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestS3StoreRoundTripsThroughAPathStyleEndpoint(t *testing.T) {
	objects := map[string][]byte{}
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests = append(requests, request.Method+" "+request.URL.Path)
		if request.Header.Get("Authorization") == "" {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		switch request.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(request.Body)
			objects[request.URL.Path] = body
			writer.WriteHeader(http.StatusOK)
		case http.MethodGet:
			body, present := objects[request.URL.Path]
			if !present {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = writer.Write(body)
		}
	}))
	defer server.Close()

	store := s3Against(t, server, "s3://example-bucket/tdutil")
	if _, err := store.get(context.Background(), "v2-2/id/commit.json.gz"); !errors.Is(err, errCacheMiss) {
		t.Fatalf("cold get error = %v, want a miss", err)
	}

	storeString(t, store, "v2-2/id/commit.json.gz", "graph")
	reader, err := store.get(context.Background(), "v2-2/id/commit.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	if got := readAllFrom(t, reader); got != "graph" {
		t.Fatalf("round trip = %q, want %q", got, "graph")
	}

	// The prefix from the location and the derived key both appear, with the
	// bucket in the path because this endpoint is not AWS.
	want := "/example-bucket/tdutil/v2-2/id/commit.json.gz"
	for _, seen := range requests {
		if !strings.HasSuffix(seen, want) {
			t.Fatalf("request %q does not address %q", seen, want)
		}
	}
	if store.String() != "s3://example-bucket/tdutil" {
		t.Fatalf("store described as %q", store.String())
	}
}

// AWS is addressed virtual-host style, since path-style is on its way out for
// new buckets there; everything else is addressed path-style, since MinIO and
// most self-hosted implementations require it.
func TestS3StoreAddressingFollowsTheEndpoint(t *testing.T) {
	withAWSEnvironment(t, testCredentialEnvironment())
	store, err := openBlobStore("s3://example-bucket/tdutil", 0)
	if err != nil {
		t.Fatal(err)
	}
	address := store.(*s3Store).objectURL("v2-2/id/commit.json.gz")
	const want = "https://example-bucket.s3.us-east-1.amazonaws.com/tdutil/v2-2/id/commit.json.gz"
	if address.String() != want {
		t.Fatalf("AWS object URL = %s, want %s", address, want)
	}

	environment := testCredentialEnvironment()
	environment["AWS_ENDPOINT_URL"] = "http://127.0.0.1:9000"
	withAWSEnvironment(t, environment)
	store, err = openBlobStore("s3://example-bucket", 0)
	if err != nil {
		t.Fatal(err)
	}
	address = store.(*s3Store).objectURL("v2-2/id/commit.json.gz")
	const wantMinio = "http://127.0.0.1:9000/example-bucket/v2-2/id/commit.json.gz"
	if address.String() != wantMinio {
		t.Fatalf("endpoint object URL = %s, want %s", address, wantMinio)
	}
}

// Missing credentials are fatal at startup rather than a warning later. They
// are a deterministic property of the caller's configuration which cannot heal
// on a retry, and warning would leave a run paying full collection forever
// with nothing to say why.
func TestS3StoreRequiresCredentials(t *testing.T) {
	withAWSEnvironment(t, map[string]string{"AWS_REGION": "us-east-1"})
	_, err := openBlobStore("s3://bucket/prefix", 0)
	if err == nil {
		t.Fatal("a store opened without credentials")
	}
	for _, want := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %s", err, want)
		}
	}

	withAWSEnvironment(t, testCredentialEnvironment())
	if _, err := openBlobStore("s3://", 0); err == nil {
		t.Error("a store opened with no bucket")
	}
}

// A 5xx may succeed on the next attempt, and the alternative to retrying is a
// full base collection: minutes of work against a few hundred milliseconds.
func TestS3StoreRetriesServerFailuresAndThenReports(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte("<Error><Code>SlowDown</Code></Error>"))
	}))
	defer server.Close()

	store := s3Against(t, server, "s3://bucket/prefix")
	_, err := store.get(context.Background(), "v2-2/id/commit.json.gz")
	if err == nil {
		t.Fatal("a persistent 503 was reported as success")
	}
	if got := attempts.Load(); got != s3TransportRetries+1 {
		t.Fatalf("%d attempts, want %d", got, s3TransportRetries+1)
	}
	// The body S3 sent carries the actual reason, so it is repeated verbatim.
	if !strings.Contains(err.Error(), "SlowDown") {
		t.Errorf("error %q does not repeat the server's explanation", err)
	}
}

func TestS3StoreRecoversWhenARetrySucceeds(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) == 1 {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = writer.Write([]byte("graph"))
	}))
	defer server.Close()

	store := s3Against(t, server, "s3://bucket/prefix")
	reader, err := store.get(context.Background(), "v2-2/id/commit.json.gz")
	if err != nil {
		t.Fatalf("a recoverable failure was not retried: %v", err)
	}
	if got := readAllFrom(t, reader); got != "graph" {
		t.Fatalf("retried body = %q", got)
	}
}

// A 4xx is the server saying it understood and refused. Repeating it only
// wastes the caller's timeout.
func TestS3StoreDoesNotRetryRefusals(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		writer.WriteHeader(http.StatusForbidden)
		_, _ = writer.Write([]byte("<Error><Code>AccessDenied</Code></Error>"))
	}))
	defer server.Close()

	store := s3Against(t, server, "s3://bucket/prefix")
	if _, err := store.get(context.Background(), "v2-2/id/commit.json.gz"); err == nil {
		t.Fatal("a 403 was reported as success")
	} else if !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("error %q does not repeat the server's explanation", err)
	}
	if got := attempts.Load(); got != 1 {
		t.Fatalf("%d attempts, want 1", got)
	}
}

// Every attempt sends the same bytes, which is why a payload is staged on disk
// rather than streamed: a body already consumed cannot be sent again.
func TestS3StorePutResendsTheEntirePayloadOnRetry(t *testing.T) {
	var attempts atomic.Int32
	var received []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		received = append(received, string(body))
		if attempts.Add(1) == 1 {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	store := s3Against(t, server, "s3://bucket/prefix")
	storeString(t, store, "v2-2/id/commit.json.gz", "a whole graph document")
	if len(received) != 2 {
		t.Fatalf("%d bodies received, want 2", len(received))
	}
	for index, body := range received {
		if body != "a whole graph document" {
			t.Errorf("attempt %d sent %q, want the whole payload", index+1, body)
		}
	}
}

// The caller's timeout bounds the whole sequence, retries included, so a hung
// backend cannot stall a run to its job timeout.
func TestS3StoreHonorsTheCallersDeadline(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		<-release
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	defer close(release)

	store := s3Against(t, server, "s3://bucket/prefix")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	started := time.Now()
	if _, err := store.get(ctx, "v2-2/id/commit.json.gz"); err == nil {
		t.Fatal("a hung request was reported as success")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the deadline took %s to take effect", elapsed)
	}
}

func TestS3StoreRedactsCredentialsFromDiagnostics(t *testing.T) {
	address, err := url.Parse("https://key:secret@bucket.s3.amazonaws.com/object")
	if err != nil {
		t.Fatal(err)
	}
	response := &http.Response{
		Status:     "403 Forbidden",
		StatusCode: http.StatusForbidden,
		Body:       io.NopCloser(strings.NewReader("<Error/>")),
	}
	if message := s3StatusError("GET", address, response).Error(); strings.Contains(message, "secret") {
		t.Fatalf("diagnostic leaked a credential: %s", message)
	}
}
