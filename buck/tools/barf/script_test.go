// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseScript(t *testing.T) {
	s, err := parseScript("t.barf", `
# A comment.
PUT /{bucket}/key
  header If-None-Match: *
  query prefix: a b
  sign region=eu-west-1
  body hello {name}
expect 200
  capture etag = header ETag
  header Content-Type: text/plain; charset=utf-8
  header ETag != "stale"
  header Expires absent
  xml Bucket[2]/Name = page-b
  xml Contents count 3
  xml UploadId nonempty
  body-sha256 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  body-size 5

HEAD http://example.com/
expect 404
`)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.steps) != 2 {
		t.Fatalf("got %d steps", len(s.steps))
	}
	st := s.steps[0]
	if st.method != "PUT" || st.target != "/{bucket}/key" || st.status != 200 || st.expectLine != 8 {
		t.Errorf("step = %+v", st)
	}
	if want := []field{{4, "If-None-Match", "*"}}; !reflect.DeepEqual(st.headers, want) {
		t.Errorf("headers = %v", st.headers)
	}
	if want := []field{{5, "prefix", "a b"}}; !reflect.DeepEqual(st.query, want) {
		t.Errorf("query = %v", st.query)
	}
	if !reflect.DeepEqual(st.sign.overrides, map[string]string{"region": "eu-west-1"}) {
		t.Errorf("sign = %+v", st.sign)
	}
	if *st.body != (payload{7, "body", "hello {name}"}) {
		t.Errorf("body = %+v", st.body)
	}
	if want := []capture{{9, "etag", "header", "ETag"}}; !reflect.DeepEqual(st.captures, want) {
		t.Errorf("captures = %v", st.captures)
	}
	type summary struct{ subject, arg, op, value string }
	var got []summary
	for _, c := range st.checks {
		got = append(got, summary{c.subject, c.arg, c.op, c.value})
	}
	want := []summary{
		{"header", "Content-Type", "=", "text/plain; charset=utf-8"},
		{"header", "ETag", "!=", `"stale"`},
		{"header", "Expires", "absent", ""},
		{"xml", "Bucket[2]/Name", "=", "page-b"},
		{"xml", "Contents", "count", "3"},
		{"xml", "UploadId", "nonempty", ""},
		{"body-sha256", "", "=", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},
		{"body-size", "", "=", "5"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("checks =\n%v\nwant\n%v", got, want)
	}
}

func TestParseErrors(t *testing.T) {
	for _, tc := range []struct{ text, want string }{
		{"", "t.barf:1: script has no requests"},
		{"header A: b\n", "t.barf:1: expected a request line"},
		{"GET /\nGET /\nexpect 200\n", "t.barf:1: request has no 'expect STATUS' line"},
		{"GET /\n", "t.barf:1: request has no 'expect STATUS' line"},
		{"GET / extra\nexpect 200\n", "t.barf:1: want 'METHOD TARGET'"},
		{"GET /\nexpect 200\nexpect 200\n", "t.barf:3: request on line 1 already has an expect line"},
		{"GET /\nexpect 2000\n", "t.barf:2: want 'expect STATUS'"},
		{"GET /\n  cookie a: b\nexpect 200\n", `t.barf:2: unknown request directive "cookie"`},
		{"GET /\n  header nocolon\nexpect 200\n", "t.barf:2: want 'header NAME: VALUE'"},
		{"GET /\n  body a\n  body-file b\nexpect 200\n", "t.barf:3: request already has a body on line 2"},
		{"GET /\n  body-hex 0g\nexpect 200\n", "t.barf:2: body-hex: encoding/hex"},
		{"GET /\n  sign user=x\nexpect 200\n", "t.barf:2: want 'sign [NAME=VALUE...]'"},
		{"GET /\nexpect 200\n  header A maybe\n", "t.barf:3: want 'header NAME: VALUE'"},
		{"GET /\nexpect 200\n  xml A[0] present\n", `t.barf:3: bad element path "A[0]"`},
		{"GET /\nexpect 200\n  xml A count x\n", "t.barf:3: want 'xml PATH count N'"},
		{"GET /\nexpect 200\n  xml A present x\n", "t.barf:3: 'xml PATH present' takes no value"},
		{"GET /\nexpect 200\n  xml A like x\n", "t.barf:3: want 'xml PATH' followed by"},
		{"GET /\nexpect 200\n  capture x = status\n", "t.barf:3: want 'capture NAME = header HEADER'"},
		{"GET /\nexpect 200\n  body-sha256 00\n", "t.barf:3: body-sha256 needs 64 hex digits"},
		{"GET /\nexpect 200\n  jsonpath $.a\n", `t.barf:3: unknown check "jsonpath"`},
	} {
		_, err := parseScript("t.barf", tc.text)
		if err == nil || !strings.HasPrefix(err.Error(), tc.want) {
			t.Errorf("parseScript(%q) error = %v, want prefix %q", tc.text, err, tc.want)
		}
	}
}

func TestExpand(t *testing.T) {
	vars := map[string]string{"a": "1", "b_2": "{a}"}
	for in, want := range map[string]string{
		"":             "",
		"{a}/{b_2}":    "1/{a}",
		"{ a }{}{":     "{ a }{}{",
		"x{a}y{a}":     "x1y1",
		"{\"k\": {a}}": "{\"k\": 1}",
	} {
		if got, err := expand(in, vars); err != nil || got != want {
			t.Errorf("expand(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := expand("{missing}", vars); err == nil || err.Error() != "undefined variable {missing}" {
		t.Errorf("expand of undefined variable: %v", err)
	}
}
