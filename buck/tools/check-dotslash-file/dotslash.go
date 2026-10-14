// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// The parts of a DotSlash file that say what to download and what it must
// be; see https://dotslash-cli.com/docs/dotslash-file/.
type dotslashFile struct {
	Platforms map[string]platform `json:"platforms"`
}

type platform struct {
	Size      *int64     `json:"size"`
	Hash      string     `json:"hash"`
	Digest    string     `json:"digest"`
	Providers []provider `json:"providers"`
}

// Only a url provider names something to download. DotSlash itself
// resolves the others, such as github-release, which have no URL here.
type provider struct {
	URL string `json:"url"`
}

type checker struct {
	client *http.Client
	// Sent to GitHub, whose anonymous downloads are rate limited.
	token string
	// How many times to try a download, waiting retryDelay after the first
	// failure and twice as long after each one after that.
	attempts   int
	retryDelay time.Duration
}

func newChecker() *checker {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		token = os.Getenv("GH_TOKEN")
	}
	return &checker{
		client:     http.DefaultClient,
		token:      token,
		attempts:   3,
		retryDelay: time.Second,
	}
}

// checkFile downloads every platform's artifact in the DotSlash file at
// path, reporting each one, and fails if any is not what the file says.
func (c *checker) checkFile(ctx context.Context, path string, out io.Writer) error {
	fmt.Fprintf(out, "Checking %s...\n", filepath.Base(path))
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	file, err := parseDotslash(data)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	names := slices.Sorted(maps.Keys(file.Platforms))
	failed := 0
	for _, name := range names {
		if err := c.checkPlatform(ctx, name, file.Platforms[name], out); err != nil {
			fmt.Fprintf(out, "  %s: ✗ %v\n", name, err)
			failed++
		} else {
			fmt.Fprintf(out, "  %s: ✓\n", name)
		}
	}
	if failed > 0 {
		return fmt.Errorf("%s: %d of %d platforms failed", path, failed, len(names))
	}
	fmt.Fprintf(out, "  All %d platforms verified\n", len(names))
	return nil
}

func parseDotslash(data []byte) (*dotslashFile, error) {
	first, rest, _ := bytes.Cut(data, []byte("\n"))
	if !bytes.HasPrefix(first, []byte("#!")) || !bytes.Contains(first, []byte("dotslash")) {
		return nil, fmt.Errorf("not a DotSlash file: the first line is %q", first)
	}
	var file dotslashFile
	if err := json.Unmarshal(rest, &file); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if len(file.Platforms) == 0 {
		return nil, errors.New("no platforms")
	}
	return &file, nil
}

func (c *checker) checkPlatform(ctx context.Context, name string, p platform, out io.Writer) error {
	if p.Hash != "sha256" {
		return fmt.Errorf("unsupported hash %q", p.Hash)
	}
	if p.Size == nil || p.Digest == "" {
		return errors.New("no size or digest")
	}
	// The first URL stands for the rest, which are mirrors of it.
	i := slices.IndexFunc(p.Providers, func(p provider) bool { return p.URL != "" })
	if i < 0 {
		return errors.New("no provider with a url")
	}
	src := p.Providers[i].URL
	size, digest, err := c.download(ctx, src, func(err error, delay time.Duration, attempt int) {
		fmt.Fprintf(out, "  %s: %v; retrying in %v (attempt %d/%d)\n", name, err, delay, attempt, c.attempts)
	})
	if err != nil {
		return err
	}
	if size != *p.Size {
		return fmt.Errorf("%s is %d bytes, not %d", src, size, *p.Size)
	}
	if digest != p.Digest {
		return fmt.Errorf("%s has sha256 %s, not %s", src, digest, p.Digest)
	}
	return nil
}

// download returns the size and SHA-256 digest of what rawURL serves,
// streaming it rather than keeping it. Rate limiting, server errors and
// network errors, including one partway through the body, are retried;
// retrying is called before each wait.
func (c *checker) download(ctx context.Context, rawURL string, retrying func(err error, delay time.Duration, attempt int)) (int64, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, "", err
	}
	if c.token != "" && isGitHub(req.URL) {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	delay := c.retryDelay
	for attempt := 1; ; attempt++ {
		size, digest, err := c.fetch(req)
		if err == nil {
			return size, digest, nil
		}
		if attempt >= c.attempts || !retryable(err) || ctx.Err() != nil {
			return 0, "", err
		}
		retrying(err, delay, attempt)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return 0, "", ctx.Err()
		}
		delay *= 2
	}
}

func (c *checker) fetch(req *http.Request) (int64, string, error) {
	resp, err := c.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, "", &statusError{url: req.URL.String(), status: resp.Status, code: resp.StatusCode}
	}
	hash := sha256.New()
	size, err := io.Copy(hash, resp.Body)
	if err != nil {
		return 0, "", fmt.Errorf("reading %s: %w", req.URL, err)
	}
	return size, hex.EncodeToString(hash.Sum(nil)), nil
}

type statusError struct {
	url, status string
	code        int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("%s: HTTP %s", e.url, e.status)
}

// retryable reports whether err, from fetch, might not happen again: any
// error but an HTTP status that says the request itself is wrong.
func retryable(err error) bool {
	var status *statusError
	if errors.As(err, &status) {
		switch status.code {
		case http.StatusTooManyRequests,
			http.StatusInternalServerError,
			http.StatusBadGateway,
			http.StatusServiceUnavailable,
			http.StatusGatewayTimeout:
			return true
		}
		return false
	}
	return true
}

// isGitHub reports whether u is a GitHub URL the token may be sent to. A
// release download redirects to a storage host, where Go's client drops
// the header again.
func isGitHub(u *url.URL) bool {
	host := u.Hostname()
	return u.Scheme == "https" && (host == "github.com" || strings.HasSuffix(host, ".github.com"))
}
