// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"path"
	"strings"
)

var skippedExtensions = map[string]struct{}{
	".png":   {},
	".jpg":   {},
	".jpeg":  {},
	".gif":   {},
	".ico":   {},
	".pdf":   {},
	".zip":   {},
	".tar":   {},
	".gz":    {},
	".bz2":   {},
	".xz":    {},
	".7z":    {},
	".bin":   {},
	".exe":   {},
	".dll":   {},
	".so":    {},
	".dylib": {},
	".a":     {},
	".lock":  {},
	".hex0":  {},
	".hex1":  {},
	".hex2":  {},
	".m1":    {},
	".pyc":   {},
	".pyo":   {},
	".pyd":   {},
	".json":  {},
	".jsonl": {},
	".jsonc": {},
	".wasm":  {},
	".o":     {},
	".obj":   {},
}

var skippedPaths = []string{
	".jj",
	".git",
	"buck-out",
	".direnv",
	"cellar",
	".ruff_cache",
	"buck/third-party/zuo/lib",
	"buck/third-party/zuo/local",
	"work",
}

func shouldProcessFile(filePath string) bool {
	normalized := normalizePath(filePath)
	for _, skipped := range skippedPaths {
		if isWithin(normalized, skipped) {
			return false
		}
	}
	if hasPathComponent(normalized, "node_modules") {
		return false
	}
	if strings.HasPrefix(normalized, "buck/third-party/zuo/zuo") {
		return false
	}

	extension := strings.ToLower(path.Ext(normalized))
	if _, skipped := skippedExtensions[extension]; skipped {
		return false
	}

	filename := path.Base(normalized)
	return !strings.HasPrefix(filename, ".") || strings.Contains(filename[1:], ".")
}

func isWithin(filePath, directory string) bool {
	return filePath == directory || strings.HasPrefix(filePath, directory+"/")
}

func hasPathComponent(filePath, component string) bool {
	for _, candidate := range strings.Split(filePath, "/") {
		if candidate == component {
			return true
		}
	}
	return false
}
