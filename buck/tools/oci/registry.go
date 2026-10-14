// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// httpClient is replaced by tests, which serve a registry over TLS with
// their own certificate.
var httpClient = &http.Client{Timeout: 30 * time.Minute}

// retryDelay is the first pause between attempts; it doubles each time.
var retryDelay = time.Second

var manifestAccept = strings.Join([]string{
	mediaTypeIndex,
	mediaTypeManifest,
	mediaTypeDockerList,
	mediaTypeDockerManifest,
}, ", ")

// registry talks to one repository with the distribution API, as described
// in the OCI distribution specification.
type registry struct {
	ref     reference
	creds   credentials
	scope   string
	retries int
	log     io.Writer

	token *oauth2.Token
	basic bool
}

func newRegistry(ctx context.Context, ref reference, authfile string, push bool, retries int, log io.Writer) (*registry, error) {
	creds, err := lookupCredentials(ctx, ref, authfile)
	if err != nil {
		return nil, fmt.Errorf("reading credentials for %s: %w", ref.domain, err)
	}
	scope := "repository:" + ref.repository + ":pull"
	if push {
		scope += ",push"
	}
	return &registry{ref: ref, creds: creds, scope: scope, retries: retries, log: log}, nil
}

func (r *registry) url(path string) string {
	return "https://" + r.ref.apiHost() + "/v2/" + r.ref.repository + path
}

// statusError is a registry response with an unexpected status.
type statusError struct {
	method, url string
	status      int
	body        string
}

func (e *statusError) Error() string {
	msg := fmt.Sprintf("%s %s: %s", e.method, e.url, http.StatusText(e.status))
	if e.body != "" {
		msg += ": " + e.body
	}
	return msg
}

func retryable(err error) bool {
	var se *statusError
	if errors.As(err, &se) {
		return se.status == http.StatusTooManyRequests || se.status >= 500
	}
	return !errors.Is(err, context.Canceled) && !errors.Is(err, errDigestMismatch)
}

// request describes one API call. body returns a fresh reader for each
// attempt, so a retried upload starts over.
type request struct {
	method  string
	url     string
	header  http.Header
	body    func() (io.ReadCloser, int64, error)
	accept  []int
	handled func(*http.Response) error
}

// do sends req, authenticating when the registry asks, retrying transient
// failures, and hands a response with an accepted status to handled.
func (r *registry) do(ctx context.Context, req request) error {
	delay := retryDelay
	var err error
	for attempt := 0; ; attempt++ {
		err = r.attempt(ctx, req)
		if err == nil || attempt >= r.retries || !retryable(err) {
			return err
		}
		fmt.Fprintf(r.log, "oci: %v; retrying in %v\n", err, delay)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
	}
}

