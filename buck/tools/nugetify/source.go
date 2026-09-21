// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const defaultFlatContainer = "https://api.nuget.org/v3-flatcontainer/"

// packageSource fetches one pinned package's .nupkg bytes.
type packageSource interface {
	fetch(ctx context.Context, id, version string) ([]byte, error)
}

// flatContainer is nuget.org's V3 flat container, the same endpoint the
// generated BUILD file downloads from, fronted by a directory cache so a
// re-resolution does not download packages it already has.
type flatContainer struct {
	base   string
	cache  string
	client *http.Client
	log    io.Writer
}

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

func (f *flatContainer) fetch(ctx context.Context, id, version string) ([]byte, error) {
	cached := filepath.Join(f.cache, strings.ToLower(id)+"."+strings.ToLower(version)+".nupkg")
	if data, err := os.ReadFile(cached); err == nil {
		return data, nil
	}
	url := packageURL(f.base, id, version)
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
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %s", url, response.Status)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	if err := os.MkdirAll(f.cache, 0o755); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(f.cache, ".download-*")
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
