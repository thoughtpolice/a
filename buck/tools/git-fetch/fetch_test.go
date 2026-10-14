// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer answers git's smart HTTP protocol version 2 for one
// repository at /repo, serving a fixed pack for one wanted object.
type fakeServer struct {
	t       *testing.T
	format  *objectFormat
	pack    []byte
	want    oid
	shallow []oid

	caps      []string // the capabilities advertised after "version 2"
	noService bool     // leave out the "# service=" preamble
	// fail, if set, may answer a request in place of the server, and
	// returns whether it did.
	fail func(w http.ResponseWriter, r *http.Request, post int) bool

	mu          sync.Mutex
	gets, posts int
	lastBody    string
}

func newFakeServer(t *testing.T, format *objectFormat, pack []byte, want oid) *fakeServer {
	return &fakeServer{
		t: t, format: format, pack: pack, want: want, shallow: []oid{want},
		caps: []string{"agent=git/2.99", "ls-refs=unborn", "fetch=shallow wait-for-done filter", "object-format=" + format.name},
	}
}

func (s *fakeServer) start() *httptest.Server {
	srv := httptest.NewServer(s)
	s.t.Cleanup(srv.Close)
	return srv
}

func (s *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Git-Protocol") != "version=2" {
		s.t.Errorf("%s %s without Git-Protocol: version=2", r.Method, r.URL)
	}
	if !strings.HasPrefix(r.Header.Get("User-Agent"), "git/") {
		s.t.Errorf("User-Agent %q", r.Header.Get("User-Agent"))
	}
	s.mu.Lock()
	post := 0
	if r.Method == http.MethodPost {
		s.posts++
		post = s.posts
	} else {
		s.gets++
	}
	s.mu.Unlock()
	if s.fail != nil && s.fail(w, r, post) {
		return
	}
	var b bytes.Buffer
	switch {
	case r.Method == http.MethodGet:
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		if !s.noService {
			writePktLine(&b, "# service=git-upload-pack\n")
			b.WriteString("0000")
		}
		writePktLine(&b, "version 2\n")
		for _, c := range s.caps {
			writePktLine(&b, c+"\n")
		}
		b.WriteString("0000")
	case r.Method == http.MethodPost && r.URL.Path == "/repo/git-upload-pack":
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.lastBody = string(body)
		s.mu.Unlock()
		if ct := r.Header.Get("Content-Type"); ct != "application/x-git-upload-pack-request" {
			s.t.Errorf("POST with Content-Type %q", ct)
		}
		for _, line := range []string{"command=fetch", "want " + s.format.hex(s.want), "deepen 1", "done"} {
			if !strings.Contains(string(body), line+"\n") {
				s.t.Errorf("fetch request lacks %q:\n%s", line, body)
			}
		}
		w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
		writePktLine(&b, "shallow-info\n")
		for _, id := range s.shallow {
			writePktLine(&b, "shallow "+s.format.hex(id)+"\n")
		}
		b.WriteString("0001")
		writePktLine(&b, "packfile\n")
		writePktLine(&b, "\x02Enumerating objects: done.\n")
		for rest := s.pack; len(rest) > 0; {
			n := min(len(rest), 1000)
			writePktLine(&b, "\x01"+string(rest[:n]))
			rest = rest[n:]
		}
		b.WriteString("0000")
	default:
		http.NotFound(w, r)
		return
	}
	w.Write(b.Bytes())
}

// fastRetries makes retries quick for the length of a test.
func fastRetries(t *testing.T) {
	delay, idle := retryDelay, idleTimeout
	retryDelay, idleTimeout = time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() { retryDelay, idleTimeout = delay, idle })
}

func testRepo(t *testing.T, format *objectFormat) ([]byte, oid) {
	return repoPack(format, map[string]testFile{"README": {modeFile, "hello\n"}})
}

func TestFetch(t *testing.T) {
	for _, format := range []*objectFormat{sha1Format, sha256Format} {
		for _, noService := range []bool{false, true} {
			pack, commit := testRepo(t, format)
			s := newFakeServer(t, format, pack, commit)
			s.noService = noService
			srv := s.start()
			res, err := fetch(context.Background(), srv.URL+"/repo/", format, commit, io.Discard)
			if err != nil {
				t.Fatalf("%s: %v", format.name, err)
			}
			if !bytes.Equal(res.pack.data, pack) {
				t.Errorf("%s: got a different pack", format.name)
			}
			if len(res.shallow) != 1 || res.shallow[0] != commit {
				t.Errorf("%s: shallow %v", format.name, res.shallow)
			}
			if !strings.Contains(s.lastBody, "object-format="+format.name+"\n") || !strings.Contains(s.lastBody, "agent=") {
				t.Errorf("%s: request %q", format.name, s.lastBody)
			}
		}
	}
}

