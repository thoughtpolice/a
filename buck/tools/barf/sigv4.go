// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type credentials struct {
	accessKeyID, secretAccessKey, region string
}

// signV4 signs req for the s3 service with AWS Signature Version 4, using a
// single-chunk payload hash of body. It signs every header already set on
// req, plus Host, X-Amz-Date, and X-Amz-Content-Sha256, which it adds.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func signV4(req *http.Request, body []byte, c credentials, now time.Time) {
	const service = "s3"
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	payloadHash := sha256Hex(body)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": host}
	for name, values := range req.Header {
		trimmed := make([]string, len(values))
		for i, v := range values {
			trimmed[i] = strings.Join(strings.Fields(v), " ")
		}
		headers[strings.ToLower(name)] = strings.Join(trimmed, ",")
	}
	names := slices.Sorted(maps.Keys(headers))
	var canonicalHeaders strings.Builder
	for _, name := range names {
		fmt.Fprintf(&canonicalHeaders, "%s:%s\n", name, headers[name])
	}
	signedHeaders := strings.Join(names, ";")

	path := req.URL.Path
	if path == "" {
		path = "/"
	}
	canonicalRequest := strings.Join([]string{
		req.Method,
		uriEncode(path, false),
		canonicalQuery(req.URL.RawQuery),
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := strings.Join([]string{day, c.region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest))}, "\n")
	key := []byte("AWS4" + c.secretAccessKey)
	for _, part := range []string{day, c.region, service, "aws4_request"} {
		key = hmacSHA256(key, part)
	}
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		c.accessKeyID, scope, signedHeaders, signature))
}

// canonicalQuery decodes each query parameter, then re-encodes and sorts
// them, so that the signature does not depend on how the target spelled them.
func canonicalQuery(raw string) string {
	type param struct{ name, value string }
	var params []param
	for part := range strings.SplitSeq(raw, "&") {
		if part == "" {
			continue
		}
		name, value, _ := strings.Cut(part, "=")
		params = append(params, param{uriEncode(queryUnescape(name), true), uriEncode(queryUnescape(value), true)})
	}
	slices.SortFunc(params, func(a, b param) int {
		if c := strings.Compare(a.name, b.name); c != 0 {
			return c
		}
		return strings.Compare(a.value, b.value)
	})
	parts := make([]string, len(params))
	for i, p := range params {
		parts[i] = p.name + "=" + p.value
	}
	return strings.Join(parts, "&")
}

func queryUnescape(s string) string {
	if u, err := url.QueryUnescape(s); err == nil {
		return u
	}
	return s
}

// uriEncode percent-encodes every byte except RFC 3986 unreserved characters,
// with upper-case hex digits, as SigV4 requires. barf also uses it for query
// directives, so a space is always %20 and never '+'.
func uriEncode(s string, encodeSlash bool) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&15])
		}
	}
	return b.String()
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
