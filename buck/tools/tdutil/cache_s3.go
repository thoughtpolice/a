// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// The S3 backend, which is two verbs: fetch an object, store an object. No
// listing, no multipart, no deletion, and so no XML to parse — S3 answers a
// GET and a PUT with bytes and a status, and only reports failures as XML,
// which is repeated verbatim into a diagnostic rather than decoded.
//
// The required bucket policy is correspondingly small: GetObject and PutObject
// alone. Retention belongs to a lifecycle rule, which is why there is no
// DeleteObject here and no way for a misconfigured run to remove anything.
//
// Speaking only S3 also reaches well beyond S3. An endpoint override points
// the same signing and the same two verbs at GCS's XML API, R2, MinIO, or any
// other S3-compatible store, so those cost no additional code.
const (
	s3Service          = "s3"
	s3DefaultRegion    = "us-east-1"
	s3TransportRetries = 2
)

type s3Store struct {
	client      *http.Client
	endpoint    *url.URL
	bucket      string
	prefix      string
	region      string
	credentials awsCredentials
	pathStyle   bool
	now         func() time.Time
}

// newS3Store resolves everything about the destination up front, so that a
// misconfiguration is a startup error naming what is missing rather than an
// authentication failure much later that looks like an outage.
func newS3Store(location string) (blobStore, error) {
	parsed, err := url.Parse(location)
	if err != nil {
		return nil, fmt.Errorf("cache location `%s`: %w", location, err)
	}
	bucket := parsed.Host
	if bucket == "" {
		return nil, fmt.Errorf("cache location `%s`: no bucket (expected s3://BUCKET/PREFIX)", location)
	}
	prefix := strings.Trim(parsed.Path, "/")

	credentials, err := awsCredentialsFromEnvironment()
	if err != nil {
		return nil, err
	}
	region := firstNonEmptyEnv("AWS_REGION", "AWS_DEFAULT_REGION")
	if region == "" {
		region = s3DefaultRegion
	}

	endpoint, pathStyle, err := resolveS3Endpoint(region)
	if err != nil {
		return nil, err
	}
	return &s3Store{
		client:      &http.Client{},
		endpoint:    endpoint,
		bucket:      bucket,
		prefix:      prefix,
		region:      region,
		credentials: credentials,
		pathStyle:   pathStyle,
		now:         time.Now,
	}, nil
}

// awsCredentialsFromEnvironment reads the only credential source implemented.
// It is deliberately the whole chain: GitHub's OIDC action exports exactly
// these three variables, and locally `aws configure export-credentials
// --format env` produces them from whatever the real chain would have
// resolved, so the swamp of profile files, SSO caches, role chaining, and
// instance metadata stays behind one function that can grow later.
//
// Absence is fatal rather than a warning. It is deterministic and cannot heal
// on a retry, and a warning would leave a run silently paying full collection
// on every invocation with nothing to show why.
func awsCredentialsFromEnvironment() (awsCredentials, error) {
	credentials := awsCredentials{
		accessKeyID:     os.Getenv("AWS_ACCESS_KEY_ID"),
		secretAccessKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
		sessionToken:    os.Getenv("AWS_SESSION_TOKEN"),
	}
	if credentials.accessKeyID == "" || credentials.secretAccessKey == "" {
		return awsCredentials{}, fmt.Errorf(
			"no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY " +
				"(and AWS_SESSION_TOKEN for temporary credentials), " +
				"for instance with `aws configure export-credentials --format env`",
		)
	}
	return credentials, nil
}

// resolveS3Endpoint honors the SDK-wide endpoint overrides, which is what lets
// one implementation reach GCS, R2, or MinIO.
//
// Addressing follows the endpoint rather than a flag. AWS has signalled that
// path-style is on its way out for new buckets, while MinIO and most
// self-hosted implementations require it, so virtual-host addressing is used
// for AWS itself and path-style everywhere else.
func resolveS3Endpoint(region string) (*url.URL, bool, error) {
	override := firstNonEmptyEnv("AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL")
	if override == "" {
		endpoint, err := url.Parse("https://" + s3Service + "." + region + ".amazonaws.com")
		return endpoint, false, err
	}
	endpoint, err := url.Parse(override)
	if err != nil {
		return nil, false, fmt.Errorf("invalid S3 endpoint `%s`: %w", override, err)
	}
	if endpoint.Scheme == "" || endpoint.Host == "" {
		return nil, false, fmt.Errorf("invalid S3 endpoint `%s`: expected scheme://host", override)
	}
	return endpoint, true, nil
}

