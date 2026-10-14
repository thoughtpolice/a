// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"testing"
)

const listing = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Buckets>
    <Bucket><Name>page-a</Name></Bucket>
    <Bucket><Name>page-b</Name></Bucket>
  </Buckets>
  <Prefix>top</Prefix>
  <Nested><Prefix>inner</Prefix></Nested>
  <Mixed>a<b>b</b>c</Mixed>
  <Key>a&amp;&lt;</Key>
</ListAllMyBucketsResult>`

func TestSelectElements(t *testing.T) {
	root, err := parseXML([]byte(listing))
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string][]string{
		"Name":                           {"page-a", "page-b"},
		"Bucket/Name":                    {"page-a", "page-b"},
		"Bucket[2]/Name":                 {"page-b"},
		"Bucket/Name[2]":                 {"page-b"},
		"Bucket[3]/Name":                 nil,
		"Prefix":                         {"top", "inner"},
		"/ListAllMyBucketsResult/Prefix": {"top"},
		"/Buckets":                       nil,
		"Mixed":                          {"abc"},
		"Key":                            {"a&<"},
		"Absent":                         nil,
	} {
		p, err := parsePath(path)
		if err != nil {
			t.Fatalf("parsePath(%q): %v", path, err)
		}
		var got []string
		for _, e := range p.selectFrom(root) {
			got = append(got, e.text)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s selects %q, want %q", path, got, want)
		}
	}
}

func TestBadXML(t *testing.T) {
	for _, body := range []string{"", "not xml", "<a><b></a>"} {
		if _, err := parseXML([]byte(body)); err == nil {
			t.Errorf("parseXML(%q) succeeded", body)
		}
	}
}

func TestBadPaths(t *testing.T) {
	for _, path := range []string{"", "/", "A//B", "A[", "A[x]", "A[0]", "[1]", "A[1]x"} {
		if _, err := parsePath(path); err == nil {
			t.Errorf("parsePath(%q) succeeded", path)
		}
	}
}
