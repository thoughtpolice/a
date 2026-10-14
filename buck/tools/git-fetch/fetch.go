// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// attempts is how many times a fetch is tried when it fails in a way that
// might not happen again.
const attempts = 5

var (
	// retryDelay is the wait before the second attempt. It doubles after
	// each further failure.
	retryDelay = time.Second
	// idleTimeout abandons a request when the server sends nothing for
	// this long. Servers send keep-alive packets while they build a pack.
	idleTimeout = 2 * time.Minute
)

const agent = "depot-git-fetch/" + version

// fetchError marks an error as worth another attempt: the network failed,
// or the server said it was overloaded.
type fetchError struct{ err error }

func (e *fetchError) Error() string { return e.err.Error() }
func (e *fetchError) Unwrap() error { return e.err }

func retryable(err error) error { return &fetchError{err} }

func isRetryable(err error) bool {
	var fe *fetchError
	return errors.As(err, &fe)
}

type fetchResult struct {
	pack    *pack
	shallow []oid // commits whose parents the pack leaves out
}

// fetch asks the server for one object, at depth 1, over git's protocol
// version 2 on smart HTTP: one GET for the server's capabilities, and one
// POST for the pack, which it reads as it arrives.
func fetch(ctx context.Context, rawURL string, format *objectFormat, want oid, log io.Writer) (*fetchResult, error) {
	r, err := newRemote(rawURL, format)
	if err != nil {
		return nil, err
	}
	delay := retryDelay
	for attempt := 1; ; attempt++ {
		res, err := r.fetchOnce(ctx, want)
		if err == nil || !isRetryable(err) || attempt == attempts {
			return res, err
		}
		fmt.Fprintf(log, "git-fetch: attempt %d of %d failed, retrying in %v: %v\n", attempt, attempts, delay, err)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		delay *= 2
	}
}

type remote struct {
	url    url.URL // the repository, without a trailing slash
	format *objectFormat
	client *http.Client
}

func newRemote(rawURL string, format *objectFormat) (*remote, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		// The error repeats the URL, which may carry credentials.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return nil, fmt.Errorf("the repository URL is not an http or https URL: %v", err)
	}
	switch {
	case u.Scheme != "http" && u.Scheme != "https":
		return nil, fmt.Errorf("%s is not an http or https URL", displayURL(rawURL))
	case u.User != nil:
		return nil, fmt.Errorf("%s carries credentials; git-fetch fetches only public repositories", displayURL(rawURL))
	case u.Host == "":
		return nil, fmt.Errorf("%s names no host", rawURL)
	case u.RawQuery != "" || u.ForceQuery || u.Fragment != "":
		return nil, fmt.Errorf("%s has a query or fragment", rawURL)
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	u.RawPath = strings.TrimSuffix(u.RawPath, "/")
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &remote{
		url:    *u,
		format: format,
		client: &http.Client{Transport: transport, CheckRedirect: checkRedirect},
	}, nil
}

// displayURL renders a URL for messages without any credentials in it.
func displayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "the repository URL"
	}
	u.User = nil
	return u.String()
}

// checkRedirect follows redirects only for the first request, as git does
// by default (http.followRedirects=initial). A redirect there moves the
// repository, and the next request goes to where it moved.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if via[0].Method != http.MethodGet {
		return http.ErrUseLastResponse
	}
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	return nil
}

func (r *remote) fetchOnce(ctx context.Context, want oid) (*fetchResult, error) {
	caps, err := r.discover(ctx)
	if err != nil {
		return nil, err
	}
	body, err := r.fetchRequest(caps, want)
	if err != nil {
		return nil, err
	}
	var res *fetchResult
	u := r.endpoint("/git-upload-pack", "")
	err = r.request(ctx, http.MethodPost, u, body, "application/x-git-upload-pack-result",
		func(_ *http.Response, body io.Reader) error {
			var err error
			res, err = r.readFetchResponse(&pktReader{r: body})
			return err
		})
	return res, err
}

