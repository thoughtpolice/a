// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Responses longer than this are truncated in failure reports.
const maxReportedBody = 4096

// newClient returns a client that never retries, follows redirects, or
// requests compression, so each step observes exactly one HTTP exchange.
func newClient(connectTimeout, timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: connectTimeout}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         dialer.DialContext,
			TLSHandshakeTimeout: connectTimeout,
			DisableCompression:  true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type runner struct {
	client   *http.Client
	vars     map[string]string
	fileRoot string
	verbose  bool
	stdout   io.Writer
	stderr   io.Writer
	now      func() time.Time
}

// stepError is a failure attributed to one script line.
type stepError struct {
	line int
	err  error
}

func (e *stepError) Error() string { return e.err.Error() }

// response holds one exchange's result; its XML is parsed on first use.
type response struct {
	*http.Response
	body   []byte
	doc    *element
	docErr error
	parsed bool
}

func (res *response) xml() (*element, error) {
	if !res.parsed {
		res.doc, res.docErr = parseXML(res.body)
		res.parsed = true
	}
	return res.doc, res.docErr
}

// run executes the steps of s in order and stops at the first failing one.
func (r *runner) run(s *script) bool {
	start := time.Now()
	for _, st := range s.steps {
		if !r.runStep(s, st) {
			return false
		}
	}
	fmt.Fprintf(r.stdout, "ok %s: %d requests in %v\n", s.path, len(s.steps), time.Since(start).Round(time.Millisecond))
	return true
}

func (r *runner) runStep(s *script, st *step) bool {
	at := func(line int) string { return fmt.Sprintf("%s:%d", s.path, line) }
	req, err := r.buildRequest(st)
	if err != nil {
		line := st.line
		if se, ok := errors.AsType[*stepError](err); ok {
			line = se.line
		}
		fmt.Fprintf(r.stderr, "FAIL %s: %v\n", at(line), err)
		return false
	}
	start := time.Now()
	resp, err := r.client.Do(req)
	if err != nil {
		fmt.Fprintf(r.stderr, "FAIL %s: %s %s: %v\n", at(st.line), st.method, req.URL, err)
		return false
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		fmt.Fprintf(r.stderr, "FAIL %s: %s %s: reading response: %v\n", at(st.line), st.method, req.URL, err)
		return false
	}
	if r.verbose {
		fmt.Fprintf(r.stdout, "%s: %s %s -> %s (%v)\n", at(st.line), st.method, req.URL, resp.Status, time.Since(start).Round(time.Millisecond))
	}

	res := &response{Response: resp, body: body}
	var failures []string
	if resp.StatusCode != st.status {
		failures = append(failures, fmt.Sprintf("%s: status is %d, want %d", at(st.expectLine), resp.StatusCode, st.status))
	}
	for _, c := range st.captures {
		value, err := r.captureValue(c, res)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: capture %s: %v", at(c.line), c.name, err))
			continue
		}
		r.vars[c.name] = value
	}
	for _, c := range st.checks {
		if msg := r.check(c, res); msg != "" {
			failures = append(failures, fmt.Sprintf("%s: %s: %s", at(c.line), c.source, msg))
		}
	}
	if len(failures) == 0 {
		return true
	}
	fmt.Fprintf(r.stderr, "FAIL %s: %s %s\n", at(st.line), st.method, req.URL)
	for _, f := range failures {
		fmt.Fprintf(r.stderr, "  %s\n", f)
	}
	reportResponse(r.stderr, res)
	return false
}

func (r *runner) buildRequest(st *step) (*http.Request, error) {
	target, err := expand(st.target, r.vars)
	if err != nil {
		return nil, &stepError{st.line, err}
	}
	if strings.HasPrefix(target, "/") {
		endpoint, ok := r.vars["endpoint"]
		if !ok {
			return nil, &stepError{st.line, fmt.Errorf("target %q is relative, but the endpoint variable is undefined", target)}
		}
		target = strings.TrimSuffix(endpoint, "/") + target
	}
	for _, q := range st.query {
		name, value, err := r.expandField(q)
		if err != nil {
			return nil, err
		}
		sep := "&"
		if !strings.Contains(target, "?") {
			sep = "?"
		}
		target += sep + uriEncode(name, true) + "=" + uriEncode(value, true)
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, &stepError{st.line, fmt.Errorf("target %q is not an absolute http or https URL", target)}
	}

	var body []byte
	if st.body != nil {
		if body, err = r.payloadBytes(st.body); err != nil {
			return nil, &stepError{st.body.line, err}
		}
	}
	req, err := http.NewRequest(st.method, target, bytes.NewReader(body))
	if err != nil {
		return nil, &stepError{st.line, err}
	}
	for _, h := range st.headers {
		name, value, err := r.expandField(h)
		if err != nil {
			return nil, err
		}
		if strings.EqualFold(name, "Host") {
			req.Host = value
		} else {
			req.Header.Add(name, value)
		}
	}
	if st.sign != nil {
		c, err := r.credentials(st.sign)
		if err != nil {
			return nil, &stepError{st.sign.line, err}
		}
		signV4(req, body, c, r.now())
	}
	return req, nil
}

func (r *runner) expandField(f field) (string, string, error) {
	name, err := expand(f.name, r.vars)
	if err == nil {
		var value string
		if value, err = expand(f.value, r.vars); err == nil {
			return name, value, nil
		}
	}
	return "", "", &stepError{f.line, err}
}

