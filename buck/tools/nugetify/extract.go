// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// fetchPackage downloads a pinned package, checks its SHA-256 and unpacks
// it, for packages from feeds buck2 cannot download itself (its downloads
// start with a HEAD request, which Azure DevOps feeds refuse); nuget.org
// packages are downloaded and unpacked by http_archive.
func fetchPackage(ctx context.Context, url, sum, output string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 10 * time.Minute}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %s", url, response.Status)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("%s: %w", url, err)
	}
	if actual := sha256.Sum256(data); hex.EncodeToString(actual[:]) != strings.ToLower(sum) {
		return fmt.Errorf("%s: SHA-256 is %s, not %s", url, hex.EncodeToString(actual[:]), sum)
	}
	return extract(data, output)
}

// extract unpacks a .nupkg into a directory.
func extract(data []byte, output string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	for _, file := range reader.File {
		name := path.Clean(file.Name)
		if strings.HasSuffix(file.Name, "/") {
			continue
		}
		if name == ".." || strings.HasPrefix(name, "../") || path.IsAbs(name) {
			return fmt.Errorf("entry %q leaves the package", file.Name)
		}
		target := filepath.Join(output, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		destination, err := os.Create(target)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(destination, source)
		source.Close()
		if closeErr := destination.Close(); copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return copyErr
		}
	}
	return os.MkdirAll(output, 0o755)
}
