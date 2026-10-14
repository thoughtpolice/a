// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// echoServer describes each request it receives as XML, except for a few
// fixed paths that exercise response headers, binary bodies, and redirects.
func echoServer(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/binary":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Add("X-Multi", "one")
			w.Header().Add("X-Multi", "two")
			w.Write([]byte{0, 1, 2, 0xff})
			return
		case "/redirect":
			http.Redirect(w, r, "/binary", http.StatusFound)
			return
		}
		type echo struct {
			XMLName       xml.Name `xml:"Echo"`
			Method        string
			RequestURI    string
			Host          string
			Purpose       string
			Body          string
			BodySHA256    string
			ContentLength int64
		}
		e := echo{
			Method:        r.Method,
			RequestURI:    r.RequestURI,
			Host:          r.Host,
			Purpose:       r.Header.Get("X-Amz-Meta-Purpose"),
			Body:          string(body),
			ContentLength: r.ContentLength,
		}
		sum := sha256.Sum256(body)
		e.BodySHA256 = hex.EncodeToString(sum[:])
		w.Header().Set("Content-Type", "application/xml")
		w.Header().Set("ETag", `"`+e.BodySHA256[:8]+`"`)
		w.WriteHeader(http.StatusCreated)
		xml.NewEncoder(w).Encode(e)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// runScript writes text to a script file next to data.bin and runs barf on
