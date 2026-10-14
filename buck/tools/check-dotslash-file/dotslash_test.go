// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// entry is a platform whose artifact is data, served at url.
func entry(url string, data []byte) map[string]any {
	return map[string]any{
		"size":      len(data),
		"hash":      "sha256",
		"digest":    sha256Hex(data),
		"format":    "zst",
		"path":      "tool",
		"providers": []any{map[string]any{"url": url}},
	}
}

func writeDotslash(t *testing.T, platforms map[string]any) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"name": "tool", "platforms": platforms}, jsontext.WithIndent("  "), json.Deterministic(true))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(path, append([]byte("#!/usr/bin/env dotslash\n\n"), body...), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// server serves files by path and counts the requests it gets.
type server struct {
	*httptest.Server
	requests atomic.Int64
}

func serve(t *testing.T, handler http.HandlerFunc) *server {
	t.Helper()
	s := &server{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		handler(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func serveFiles(t *testing.T, files map[string][]byte) *server {
	return serve(t, func(w http.ResponseWriter, r *http.Request) {
		data, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	})
}

// testChecker retries like the real one, without waiting.
func testChecker() *checker {
	return &checker{client: http.DefaultClient, attempts: 3}
}

func check(t *testing.T, c *checker, path string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := c.checkFile(t.Context(), path, &out)
	return out.String(), err
}

func TestCheckFile(t *testing.T) {
	a, b := []byte("artifact a"), []byte("artifact b, longer")
	srv := serveFiles(t, map[string][]byte{"/a": a, "/b": b})
	path := writeDotslash(t, map[string]any{
		"linux-x86_64":  entry(srv.URL+"/a", a),
		"macos-aarch64": entry(srv.URL+"/b", b),
	})
	out, err := check(t, testChecker(), path)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for _, want := range []string{"Checking tool...", "linux-x86_64: ✓", "macos-aarch64: ✓", "All 2 platforms verified"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
}

func TestCheckFileMismatch(t *testing.T) {
	data := []byte("the artifact")
	srv := serveFiles(t, map[string][]byte{"/a": data})
	wrongSize := entry(srv.URL+"/a", data)
	wrongSize["size"] = len(data) + 1
	wrongDigest := entry(srv.URL+"/a", data)
	wrongDigest["digest"] = sha256Hex([]byte("another one!"))
	for _, tc := range []struct {
		name, want string
		entry      map[string]any
	}{
		{"size", "is 12 bytes, not 13", wrongSize},
		{"digest", "has sha256 " + sha256Hex(data) + ", not ", wrongDigest},
		{"missing", "HTTP 404", entry(srv.URL+"/missing", data)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeDotslash(t, map[string]any{
				"good": entry(srv.URL+"/a", data),
				"bad":  tc.entry,
			})
			out, err := check(t, testChecker(), path)
			if err == nil || !strings.Contains(err.Error(), "1 of 2 platforms failed") {
				t.Fatalf("got %v\n%s", err, out)
			}
			if !strings.Contains(out, "good: ✓") || !strings.Contains(out, "bad: ✗") || !strings.Contains(out, tc.want) {
				t.Errorf("output lacks %q:\n%s", tc.want, out)
			}
		})
	}
}

func TestCheckFileRetries(t *testing.T) {
	data := []byte("eventually")
	for _, tc := range []struct {
		name string
		// fail handles the first failures requests, which must not succeed.
		fail     func(w http.ResponseWriter)
		failures int64
		ok       bool
		requests int64
	}{
		{"recovers", func(w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) }, 2, true, 3},
		{"rate limited", func(w http.ResponseWriter) { w.WriteHeader(http.StatusTooManyRequests) }, 1, true, 2},
		{"truncated body", func(w http.ResponseWriter) {
			w.Header().Set("Content-Length", "100")
			w.Write(data)
		}, 1, true, 2},
		{"gives up", func(w http.ResponseWriter) { w.WriteHeader(http.StatusBadGateway) }, 3, false, 3},
		{"not found", func(w http.ResponseWriter) { w.WriteHeader(http.StatusNotFound) }, 1, false, 1},
		{"forbidden", func(w http.ResponseWriter) { w.WriteHeader(http.StatusForbidden) }, 1, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var srv *server
			srv = serve(t, func(w http.ResponseWriter, r *http.Request) {
				if srv.requests.Load() <= tc.failures {
					tc.fail(w)
					return
				}
				w.Write(data)
			})
			path := writeDotslash(t, map[string]any{"linux-x86_64": entry(srv.URL+"/a", data)})
			out, err := check(t, testChecker(), path)
			if (err == nil) != tc.ok {
				t.Errorf("got %v\n%s", err, out)
			}
			if got := srv.requests.Load(); got != tc.requests {
				t.Errorf("%d requests, want %d\n%s", got, tc.requests, out)
			}
		})
	}
}

// A platform the checker cannot check fails before anything is downloaded.
func TestCheckFileUncheckable(t *testing.T) {
	data := []byte("never fetched")
	srv := serveFiles(t, map[string][]byte{"/a": data})
	edit := func(f func(map[string]any)) map[string]any {
		e := entry(srv.URL+"/a", data)
		f(e)
		return e
	}
	for _, tc := range []struct {
		name, want string
		entry      map[string]any
	}{
		{"blake3", `unsupported hash "blake3"`, edit(func(e map[string]any) { e["hash"] = "blake3" })},
		{"no size", "no size or digest", edit(func(e map[string]any) { delete(e, "size") })},
		{"no digest", "no size or digest", edit(func(e map[string]any) { delete(e, "digest") })},
		{"no providers", "no provider with a url", edit(func(e map[string]any) { e["providers"] = []any{} })},
		{"github release only", "no provider with a url", edit(func(e map[string]any) {
			e["providers"] = []any{map[string]any{"type": "github-release", "repo": "https://github.com/o/r", "tag": "v1", "name": "a"}}
		})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := check(t, testChecker(), writeDotslash(t, map[string]any{"linux-x86_64": tc.entry}))
			if err == nil || !strings.Contains(out, tc.want) {
				t.Errorf("got %v, want %q\n%s", err, tc.want, out)
			}
		})
	}
	if got := srv.requests.Load(); got != 0 {
		t.Errorf("%d requests, want none", got)
	}
}

// The first provider with a URL is the one downloaded.
func TestCheckFileFirstURLProvider(t *testing.T) {
	data := []byte("from the mirror")
	srv := serveFiles(t, map[string][]byte{"/a": data})
	e := entry(srv.URL+"/a", data)
	e["providers"] = []any{
		map[string]any{"type": "github-release", "repo": "https://github.com/o/r", "tag": "v1", "name": "a"},
		map[string]any{"url": srv.URL + "/a"},
		map[string]any{"url": srv.URL + "/unused"},
	}
	if out, err := check(t, testChecker(), writeDotslash(t, map[string]any{"linux-x86_64": e})); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := srv.requests.Load(); got != 1 {
		t.Errorf("%d requests, want 1", got)
	}
}

func TestParseDotslash(t *testing.T) {
	for _, tc := range []struct{ name, data, want string }{
		{"ok", "#!/usr/bin/env dotslash\n\n{\"platforms\": {\"linux-x86_64\": {}}}\n", ""},
		{"no shebang", "{\"platforms\": {\"linux-x86_64\": {}}}\n", "not a DotSlash file"},
		{"other shebang", "#!/bin/sh\necho hi\n", "not a DotSlash file"},
		{"invalid", "#!/usr/bin/env dotslash\n{\"platforms\": \n", "invalid JSON"},
		{"no platforms", "#!/usr/bin/env dotslash\n{\"name\": \"tool\"}\n", "no platforms"},
		{"empty platforms", "#!/usr/bin/env dotslash\n{\"platforms\": {}}\n", "no platforms"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseDotslash([]byte(tc.data))
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Errorf("got %v, want %q", err, tc.want)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGitHubToken(t *testing.T) {
	var auth string
	c := testChecker()
	c.token = "secret"
	c.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		auth = r.Header.Get("Authorization")
		rec := httptest.NewRecorder()
		rec.WriteString("x")
		return rec.Result(), nil
	})}
	for _, tc := range []struct {
		url  string
		sent bool
	}{
		{"https://github.com/o/r/releases/download/v1/a.zst", true},
		{"https://api.github.com/repos/o/r/releases/assets/1", true},
		{"http://github.com/o/r/releases/download/v1/a.zst", false},
		{"https://example.com/a.zst", false},
		{"https://notgithub.com/a.zst", false},
		{"https://github.com.example.com/a.zst", false},
	} {
		auth = ""
		if _, _, err := c.download(t.Context(), tc.url, nil); err != nil {
			t.Fatal(err)
		}
		if sent := auth == "Bearer secret"; sent != tc.sent {
			t.Errorf("%s: Authorization %q", tc.url, auth)
		}
		u, _ := url.Parse(tc.url)
		if isGitHub(u) != tc.sent {
			t.Errorf("isGitHub(%s) = %v", tc.url, !tc.sent)
		}
	}
}