func (r *registry) attempt(ctx context.Context, req request) error {
	for authenticated := false; ; authenticated = true {
		resp, err := r.send(ctx, req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusUnauthorized && !authenticated {
			challenge := resp.Header.Get("WWW-Authenticate")
			drain(resp)
			if err := r.authenticate(ctx, challenge); err != nil {
				return err
			}
			continue
		}
		defer drain(resp)
		for _, status := range req.accept {
			if resp.StatusCode == status {
				if req.handled == nil {
					return nil
				}
				return req.handled(resp)
			}
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &statusError{req.method, req.url, resp.StatusCode, strings.TrimSpace(string(body))}
	}
}

func (r *registry) send(ctx context.Context, req request) (*http.Response, error) {
	var body io.ReadCloser
	var length int64
	if req.body != nil {
		var err error
		if body, length, err = req.body(); err != nil {
			return nil, err
		}
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.method, req.url, body)
	if err != nil {
		if body != nil {
			body.Close()
		}
		return nil, err
	}
	if body != nil {
		httpReq.ContentLength = length
	}
	for key, values := range req.header {
		httpReq.Header[key] = values
	}
	switch {
	case r.token != nil && r.token.Valid():
		r.token.SetAuthHeader(httpReq)
	case r.basic:
		httpReq.SetBasicAuth(r.creds.username, r.creds.password)
	}
	return httpClient.Do(httpReq)
}

func drain(resp *http.Response) {
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
}

// parseChallenge splits a WWW-Authenticate header into its scheme and
// parameters, such as Bearer realm="...",service="...".
func parseChallenge(header string) (string, map[string]string) {
	scheme, rest, _ := strings.Cut(strings.TrimSpace(header), " ")
	params := map[string]string{}
	for rest = strings.TrimSpace(rest); rest != ""; {
		key, after, ok := strings.Cut(rest, "=")
		if !ok {
			break
		}
		key = strings.ToLower(strings.TrimSpace(key))
		var value string
		if strings.HasPrefix(after, `"`) {
			end := strings.Index(after[1:], `"`)
			if end < 0 {
				break
			}
			value, rest = after[1:1+end], after[2+end:]
		} else {
			value, rest, _ = strings.Cut(after, ",")
		}
		params[key] = value
		rest = strings.TrimLeft(strings.TrimSpace(rest), ",")
		rest = strings.TrimSpace(rest)
	}
	return strings.ToLower(scheme), params
}

// authenticate answers a 401 challenge: with a token from the registry's
// token service for Bearer, or with the credentials for Basic.
func (r *registry) authenticate(ctx context.Context, challenge string) error {
	scheme, params := parseChallenge(challenge)
	switch scheme {
	case "basic":
		if r.creds.username == "" {
			return fmt.Errorf("%s needs credentials, and none are configured for it", r.ref.domain)
		}
		r.basic = true
		return nil
	case "bearer":
	default:
		return fmt.Errorf("%s: unsupported authentication challenge %q", r.ref.domain, challenge)
	}
	realm := params["realm"]
	if realm == "" {
		return fmt.Errorf("%s: bearer challenge has no realm", r.ref.domain)
	}
	tokenURL, err := url.Parse(realm)
	if err != nil {
		return fmt.Errorf("%s: bearer realm: %w", r.ref.domain, err)
	}
	q := tokenURL.Query()
	if service := params["service"]; service != "" {
		q.Set("service", service)
	}
	q.Set("scope", r.scope)
	tokenURL.RawQuery = q.Encode()

	ctx = context.WithValue(ctx, oauth2.HTTPClient, httpClient)
	if r.creds.identityToken != "" {
		// An identity token is an OAuth2 refresh token for the same
		// service, exchanged at the realm for an access token.
		config := oauth2.Config{
			ClientID: "buck2-oci",
			Endpoint: oauth2.Endpoint{TokenURL: tokenURL.String(), AuthStyle: oauth2.AuthStyleInParams},
		}
		token, err := config.TokenSource(ctx, &oauth2.Token{RefreshToken: r.creds.identityToken}).Token()
		if err != nil {
			return fmt.Errorf("%s: exchanging the identity token: %w", r.ref.domain, err)
		}
		r.token = token
		return nil
	}
	token, err := r.fetchToken(ctx, tokenURL.String())
	if err != nil {
		return fmt.Errorf("%s: getting a token: %w", r.ref.domain, err)
	}
	r.token = token
	return nil
}

// fetchToken asks a token service for a bearer token, with the credentials
// if there are any. Token services answer anonymous requests for public
// repositories too.
func (r *registry) fetchToken(ctx context.Context, tokenURL string) (*oauth2.Token, error) {
	delay := retryDelay
	for attempt := 0; ; attempt++ {
		token, err := r.tryFetchToken(ctx, tokenURL)
		if err == nil || attempt >= r.retries || !retryable(err) {
			return token, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
	}
}

func (r *registry) tryFetchToken(ctx context.Context, tokenURL string) (*oauth2.Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return nil, err
	}
	if r.creds.username != "" {
		req.SetBasicAuth(r.creds.username, r.creds.password)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, &statusError{http.MethodGet, tokenURL, resp.StatusCode, strings.TrimSpace(string(body))}
	}
	var reply struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&reply); err != nil {
		return nil, fmt.Errorf("token reply: %w", err)
	}
	token := &oauth2.Token{AccessToken: reply.Token, TokenType: "Bearer"}
	if token.AccessToken == "" {
		token.AccessToken = reply.AccessToken
	}
	if token.AccessToken == "" {
		return nil, errors.New("token reply has no token")
	}
	// The token specification's default lifetime is 60 seconds.
	if reply.ExpiresIn <= 0 {
		reply.ExpiresIn = 60
	}
	token.Expiry = time.Now().Add(time.Duration(reply.ExpiresIn) * time.Second)
	return token, nil
}

// getManifest fetches the manifest or index tagged or digested ref, and
// checks the digest when ref names one.
func (r *registry) getManifest(ctx context.Context, ref string) ([]byte, string, error) {
	var data []byte
	var mediaType string
	err := r.do(ctx, request{
		method: http.MethodGet,
		url:    r.url("/manifests/" + ref),
		header: http.Header{"Accept": {manifestAccept}},
		accept: []int{http.StatusOK},
		handled: func(resp *http.Response) error {
			var err error
			data, err = io.ReadAll(io.LimitReader(resp.Body, 16<<20))
			mediaType, _, _ = strings.Cut(resp.Header.Get("Content-Type"), ";")
			return err
		},
	})
	if err != nil {
		return nil, "", err
	}
	if strings.HasPrefix(ref, "sha256:") {
		if got := sha256Digest(data); got != ref {
			return nil, "", fmt.Errorf("%w: manifest %s has digest %s", errDigestMismatch, ref, got)
		}
	}
	var probe struct {
		MediaType string `json:"mediaType"`
	}
	if json.Unmarshal(data, &probe) == nil && probe.MediaType != "" {
		mediaType = probe.MediaType
	}
	return data, mediaType, nil
}

var errDigestMismatch = errors.New("digest mismatch")

// fetchBlob downloads a blob into the layout, checking its digest and size
// as it streams.
func (r *registry) fetchBlob(ctx context.Context, out Layout, desc Descriptor) error {
	dest, err := out.blobPath(desc.Digest)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dest); err == nil {
		return nil
	}
	return r.do(ctx, request{
		method: http.MethodGet,
		url:    r.url("/blobs/" + desc.Digest),
		accept: []int{http.StatusOK},
		handled: func(resp *http.Response) error {
			tmp, err := os.CreateTemp(filepath.Dir(dest), ".download-")
			if err != nil {
				return err
			}
			defer os.Remove(tmp.Name())
			h := sha256.New()
			n, err := io.Copy(io.MultiWriter(tmp, h), resp.Body)
			if cerr := tmp.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
			if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != desc.Digest {
				return fmt.Errorf("%w: blob %s downloaded as %s", errDigestMismatch, desc.Digest, got)
			}
			if desc.Size > 0 && n != desc.Size {
				return fmt.Errorf("%w: blob %s is %d bytes, not %d", errDigestMismatch, desc.Digest, n, desc.Size)
			}
			return os.Rename(tmp.Name(), dest)
		},
	})
}

