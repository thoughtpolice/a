// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"
	"testing"
	"time"
)

// The GET Object example from AWS's SigV4 documentation for S3:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
func TestSignV4KnownAnswer(t *testing.T) {
	req, err := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=0-9")
	c := credentials{"AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1"}
	signV4(req, nil, c, time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Errorf("Authorization = %s\nwant %s", got, want)
	}
	if got := req.Header.Get("X-Amz-Content-Sha256"); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("X-Amz-Content-Sha256 = %s", got)
	}
}

func TestCanonicalQuery(t *testing.T) {
	for raw, want := range map[string]string{
		"":                            "",
		"uploads":                     "uploads=",
		"b=2&a=1&a=0":                 "a=0&a=1&b=2",
		"prefix=signed%20%2B&x=a+b":   "prefix=signed%20%2B&x=a%20b",
		"delimiter=/&k=caf%C3%A9~-._": "delimiter=%2F&k=caf%C3%A9~-._",
		"uploadId=abc&partNumber=1&&": "partNumber=1&uploadId=abc",
	} {
		if got := canonicalQuery(raw); got != want {
			t.Errorf("canonicalQuery(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestURIEncode(t *testing.T) {
	if got := uriEncode("/a b/+é~", false); got != "/a%20b/%2B%C3%A9~" {
		t.Errorf("path encoding = %q", got)
	}
	if got := uriEncode("a/b", true); got != "a%2Fb" {
		t.Errorf("value encoding = %q", got)
	}
}