func TestFetchSendsOnlyAdvertisedCapabilities(t *testing.T) {
	pack, commit := testRepo(t, sha1Format)
	s := newFakeServer(t, sha1Format, pack, commit)
	s.caps = []string{"fetch=shallow"}
	if _, err := fetch(context.Background(), s.start().URL+"/repo", sha1Format, commit, io.Discard); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s.lastBody, "object-format") || strings.Contains(s.lastBody, "agent") {
		t.Errorf("request %q", s.lastBody)
	}
}

func TestFetchRefusesWhatTheServerCannotDo(t *testing.T) {
	pack, commit := testRepo(t, sha1Format)
	for _, tt := range []struct {
		caps []string
		want string
	}{
		{[]string{"ls-refs"}, "does not offer git's fetch command"},
		{[]string{"fetch=filter"}, "does not support shallow fetches"},
		{[]string{"fetch=shallow", "object-format=sha256"}, "uses sha256 object ids, not sha1"},
	} {
		s := newFakeServer(t, sha1Format, pack, commit)
		s.caps = tt.caps
		_, err := fetch(context.Background(), s.start().URL+"/repo", sha1Format, commit, io.Discard)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("caps %q: got %v, want %q", tt.caps, err, tt.want)
		}
	}
}

func TestFetchRetries(t *testing.T) {
	fastRetries(t)
	pack, commit := testRepo(t, sha1Format)
	for name, fail := range map[string]func(http.ResponseWriter, *http.Request, int) bool{
		"server errors": func(w http.ResponseWriter, r *http.Request, post int) bool {
			if post == 0 || post > 2 {
				return false
			}
			http.Error(w, "busy", []int{http.StatusServiceUnavailable, http.StatusTooManyRequests}[post-1])
			return true
		},
		"truncated responses": func(w http.ResponseWriter, r *http.Request, post int) bool {
			if post != 1 {
				return false
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			io.WriteString(w, "000dpackfile\n0100\x01PACK")
			return true
		},
		"stalled responses": func(w http.ResponseWriter, r *http.Request, post int) bool {
			if post != 1 {
				return false
			}
			time.Sleep(500 * time.Millisecond)
			return true
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := newFakeServer(t, sha1Format, pack, commit)
			s.fail = fail
			var log bytes.Buffer
			if _, err := fetch(context.Background(), s.start().URL+"/repo", sha1Format, commit, &log); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(log.String(), "retrying") {
				t.Errorf("log %q", log.String())
			}
		})
	}
}

func TestFetchGivesUpAfterAttempts(t *testing.T) {
	fastRetries(t)
	pack, commit := testRepo(t, sha1Format)
	s := newFakeServer(t, sha1Format, pack, commit)
	s.fail = func(w http.ResponseWriter, r *http.Request, post int) bool {
		http.Error(w, "down", http.StatusBadGateway)
		return true
	}
	_, err := fetch(context.Background(), s.start().URL+"/repo", sha1Format, commit, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "502") || s.gets != attempts {
		t.Fatalf("got %v after %d attempts", err, s.gets)
	}
}