// it with the given extra arguments, returning the exit code and output.
func runScript(t *testing.T, srv *httptest.Server, text string, args ...string) (int, string, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "data.bin"), []byte{0, 1, 2, 0xff}, 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "test.barf")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	env := []string{"BARF_VAR_endpoint=" + srv.URL, "BARF_VAR_region=us-east-1"}
	code := run(append(args, path), env, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRunPasses(t *testing.T) {
	srv := echoServer(t)
	code, stdout, stderr := runScript(t, srv, `
# Queries are percent-encoded once and appended to any query in the target.
PUT /objects/a%20b?uploads
  header X-Amz-Meta-Purpose: {purpose}
  header Host: virtual.example
  query prefix: a +/b
  body hello
expect 201
  capture etag = header ETag
  capture method = xml Method
  header Content-Type: application/xml
  header ETag: {etag}
  header ETag != "other"
  header Missing absent
  header ETag present
  xml Method = PUT
  xml RequestURI = /objects/a%20b?uploads&prefix=a%20%2B%2Fb
  xml Host = virtual.example
  xml Purpose = test
  xml /Echo/Body = hello
  xml Body != goodbye
  xml BodySHA256 nonempty
  xml ContentLength = 5
  xml Absent absent

# Captures are variables in later steps.
POST /{method}/{etag}
  body-file data.bin
expect 201
  xml RequestURI = /PUT/%222cf24dba%22
  xml BodySHA256 = 3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56

POST /signed
  sign
  body-hex 00ff
expect 201
  xml BodySHA256 = 06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8

GET /binary
expect 200
  header X-Multi: two
  body-hex 000102ff
  body-file data.bin
  body-size 4
  body-sha256 3D1F57C984978EF98A18378C8166C1CB8EDE02C03EEB6AEE7E2F121DFEEE3E56

# Redirects are responses, not instructions to follow them.
GET /redirect
expect 302
  header Location: /binary

GET `+srv.URL+`/absolute
expect 201
  xml Method = GET
  xml ContentLength = 0
`, "--var", "purpose=test", "--var", "access_key_id=AK", "--var", "secret_access_key=SK", "-v")
	if code != 0 {
		t.Fatalf("exit code %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "test.barf: 6 requests in") {
		t.Errorf("stdout lacks a summary:\n%s", stdout)
	}
	if !strings.Contains(stdout, "test.barf:39: GET "+srv.URL+"/binary -> 200 OK") {
		t.Errorf("verbose output lacks a request line:\n%s", stdout)
	}
}

func TestSignedRequestHeaders(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer srv.Close()
	code, _, stderr := runScript(t, srv, `
PUT /bucket/key
  sign secret_access_key=other region={region}
  header Content-Type: text/plain
  body payload
expect 200
`, "--var", "access_key_id=AK", "--var", "secret_access_key=SK")
	if code != 0 {
		t.Fatalf("exit code %d: %s", code, stderr)
	}
	auth := got.Get("Authorization")
	prefix := "AWS4-HMAC-SHA256 Credential=AK/"
	if !strings.HasPrefix(auth, prefix) || !strings.Contains(auth, "/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=") {
		t.Errorf("Authorization = %q", auth)
	}
	if want := fmt.Sprintf("%x", sha256.Sum256([]byte("payload"))); got.Get("X-Amz-Content-Sha256") != want {
		t.Errorf("X-Amz-Content-Sha256 = %q, want %q", got.Get("X-Amz-Content-Sha256"), want)
	}
}

func TestRunFailures(t *testing.T) {
	srv := echoServer(t)
	for _, tc := range []struct {
		name, script string
		want         []string
	}{
		{"status", "GET /x\nexpect 200\n", []string{"FAIL ", "test.barf:1: GET " + srv.URL + "/x", "test.barf:2: status is 201, want 200", "response:\n  HTTP/1.1 201 Created", "<Echo>"}},
		{"header value", "GET /binary\nexpect 200\n  header X-Multi: three\n", []string{`test.barf:3: header X-Multi: three: got "one", "two"`, "(4 bytes of binary data)"}},
		{"header not equal", "GET /binary\nexpect 200\n  header X-Multi != two\n", []string{`header X-Multi != two: got "one", "two"`}},
		{"header missing", "GET /binary\nexpect 200\n  header Nope: x\n", []string{"header Nope: x: response has no such header"}},
		{"header present", "GET /binary\nexpect 200\n  header Nope present\n", []string{"header Nope present: got no such header"}},
		{"header absent", "GET /binary\nexpect 200\n  header X-Multi absent\n", []string{"header X-Multi absent: got"}},
		{"xml value", "GET /x\nexpect 201\n  xml Method = PUT\n", []string{`xml Method = PUT: got "GET"`}},
		{"xml not equal", "GET /x\nexpect 201\n  xml Method != GET\n", []string{`xml Method != GET: got "GET"`}},
		{"xml missing", "GET /x\nexpect 201\n  xml Nope = x\n", []string{"xml Nope = x: no element matches"}},
		{"xml count", "GET /x\nexpect 201\n  xml Method count 2\n", []string{"xml Method count 2: found 1"}},
		{"xml absent", "GET /x\nexpect 201\n  xml Method absent\n", []string{"xml Method absent: found 1"}},
		{"xml empty", "GET /x\nexpect 201\n  xml Body nonempty\n", []string{`xml Body nonempty: got ""`}},
		{"not xml", "GET /binary\nexpect 200\n  xml A present\n", []string{"xml A present: response body is not XML"}},
		{"body", "GET /binary\nexpect 200\n  body abc\n", []string{"body abc: got 4 bytes of binary data"}},
		{"body hex", "GET /binary\nexpect 200\n  body-hex 0001\n", []string{"body-hex 0001: got 4 bytes, want 2; they first differ at offset 2"}},
		{"body file", "GET /x\nexpect 201\n  body-file data.bin\n", []string{"body-file data.bin: got"}},
		{"body size", "GET /binary\nexpect 200\n  body-size 3\n", []string{"body-size 3: got 4 bytes"}},
		{"body sha256", "GET /binary\nexpect 200\n  body-sha256 " + strings.Repeat("0", 64) + "\n", []string{"got 3d1f57c9"}},
		{"capture", "GET /binary\nexpect 200\n  capture x = header Nope\n", []string{"test.barf:3: capture x: response has no Nope header"}},
		{"undefined in check", "GET /x\nexpect 201\n  xml Method = {nope}\n", []string{"undefined variable {nope}"}},
		{"undefined in target", "GET /{nope}\nexpect 200\n", []string{"FAIL ", "test.barf:1: undefined variable {nope}"}},
		{"undefined in header", "GET /\n  header A: {nope}\nexpect 200\n", []string{"test.barf:2: undefined variable {nope}"}},
		{"missing file", "PUT /\n  body-file nope.bin\nexpect 200\n", []string{"test.barf:2: open "}},
		{"missing credentials", "PUT /\n  sign\nexpect 200\n", []string{"test.barf:2: sign needs the access_key_id variable"}},
		{"bad target", "GET relative\nexpect 200\n", []string{`test.barf:1: target "relative" is not an absolute http or https URL`}},
		{"connection", "GET http://127.0.0.1:1/\nexpect 200\n", []string{"test.barf:1: GET http://127.0.0.1:1/: "}},
		// A failing step stops the script and reports every failed check.
		{"stops", "GET /x\nexpect 200\n  xml Method = PUT\nGET /never\nexpect 200\n", []string{"status is 201", "xml Method = PUT"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, stdout, stderr := runScript(t, srv, tc.script)
			if code != 1 {
				t.Errorf("exit code %d, want 1", code)
			}
			if stdout != "" {
				t.Errorf("stdout = %q", stdout)
			}
			for _, want := range tc.want {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr lacks %q:\n%s", want, stderr)
				}
			}
			if strings.Contains(stderr, "/never") {
				t.Errorf("ran a step after a failure:\n%s", stderr)
			}
		})
	}
}

func TestUsageErrors(t *testing.T) {
	srv := echoServer(t)
	for _, args := range [][]string{
		{"--var", "1x=y"},
		{"--var", "novalue"},
		{"--timeout", "0s"},
		{"--bogus"},
	} {
		if code, _, _ := runScript(t, srv, "GET /\nexpect 201\n", args...); code != 2 {
			t.Errorf("run with %q exited %d, want 2", args, code)
		}
	}
	if code, _, stderr := runScript(t, srv, "GET /\n"); code != 2 || !strings.Contains(stderr, "test.barf:1: request has no 'expect STATUS' line") {
		t.Errorf("parse error exited %d: %s", code, stderr)
	}
	var stderr bytes.Buffer
	if code := run(nil, nil, io.Discard, &stderr); code != 2 || !strings.Contains(stderr.String(), "no scripts given") {
		t.Errorf("run without scripts exited %d: %s", code, stderr.String())
	}
	if code := run([]string{"/nonexistent.barf"}, nil, io.Discard, &stderr); code != 2 {
		t.Errorf("run with a missing script exited %d", code)
	}
}

func TestVariablePrecedence(t *testing.T) {
	opts, err := parseArgs(
		[]string{"--var", "a=flag", "--var", "c=x=y", "s.barf"},
		[]string{"BARF_VAR_a=env", "BARF_VAR_b=env", "BARF_VAR_=ignored", "BARF_VAR_1x=ignored", "OTHER=1"},
		io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"a": "flag", "b": "env", "c": "x=y"}
	if fmt.Sprint(opts.vars) != fmt.Sprint(want) {
		t.Errorf("vars = %v, want %v", opts.vars, want)
	}
}
