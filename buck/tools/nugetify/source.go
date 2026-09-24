// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const defaultFlatContainer = "https://api.nuget.org/v3-flatcontainer/"

// packageSource fetches one pinned package's .nupkg bytes, and says where it
// found them: "" for nuget.org, otherwise the base URL of the feed, which
// the lock records and the BUILD file downloads from.
type packageSource interface {
	fetch(ctx context.Context, id, version string) (data []byte, origin string, err error)
}

// flatContainer is nuget.org's V3 flat container, the same endpoint the
// generated BUILD file downloads from, then the manifest's other feeds in
// order, fronted by a directory cache so a re-resolution does not download
// packages it already has.
type flatContainer struct {
	base   string
	extra  []string
	cache  string
	client *http.Client
	log    io.Writer
}

// errNotFound is a feed's 404: the next feed may have the package.
var errNotFound = errors.New("not found")

func newFlatContainer(base, cache string, log io.Writer) *flatContainer {
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return &flatContainer{base: base, cache: cache, client: &http.Client{Timeout: 5 * time.Minute}, log: log}
}

// packageURL is where nuget.org serves a package; both id and version are
// lower-cased and the version normalized, as the flat container requires.
func packageURL(base, id, version string) string {
	lowerID := strings.ToLower(id)
	lowerVersion := strings.ToLower(version)
	return fmt.Sprintf("%s%s/%s/%s.%s.nupkg", base, lowerID, lowerVersion, lowerID, lowerVersion)
}

func (f *flatContainer) fetch(ctx context.Context, id, version string) ([]byte, string, error) {
	var failures []string
	for index, base := range append([]string{f.base}, f.extra...) {
		data, err := f.fetchFrom(ctx, base, index, id, version)
		if err == nil {
			if index == 0 {
				return data, "", nil
			}
			return data, base, nil
		}
		if !errors.Is(err, errNotFound) {
			return nil, "", err
		}
		failures = append(failures, err.Error())
	}
	return nil, "", fmt.Errorf("%s", strings.Join(failures, "; "))
}

// fetchFrom downloads a package from one feed; the default feed's cache is
// the cache directory itself, the others' a directory each.
func (f *flatContainer) fetchFrom(ctx context.Context, base string, index int, id, version string) ([]byte, error) {
	directory := f.cache
	if index > 0 {
		sum := sha256.Sum256([]byte(base))
		directory = filepath.Join(f.cache, hex.EncodeToString(sum[:8]))
	}
	cached := filepath.Join(directory, strings.ToLower(id)+"."+strings.ToLower(version)+".nupkg")
	if data, err := os.ReadFile(cached); err == nil {
		return data, nil
	}
	url := packageURL(base, id, version)
	fmt.Fprintf(f.log, "Downloading %s\n", url)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := f.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s: %w", url, errNotFound)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %s", url, response.Status)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(directory, ".download-*")
	if err != nil {
		return nil, err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		os.Remove(temporary.Name())
		return nil, err
	}
	if err := temporary.Close(); err != nil {
		os.Remove(temporary.Name())
		return nil, err
	}
	if err := os.Rename(temporary.Name(), cached); err != nil {
		os.Remove(temporary.Name())
		return nil, err
	}
	return data, nil
}