func TestFetchDoesNotRetryPermanentFailures(t *testing.T) {
	fastRetries(t)
	pack, commit := testRepo(t, sha1Format)
	for _, tt := range []struct {
		name string
		fail func(http.ResponseWriter, *http.Request, int) bool
		want string
	}{
		{"credentials", func(w http.ResponseWriter, r *http.Request, _ int) bool {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
			http.Error(w, "no", http.StatusUnauthorized)
			return true
		}, "never sends: is the repository public"},
		{"missing", func(w http.ResponseWriter, r *http.Request, _ int) bool {
			http.NotFound(w, r)
			return true
		}, "HTTP 404"},
		{"dumb server", func(w http.ResponseWriter, r *http.Request, _ int) bool {
			w.Header().Set("Content-Type", "text/plain")
			io.WriteString(w, "abc refs/heads/main\n")
			return true
		}, "is it a git server?"},
		{"protocol version 0", func(w http.ResponseWriter, r *http.Request, _ int) bool {
			w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
			var b bytes.Buffer
			writePktLine(&b, "# service=git-upload-pack\n")
			b.WriteString("0000")
			writePktLine(&b, strings.Repeat("a", 40)+" HEAD\x00multi_ack\n")
			b.WriteString("0000")
			w.Write(b.Bytes())
			return true
		}, "does not speak git protocol version 2"},
		{"ERR packet", func(w http.ResponseWriter, r *http.Request, post int) bool {
			if post == 0 {
				return false
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			var b bytes.Buffer
			writePktLine(&b, "ERR upload-pack: not our ref\n")
			w.Write(b.Bytes())
			return true
		}, "the server said: upload-pack: not our ref"},
		{"side band error", func(w http.ResponseWriter, r *http.Request, post int) bool {
			if post == 0 {
				return false
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			var b bytes.Buffer
			writePktLine(&b, "packfile\n")
			writePktLine(&b, "\x03fatal: out of memory\n")
			w.Write(b.Bytes())
			return true
		}, "the server said: fatal: out of memory"},
		{"no pack", func(w http.ResponseWriter, r *http.Request, post int) bool {
			if post == 0 {
				return false
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			io.WriteString(w, "0000")
			return true
		}, "sent no pack"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := newFakeServer(t, sha1Format, pack, commit)
			s.fail = tt.fail
			_, err := fetch(context.Background(), s.start().URL+"/repo", sha1Format, commit, io.Discard)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v, want %q", err, tt.want)
			}
			if s.gets != 1 {
				t.Errorf("tried %d times", s.gets)
			}
		})
	}
}

func TestFetchFollowsARedirectedRepository(t *testing.T) {
	pack, commit := testRepo(t, sha1Format)
	s := newFakeServer(t, sha1Format, pack, commit)
	s.fail = func(w http.ResponseWriter, r *http.Request, _ int) bool {
		if strings.HasPrefix(r.URL.Path, "/old/") {
			http.Redirect(w, r, "/repo/info/refs?service=git-upload-pack", http.StatusMovedPermanently)
			return true
		}
		return false
	}
	if _, err := fetch(context.Background(), s.start().URL+"/old", sha1Format, commit, io.Discard); err != nil {
		t.Fatal(err)
	}
	if s.posts != 1 {
		t.Fatalf("%d POSTs reached the repository", s.posts)
	}
}

func TestFetchRefusesOtherRedirects(t *testing.T) {
	pack, commit := testRepo(t, sha1Format)
	for _, target := range []string{"/login", "/repo/info/refs?service=git-receive-pack"} {
		s := newFakeServer(t, sha1Format, pack, commit)
		s.fail = func(w http.ResponseWriter, r *http.Request, _ int) bool {
			if r.URL.Path == "/old/info/refs" {
				http.Redirect(w, r, target, http.StatusFound)
				return true
			}
			return false
		}
		_, err := fetch(context.Background(), s.start().URL+"/old", sha1Format, commit, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "does not look like a repository") {
			t.Errorf("redirect to %s: got %v", target, err)
		}
	}
}

func TestFetchDoesNotFollowRedirectsForPacks(t *testing.T) {
	pack, commit := testRepo(t, sha1Format)
	s := newFakeServer(t, sha1Format, pack, commit)
	s.fail = func(w http.ResponseWriter, r *http.Request, post int) bool {
		if post == 0 {
			return false
		}
		http.Redirect(w, r, "/repo/git-upload-pack", http.StatusTemporaryRedirect)
		return post == 1
	}
	_, err := fetch(context.Background(), s.start().URL+"/repo", sha1Format, commit, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "307") || s.posts != 1 {
		t.Fatalf("got %v after %d POSTs", err, s.posts)
	}
}

func TestFetchRefusesURLs(t *testing.T) {
	for url, want := range map[string]string{
		"ssh://git@github.com/a/b":       "not an http or https URL",
		"git@github.com:a/b":             "not an http or https URL",
		"file:///tmp/repo":               "not an http or https URL",
		"/tmp/repo":                      "not an http or https URL",
		"https://user:secret@host/a/b":   "carries credentials",
		"https://ghp_token@github.com/a": "carries credentials",
		"https:///a/b":                   "names no host",
		"https://host/a?b=c":             "query",
	} {
		_, err := fetch(context.Background(), url, sha1Format, oid{}, io.Discard)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", url, err, want)
		}
		if err != nil && (strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "ghp_token")) {
			t.Errorf("%s: the error repeats the credentials: %v", url, err)
		}
	}
}
