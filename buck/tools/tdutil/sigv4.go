// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// AWS Signature Version 4, enough of it to sign a GET and a PUT against S3.
//
// This is hand-rolled because every Go tool in this repository is built from
// the standard library alone, and pulling an AWS SDK in for two verbs would be
// a poor trade. The algorithm is a stable, fully specified thing which has not
// changed since 2012, and the tests pin it against AWS's own published example
// calculations at each intermediate stage — canonical request, string to sign,
// and signature — so a regression says which step broke rather than only that
// the server said no.
const (
	sigV4Algorithm  = "AWS4-HMAC-SHA256"
	sigV4Terminator = "aws4_request"
	sigV4TimeFormat = "20060102T150405Z"
	sigV4DateFormat = "20060102"

	// The digest of the empty string, which every GET signs as its payload.
	emptyPayloadSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

type awsCredentials struct {
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
}

// signV4 adds the headers which authenticate a request. The payload digest is
// supplied rather than computed: a request body is a file on disk by the time
// it reaches here, and S3 requires the digest in a header it then signs, so it
// has to be known before the first byte is sent.
func signV4(request *http.Request, credentials awsCredentials, region, service, payloadSHA256 string, when time.Time) {
	timestamp := when.UTC().Format(sigV4TimeFormat)
	date := when.UTC().Format(sigV4DateFormat)

	request.Header.Set("X-Amz-Date", timestamp)
	request.Header.Set("X-Amz-Content-Sha256", payloadSHA256)
	if credentials.sessionToken != "" {
		request.Header.Set("X-Amz-Security-Token", credentials.sessionToken)
	}

	canonical, signedHeaders := canonicalRequest(request, payloadSHA256)
	scope := strings.Join([]string{date, region, service, sigV4Terminator}, "/")
	toSign := stringToSign(canonical, scope, timestamp)
	signature := hex.EncodeToString(hmacSHA256(signingKey(credentials.secretAccessKey, date, region, service), toSign))

	request.Header.Set("Authorization", fmt.Sprintf(
		"%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		sigV4Algorithm,
		credentials.accessKeyID,
		scope,
		signedHeaders,
		signature,
	))
}

// sigV4IgnoredHeaders never enter a signature. Authorization is the signature
// itself, so signing it would make canonicalization depend on its own output
// and make signing a request twice produce two different answers. The rest are
// set, rewritten, or removed by transports and proxies after signing, so a
// signature covering them would not survive the trip.
var sigV4IgnoredHeaders = map[string]bool{
	"authorization":     true,
	"user-agent":        true,
	"x-amzn-trace-id":   true,
	"expect":            true,
	"transfer-encoding": true,
}

// canonicalRequest renders the request in the exact form the signature covers,
// and returns it with the semicolon-joined list of headers it signed.
func canonicalRequest(request *http.Request, payloadSHA256 string) (string, string) {
	names := make([]string, 0, len(request.Header)+1)
	values := map[string]string{}
	for name, header := range request.Header {
		lowered := strings.ToLower(name)
		if sigV4IgnoredHeaders[lowered] {
			continue
		}
		names = append(names, lowered)
		values[lowered] = collapseSpaces(strings.Join(header, ","))
	}
	// Host travels on the request struct rather than in its header map, but it
	// is signed like any other header, and S3 rejects a signature which omits
	// it.
	if _, present := values["host"]; !present {
		names = append(names, "host")
		values["host"] = requestHost(request)
	}
	sort.Strings(names)

	var headers strings.Builder
	for _, name := range names {
		headers.WriteString(name)
		headers.WriteByte(':')
		headers.WriteString(values[name])
		headers.WriteByte('\n')
	}
	signedHeaders := strings.Join(names, ";")

	return strings.Join([]string{
		request.Method,
		canonicalURI(request),
		canonicalQuery(request),
		headers.String(),
		signedHeaders,
		payloadSHA256,
	}, "\n"), signedHeaders
}

// canonicalURI encodes the path the way AWS specifies, which is not the way Go
// encodes it: Go leaves `$`, `+`, `:`, `@` and friends alone in a path, while
// AWS escapes everything outside the RFC 3986 unreserved set. S3 alone among
// the services does not then normalize or doubly encode the result.
func canonicalURI(request *http.Request) string {
	path := request.URL.Path
	if path == "" {
		return "/"
	}
	return uriEncode(path, true)
}

func canonicalQuery(request *http.Request) string {
	query := request.URL.Query()
	names := make([]string, 0, len(query))
	for name := range query {
		names = append(names, name)
	}
	sort.Strings(names)

	pairs := make([]string, 0, len(names))
	for _, name := range names {
		sorted := append([]string(nil), query[name]...)
		sort.Strings(sorted)
		for _, value := range sorted {
			pairs = append(pairs, uriEncode(name, false)+"="+uriEncode(value, false))
		}
	}
	return strings.Join(pairs, "&")
}

func uriEncode(value string, keepSlash bool) string {
	var encoded strings.Builder
	encoded.Grow(len(value))
	for index := 0; index < len(value); index++ {
		char := value[index]
		switch {
		case (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') ||
			char == '-' || char == '_' || char == '.' || char == '~':
			encoded.WriteByte(char)
		case char == '/' && keepSlash:
			encoded.WriteByte('/')
		default:
			// Byte-wise, so multi-byte runes encode as the octets AWS expects.
			_, _ = fmt.Fprintf(&encoded, "%%%02X", char)
		}
	}
	return encoded.String()
}

// collapseSpaces trims a header value and reduces runs of spaces to one, as
// the canonicalization requires. Single spaces survive, so a date header keeps
// its shape.
func collapseSpaces(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func requestHost(request *http.Request) string {
	if request.Host != "" {
		return request.Host
	}
	return request.URL.Host
}

func stringToSign(canonical, scope, timestamp string) string {
	digest := sha256.Sum256([]byte(canonical))
	return strings.Join([]string{
		sigV4Algorithm,
		timestamp,
		scope,
		hex.EncodeToString(digest[:]),
	}, "\n")
}

func signingKey(secret, date, region, service string) []byte {
	key := hmacSHA256([]byte("AWS4"+secret), date)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	return hmacSHA256(key, sigV4Terminator)
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}