func (r *runner) credentials(s *signing) (credentials, error) {
	get := func(name string) (string, error) {
		if v, ok := s.overrides[name]; ok {
			return expand(v, r.vars)
		}
		if v, ok := r.vars[name]; ok {
			return v, nil
		}
		return "", fmt.Errorf("sign needs the %s variable", name)
	}
	var c credentials
	var err error
	if c.accessKeyID, err = get("access_key_id"); err != nil {
		return c, err
	}
	if c.secretAccessKey, err = get("secret_access_key"); err != nil {
		return c, err
	}
	c.region, err = get("region")
	return c, err
}

// payloadBytes returns the bytes a body, body-file, or body-hex line names.
// Hex digits are literal; text and file paths may refer to variables.
func (r *runner) payloadBytes(p *payload) ([]byte, error) {
	if p.kind == "body-hex" {
		return hex.DecodeString(p.value)
	}
	value, err := expand(p.value, r.vars)
	if err != nil {
		return nil, err
	}
	if p.kind == "body" {
		return []byte(value), nil
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(r.fileRoot, value)
	}
	return os.ReadFile(value)
}

func (r *runner) captureValue(c capture, res *response) (string, error) {
	if c.subject == "header" {
		values := res.Header.Values(c.arg)
		if len(values) == 0 {
			return "", fmt.Errorf("response has no %s header", c.arg)
		}
		return values[0], nil
	}
	elems, err := selectElements(c.arg, res)
	if err != nil {
		return "", err
	}
	if len(elems) == 0 {
		return "", fmt.Errorf("no element matches %s", c.arg)
	}
	return elems[0].text, nil
}

func selectElements(path string, res *response) ([]*element, error) {
	p, err := parsePath(path)
	if err != nil {
		return nil, err
	}
	doc, err := res.xml()
	if err != nil {
		return nil, err
	}
	return p.selectFrom(doc), nil
}

// check returns why c fails for res, or "" when it passes.
func (r *runner) check(c check, res *response) string {
	want := c.value
	if c.subject != "body-hex" && c.subject != "body-sha256" && c.subject != "body-file" {
		var err error
		if want, err = expand(c.value, r.vars); err != nil {
			return err.Error()
		}
	}
	switch c.subject {
	case "header":
		values := res.Header.Values(c.arg)
		switch {
		case c.op == "present" || c.op == "absent":
			if (len(values) > 0) != (c.op == "present") {
				return "got " + describeValues(values)
			}
		case len(values) == 0:
			return "response has no such header"
		case (c.op == "=") != slices.Contains(values, want):
			return "got " + describeValues(values)
		}
	case "xml":
		elems, err := selectElements(c.arg, res)
		if err != nil {
			return err.Error()
		}
		switch c.op {
		case "count":
			if n, _ := strconv.Atoi(want); len(elems) != n {
				return fmt.Sprintf("found %d", len(elems))
			}
		case "present", "absent":
			if (len(elems) > 0) != (c.op == "present") {
				return fmt.Sprintf("found %d", len(elems))
			}
		default:
			if len(elems) == 0 {
				return "no element matches"
			}
			got := elems[0].text
			if (c.op == "=" && got != want) || (c.op == "!=" && got == want) || (c.op == "nonempty" && got == "") {
				return fmt.Sprintf("got %q", got)
			}
		}
	case "body":
		if string(res.body) != want {
			return "got " + describeBody(res.body, 200)
		}
	case "body-size":
		if n, _ := strconv.Atoi(want); len(res.body) != n {
			return fmt.Sprintf("got %d bytes", len(res.body))
		}
	case "body-sha256":
		if got := sha256Hex(res.body); got != strings.ToLower(want) {
			return "got " + got
		}
	case "body-file", "body-hex":
		// payloadBytes expands the variables itself.
		expected, err := r.payloadBytes(&payload{c.line, c.subject, c.value})
		if err != nil {
			return err.Error()
		}
		if !bytes.Equal(res.body, expected) {
			return describeMismatch(res.body, expected)
		}
	}
	return ""
}

func describeValues(values []string) string {
	if len(values) == 0 {
		return "no such header"
	}
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = strconv.Quote(v)
	}
	return strings.Join(quoted, ", ")
}

func describeMismatch(got, want []byte) string {
	i := 0
	for i < len(got) && i < len(want) && got[i] == want[i] {
		i++
	}
	return fmt.Sprintf("got %d bytes, want %d; they first differ at offset %d", len(got), len(want), i)
}

// describeBody quotes printable bodies up to limit bytes and summarizes
// binary ones.
func describeBody(body []byte, limit int) string {
	if !printable(body) {
		return fmt.Sprintf("%d bytes of binary data", len(body))
	}
	if len(body) > limit {
		return fmt.Sprintf("%q... (%d bytes)", body[:limit], len(body))
	}
	return strconv.Quote(string(body))
}

func printable(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, r := range string(b) {
		if r < ' ' && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}

func reportResponse(w io.Writer, res *response) {
	fmt.Fprintf(w, "response:\n  %s %s\n", res.Proto, res.Status)
	names := make([]string, 0, len(res.Header))
	for name := range res.Header {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		for _, v := range res.Header[name] {
			fmt.Fprintf(w, "  %s: %s\n", name, v)
		}
	}
	switch {
	case len(res.body) == 0:
	case !printable(res.body):
		fmt.Fprintf(w, "\n  (%d bytes of binary data)\n", len(res.body))
	default:
		text := string(res.body)
		if len(text) > maxReportedBody {
			text = fmt.Sprintf("%s\n... (%d more bytes)", text[:maxReportedBody], len(text)-maxReportedBody)
		}
		fmt.Fprintf(w, "\n%s\n", text)
	}
}