func firstNonEmptyEnv(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

func (store *s3Store) String() string {
	if store.prefix == "" {
		return "s3://" + store.bucket
	}
	return "s3://" + store.bucket + "/" + store.prefix
}

// objectURL places the key under the configured prefix and addresses the
// bucket the way this endpoint expects.
func (store *s3Store) objectURL(key string) *url.URL {
	object := key
	if store.prefix != "" {
		object = store.prefix + "/" + key
	}
	address := *store.endpoint
	if store.pathStyle {
		address.Path = "/" + store.bucket + "/" + object
	} else {
		address.Host = store.bucket + "." + address.Host
		address.Path = "/" + object
	}
	return &address
}

func (store *s3Store) get(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := validateCacheKey(key); err != nil {
		return nil, err
	}
	response, err := store.roundTrip(ctx, http.MethodGet, key, emptyPayloadSHA256, nil)
	if err != nil {
		return nil, err
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		_ = response.Body.Close()
		return nil, errCacheMiss
	case response.StatusCode != http.StatusOK:
		return nil, s3StatusError("GET", store.objectURL(key), response)
	}
	return response.Body, nil
}

func (store *s3Store) put(ctx context.Context, key string, payload stagedBlob) error {
	if err := validateCacheKey(key); err != nil {
		return err
	}
	response, err := store.roundTrip(ctx, http.MethodPut, key, payload.sha256, &payload)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return s3StatusError("PUT", store.objectURL(key), response)
	}
	return nil
}

// roundTrip signs and sends one request, retrying only what a retry can fix.
//
// A connection error or a 5xx may well succeed on the next attempt, and the
// alternative to retrying is a full base collection — minutes of work traded
// against a few hundred milliseconds. A 4xx is the server saying it understood
// and refused, so repeating it only wastes time. The caller's timeout bounds
// the whole sequence, so retries cannot extend a run beyond it.
func (store *s3Store) roundTrip(ctx context.Context, method, key, payloadSHA256 string, payload *stagedBlob) (*http.Response, error) {
	address := store.objectURL(key)
	var lastErr error
	for attempt := 0; attempt <= s3TransportRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(200*(1<<(attempt-1))) * time.Millisecond
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}

		request, body, err := store.newRequest(ctx, method, address, payloadSHA256, payload)
		if err != nil {
			return nil, err
		}
		response, err := store.client.Do(request)
		if body != nil {
			// The transport has finished with the file either way: on success
			// it read the body to completion, and on failure it will not read
			// any more of it.
			_ = body.Close()
		}
		if err != nil {
			lastErr = err
			continue
		}
		if response.StatusCode >= 500 {
			lastErr = s3StatusError(method, address, response)
			continue
		}
		return response, nil
	}
	return nil, fmt.Errorf("%s %s: %w", method, address.Redacted(), lastErr)
}

// newRequest builds and signs a fresh request. Each attempt gets its own,
// because a retry has to reread the payload from the start and because the
// signature covers a timestamp which must not go stale across a backoff.
func (store *s3Store) newRequest(
	ctx context.Context,
	method string,
	address *url.URL,
	payloadSHA256 string,
	payload *stagedBlob,
) (*http.Request, io.Closer, error) {
	var body io.ReadCloser
	var length int64
	if payload != nil {
		file, err := payload.open()
		if err != nil {
			return nil, nil, err
		}
		body, length = file, payload.size
	}
	request, err := http.NewRequestWithContext(ctx, method, address.String(), body)
	if err != nil {
		if body != nil {
			_ = body.Close()
		}
		return nil, nil, err
	}
	if payload != nil {
		request.ContentLength = length
		request.Header.Set("Content-Length", strconv.FormatInt(length, 10))
		request.Header.Set("Content-Type", "application/gzip")
	}
	signV4(request, store.credentials, store.region, s3Service, payloadSHA256, store.now())
	return request, body, nil
}

// s3StatusError reports a refusal with the body S3 sent. That body is XML
// carrying the actual reason — an expired token, a denied action, a bucket in
// another region — and repeating it verbatim beats decoding it into something
// less specific.
func s3StatusError(method string, address *url.URL, response *http.Response) error {
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
	_ = response.Body.Close()
	message := collapseSpaces(string(detail))
	if message == "" {
		return fmt.Errorf("%s %s: %s", method, address.Redacted(), response.Status)
	}
	return fmt.Errorf("%s %s: %s: %s", method, address.Redacted(), response.Status, message)
}
