// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// The example calculations AWS publishes for signing S3 requests, with the
// credentials, bucket, and timestamp they specify. Testing against a fake S3
// which recomputes the signature would only prove the implementation agrees
// with itself, so these are the anchor: known inputs to known outputs, checked
// at each intermediate stage so a regression reports which step broke.
const (
	sigV4TestAccessKey = "AKIAIOSFODNN7EXAMPLE"
	sigV4TestSecretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
	sigV4TestRegion    = "us-east-1"
	sigV4TestService   = "s3"
)

func sigV4TestTime() time.Time {
	return time.Date(2013, time.May, 24, 0, 0, 0, 0, time.UTC)
}

func sigV4TestCredentials() awsCredentials {
	return awsCredentials{accessKeyID: sigV4TestAccessKey, secretAccessKey: sigV4TestSecretKey}
}

func authorizationSignature(t *testing.T, request *http.Request) string {
	t.Helper()
	header := request.Header.Get("Authorization")
	_, signature, found := strings.Cut(header, "Signature=")
	if !found {
		t.Fatalf("Authorization header has no signature: %q", header)
	}
	return signature
}

// AWS example: "GET Object" — an empty payload and a header which is signed
// but which the signer did not add.
func TestSigV4SignsTheAWSGetObjectExample(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=0-9")

	signV4(request, sigV4TestCredentials(), sigV4TestRegion, sigV4TestService, emptyPayloadSHA256, sigV4TestTime())

	wantCanonical := strings.Join([]string{
		"GET",
		"/test.txt",
		"",
		"host:examplebucket.s3.amazonaws.com",
		"range:bytes=0-9",
		"x-amz-content-sha256:" + emptyPayloadSHA256,
		"x-amz-date:20130524T000000Z",
		"",
		"host;range;x-amz-content-sha256;x-amz-date",
		emptyPayloadSHA256,
	}, "\n")
	canonical, signedHeaders := canonicalRequest(request, emptyPayloadSHA256)
	if canonical != wantCanonical {
		t.Fatalf("canonical request =\n%s\n\nwant\n%s", canonical, wantCanonical)
	}
	if signedHeaders != "host;range;x-amz-content-sha256;x-amz-date" {
		t.Fatalf("signed headers = %q", signedHeaders)
	}

	wantToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		"20130524T000000Z",
		"20130524/us-east-1/s3/aws4_request",
		"7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
	}, "\n")
	if got := stringToSign(canonical, "20130524/us-east-1/s3/aws4_request", "20130524T000000Z"); got != wantToSign {
		t.Fatalf("string to sign =\n%s\n\nwant\n%s", got, wantToSign)
	}

	const wantSignature = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := authorizationSignature(t, request); got != wantSignature {
		t.Fatalf("signature = %s, want %s", got, wantSignature)
	}
}

// AWS example: "PUT Object" — a payload digest, and a key whose `$` must be
// percent-encoded in the canonical URI even though Go leaves it alone.
func TestSigV4SignsTheAWSPutObjectExample(t *testing.T) {
	const payload = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
	request, err := http.NewRequest(
		http.MethodPut,
		"https://examplebucket.s3.amazonaws.com/test$file.text",
		strings.NewReader("Welcome to Amazon S3."),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Date", "Fri, 24 May 2013 00:00:00 GMT")
	request.Header.Set("X-Amz-Storage-Class", "REDUCED_REDUNDANCY")

	signV4(request, sigV4TestCredentials(), sigV4TestRegion, sigV4TestService, payload, sigV4TestTime())

	wantCanonical := strings.Join([]string{
		"PUT",
		"/test%24file.text",
		"",
		"date:Fri, 24 May 2013 00:00:00 GMT",
		"host:examplebucket.s3.amazonaws.com",
		"x-amz-content-sha256:" + payload,
		"x-amz-date:20130524T000000Z",
		"x-amz-storage-class:REDUCED_REDUNDANCY",
		"",
		"date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
		payload,
	}, "\n")
	canonical, _ := canonicalRequest(request, payload)
	if canonical != wantCanonical {
		t.Fatalf("canonical request =\n%s\n\nwant\n%s", canonical, wantCanonical)
	}

	wantToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		"20130524T000000Z",
		"20130524/us-east-1/s3/aws4_request",
		"9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d",
	}, "\n")
	if got := stringToSign(canonical, "20130524/us-east-1/s3/aws4_request", "20130524T000000Z"); got != wantToSign {
		t.Fatalf("string to sign =\n%s\n\nwant\n%s", got, wantToSign)
	}

	const wantSignature = "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
	if got := authorizationSignature(t, request); got != wantSignature {
		t.Fatalf("signature = %s, want %s", got, wantSignature)
	}
}