// blobExists reports whether the repository already has a blob.
func (r *registry) blobExists(ctx context.Context, digest string) (bool, error) {
	found := false
	err := r.do(ctx, request{
		method: http.MethodHead,
		url:    r.url("/blobs/" + digest),
		accept: []int{http.StatusOK, http.StatusNotFound},
		handled: func(resp *http.Response) error {
			found = resp.StatusCode == http.StatusOK
			return nil
		},
	})
	return found, err
}

// uploadBlob pushes a blob with a monolithic upload: a POST opens the
// upload session and one PUT carries the content and its digest.
func (r *registry) uploadBlob(ctx context.Context, digest string, size int64, open func() (io.ReadCloser, error)) error {
	return r.do(ctx, request{
		method: http.MethodPost,
		url:    r.url("/blobs/uploads/"),
		accept: []int{http.StatusAccepted},
		handled: func(resp *http.Response) error {
			location, err := resp.Request.URL.Parse(resp.Header.Get("Location"))
			if err != nil || resp.Header.Get("Location") == "" {
				return fmt.Errorf("upload of %s: the registry gave no upload location", digest)
			}
			q := location.Query()
			q.Set("digest", digest)
			location.RawQuery = q.Encode()
			// A retry starts a new session, so this PUT is not retried itself.
			put := *r
			put.retries = 0
			return put.do(ctx, request{
				method: http.MethodPut,
				url:    location.String(),
				header: http.Header{"Content-Type": {"application/octet-stream"}},
				body: func() (io.ReadCloser, int64, error) {
					rc, err := open()
					return rc, size, err
				},
				accept: []int{http.StatusCreated},
			})
		},
	})
}

// putManifest uploads a manifest or index under a tag or its digest.
func (r *registry) putManifest(ctx context.Context, ref, mediaType string, data []byte) error {
	return r.do(ctx, request{
		method: http.MethodPut,
		url:    r.url("/manifests/" + ref),
		header: http.Header{"Content-Type": {mediaType}},
		body: func() (io.ReadCloser, int64, error) {
			return io.NopCloser(bytes.NewReader(data)), int64(len(data)), nil
		},
		accept: []int{http.StatusCreated, http.StatusOK},
	})
}