// discover asks for the server's capabilities, which says whether it
// speaks protocol version 2, and where the repository is after redirects.
func (r *remote) discover(ctx context.Context) (map[string]string, error) {
	u := r.endpoint("/info/refs", "service=git-upload-pack")
	var caps map[string]string
	err := r.request(ctx, http.MethodGet, u, nil, "application/x-git-upload-pack-advertisement",
		func(resp *http.Response, body io.Reader) error {
			if err := r.followRedirect(resp.Request.URL, u); err != nil {
				return err
			}
			var err error
			caps, err = readCapabilities(&pktReader{r: body})
			return err
		})
	return caps, err
}

func (r *remote) endpoint(suffix, query string) url.URL {
	u := r.url
	u.Path += suffix
	if u.RawPath != "" {
		u.RawPath += suffix
	}
	u.RawQuery = query
	return u
}

// followRedirect moves the remote to where the discovery request ended up.
// Like git, it accepts only a redirect that kept the request's path suffix
// and query, so that what precedes them names the repository.
func (r *remote) followRedirect(final *url.URL, asked url.URL) error {
	if final.String() == asked.String() {
		return nil
	}
	path, ok := strings.CutSuffix(final.Path, "/info/refs")
	if !ok || final.RawQuery != "service=git-upload-pack" {
		return fmt.Errorf("the server redirected to %s, which does not look like a repository", final.Redacted())
	}
	moved := *final
	moved.Path = path
	moved.RawPath = ""
	moved.RawQuery = ""
	r.url = moved
	return nil
}

// request sends one request and hands the body of a 200 response, of the
// expected type, to read. It abandons the request when the server sends
// nothing for idleTimeout.
func (r *remote) request(ctx context.Context, method string, u url.URL, body []byte, wantType string, read func(*http.Response, io.Reader) error) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	errIdle := retryable(fmt.Errorf("the server sent nothing for %v", idleTimeout))
	timer := time.AfterFunc(idleTimeout, func() { cancel(errIdle) })
	defer timer.Stop()

	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "git/2.0 ("+agent+")")
	req.Header.Set("Git-Protocol", "version=2")
	req.Header.Set("Accept", wantType)
	if body != nil {
		req.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	}
	resp, err := r.client.Do(req)
	if err != nil {
		if context.Cause(ctx) == errIdle {
			return errIdle
		}
		return transportError(err)
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return err
	}
	if got, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type")); got != wantType {
		return fmt.Errorf("%s answered with Content-Type %q, not %q: is it a git server?",
			u.Redacted(), resp.Header.Get("Content-Type"), wantType)
	}
	err = read(resp, &idleReader{resp.Body, timer})
	if err != nil && context.Cause(ctx) == errIdle {
		return errIdle
	}
	return err
}

type idleReader struct {
	r     io.Reader
	timer *time.Timer
}

func (r *idleReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.timer.Reset(idleTimeout)
	return n, err
}

func checkStatus(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusUnauthorized:
		return errors.New("the server asked for credentials (HTTP 401), which git-fetch never sends: " +
			"is the repository public, and does it exist?")
	case http.StatusNotFound:
		return errors.New("the server has no repository there (HTTP 404)")
	case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError,
		http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return retryable(fmt.Errorf("HTTP %s", resp.Status))
	}
	return fmt.Errorf("HTTP %s", resp.Status)
}

// transportError marks a failed request retryable unless retrying cannot
// help: the certificate is bad, or the host does not exist.
func transportError(err error) error {
	var certErr *tls.CertificateVerificationError
	var dnsErr *net.DNSError
	if errors.As(err, &certErr) || (errors.As(err, &dnsErr) && dnsErr.IsNotFound) {
		return err
	}
	return retryable(err)
}

func readCapabilities(pr *pktReader) (map[string]string, error) {
	kind, line, err := pr.line()
	if err != nil {
		return nil, err
	}
	// Smart HTTP servers start with a packet naming the service, then a
	// flush, ahead of the protocol's own capability advertisement.
	if kind == pktData && strings.HasPrefix(line, "# service=") {
		if kind, _, err = pr.next(); err != nil {
			return nil, err
		}
		if kind != pktFlush {
			return nil, errors.New("malformed service announcement")
		}
		if kind, line, err = pr.line(); err != nil {
			return nil, err
		}
	}
	if kind != pktData || line != "version 2" {
		return nil, errors.New("the server does not speak git protocol version 2")
	}
	caps := map[string]string{}
	for {
		kind, line, err := pr.line()
		if err != nil {
			return nil, err
		}
		if kind == pktFlush {
			return caps, nil
		}
		if kind != pktData {
			return nil, errors.New("malformed capability advertisement")
		}
		key, value, _ := strings.Cut(line, "=")
		caps[key] = value
	}
}