// A session token is itself signed, so temporary credentials — which is what
// GitHub's OIDC role assumption hands out, and therefore the common CI case —
// cannot be signed as if they were permanent ones.
func TestSigV4SignsTheSessionToken(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://bucket.s3.amazonaws.com/key", nil)
	if err != nil {
		t.Fatal(err)
	}
	credentials := sigV4TestCredentials()
	credentials.sessionToken = "session-token-value"
	signV4(request, credentials, sigV4TestRegion, sigV4TestService, emptyPayloadSHA256, sigV4TestTime())

	if got := request.Header.Get("X-Amz-Security-Token"); got != "session-token-value" {
		t.Fatalf("security token header = %q", got)
	}
	if header := request.Header.Get("Authorization"); !strings.Contains(header, "x-amz-security-token") {
		t.Fatalf("session token was not signed: %q", header)
	}
}

// Signing must not depend on its own output. The Authorization header is the
// signature, so canonicalizing it would make a second signing of the same
// request produce a different answer -- which is exactly what a retry does if
// it ever reuses a request rather than building a fresh one.
func TestSigV4SigningIsIdempotent(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=0-9")

	signV4(request, sigV4TestCredentials(), sigV4TestRegion, sigV4TestService, emptyPayloadSHA256, sigV4TestTime())
	first := authorizationSignature(t, request)
	signV4(request, sigV4TestCredentials(), sigV4TestRegion, sigV4TestService, emptyPayloadSHA256, sigV4TestTime())
	if second := authorizationSignature(t, request); second != first {
		t.Fatalf("re-signing changed the signature: %s then %s", first, second)
	}
}

func TestSigV4EncodesPathsTheWayAWSDoes(t *testing.T) {
	// Go leaves these alone in a URL path; AWS escapes everything outside the
	// RFC 3986 unreserved set, and a signature over Go's spelling is rejected.
	for value, want := range map[string]string{
		"/plain/key.json.gz": "/plain/key.json.gz",
		"/test$file.text":    "/test%24file.text",
		"/a+b":               "/a%2Bb",
		"/a b":               "/a%20b",
		"/a:b@c":             "/a%3Ab%40c",
		"/~tilde-._":         "/~tilde-._",
		"/é":                 "/%C3%A9",
	} {
		if got := uriEncode(value, true); got != want {
			t.Errorf("uriEncode(%q) = %q, want %q", value, got, want)
		}
	}
	if got := uriEncode("a/b", false); got != "a%2Fb" {
		t.Errorf("query encoding kept a slash: %q", got)
	}
}

// Canonicalization collapses runs of spaces but keeps single ones, so a date
// header keeps its shape while sloppy whitespace cannot change a signature.
func TestSigV4CollapsesHeaderWhitespace(t *testing.T) {
	for value, want := range map[string]string{
		"  bytes=0-9  ":                 "bytes=0-9",
		"Fri, 24 May 2013 00:00:00 GMT": "Fri, 24 May 2013 00:00:00 GMT",
		"a    b":                        "a b",
	} {
		if got := collapseSpaces(value); got != want {
			t.Errorf("collapseSpaces(%q) = %q, want %q", value, got, want)
		}
	}
}