// fetchRequest asks for want and nothing that leads to it: at depth 1 that
// is the commit, its tree, and their contents. It sends "done" at once, as
// there is nothing to negotiate with an empty repository.
func (r *remote) fetchRequest(caps map[string]string, want oid) ([]byte, error) {
	fetchCap, ok := caps["fetch"]
	if !ok {
		return nil, errors.New("the server does not offer git's fetch command")
	}
	if !slices.Contains(strings.Fields(fetchCap), "shallow") {
		return nil, errors.New("the server does not support shallow fetches")
	}
	serverFormat, advertised := caps["object-format"]
	if !advertised {
		serverFormat = "sha1"
	}
	if serverFormat != r.format.name {
		return nil, fmt.Errorf("the repository uses %s object ids, not %s", serverFormat, r.format.name)
	}
	var b bytes.Buffer
	writePktLine(&b, "command=fetch\n")
	if _, ok := caps["agent"]; ok {
		writePktLine(&b, "agent="+agent+"\n")
	}
	if advertised {
		writePktLine(&b, "object-format="+r.format.name+"\n")
	}
	b.WriteString("0001")
	writePktLine(&b, "want "+r.format.hex(want)+"\n")
	writePktLine(&b, "deepen 1\n")
	writePktLine(&b, "ofs-delta\n")
	writePktLine(&b, "no-progress\n")
	writePktLine(&b, "done\n")
	b.WriteString("0000")
	return b.Bytes(), nil
}

// readFetchResponse reads the sections of a fetch response. All but the
// last end with a delimiter packet; the last is the pack.
func (r *remote) readFetchResponse(pr *pktReader) (*fetchResult, error) {
	res := &fetchResult{}
	for {
		kind, section, err := pr.line()
		if err != nil {
			return nil, err
		}
		if kind != pktData {
			return nil, errors.New("the server sent no pack")
		}
		switch section {
		case "packfile":
			band := &sidebandReader{pr: pr}
			res.pack, err = readPack(r.format, band)
			if band.err != nil {
				// The connection failed or the server gave up, which is
				// not the pack's fault.
				return nil, band.err
			}
			if err != nil {
				return nil, fmt.Errorf("the server sent an invalid pack: %w", err)
			}
			return res, nil
		case "acknowledgments", "shallow-info", "wanted-refs", "packfile-uris":
		default:
			return nil, fmt.Errorf("unexpected section %q in the server's response", section)
		}
		for {
			kind, line, err := pr.line()
			if err != nil {
				return nil, err
			}
			if kind == pktDelim {
				break
			}
			if kind != pktData {
				return nil, errors.New("the server sent no pack")
			}
			if hexID, ok := strings.CutPrefix(line, "shallow "); ok && section == "shallow-info" {
				id, ok := r.format.parseHex(hexID)
				if !ok {
					return nil, fmt.Errorf("malformed shallow line %q", line)
				}
				res.shallow = append(res.shallow, id)
			}
		}
	}
}

// sidebandReader reads the pack from band 1 of the side band, up to the
// flush packet that ends it. Band 2 carries progress messages, and band 3
// a fatal error. err records any failure other than the pack's end.
type sidebandReader struct {
	pr      *pktReader
	pending []byte
	done    bool
	err     error
}

func (s *sidebandReader) Read(b []byte) (int, error) {
	for len(s.pending) == 0 {
		if s.err != nil {
			return 0, s.err
		}
		if s.done {
			return 0, io.EOF
		}
		kind, data, err := s.pr.next()
		switch {
		case err != nil:
			s.err = err
		case kind == pktFlush:
			s.done = true
		case kind != pktData || len(data) == 0:
			s.err = errors.New("malformed packet in the pack's side band")
		case data[0] == 1:
			s.pending = data[1:]
		case data[0] == 2:
		case data[0] == 3:
			s.err = fmt.Errorf("the server said: %s", bytes.TrimSpace(data[1:]))
		default:
			s.err = fmt.Errorf("unknown side band %d", data[0])
		}
	}
	n := copy(b, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}
