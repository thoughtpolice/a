// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"path"
	"strings"
)

const buildifierCommand = "buck/bin/buildifier"

var buildifierFilenames = map[string]struct{}{
	"BUILD":           {},
	"BUCK":            {},
	"BUILD.bazel":     {},
	"MODULE.bazel":    {},
	"WORKSPACE":       {},
	"WORKSPACE.bazel": {},
}

func newBuildifierFormatter(run commandRunner) commandFormatter {
	return newCommandFormatter(
		"buildifier",
		buildifierCommand,
		isStarlarkFile,
		func(filePath string) []string {
			return []string{"-path=" + normalizePath(filePath)}
		},
		run,
	)
}

func isStarlarkFile(filePath string) bool {
	normalized := normalizePath(filePath)
	if _, matched := buildifierFilenames[path.Base(normalized)]; matched {
		return true
	}
	switch strings.ToLower(path.Ext(normalized)) {
	case ".bzl", ".bxl":
		return true
	default:
		return false
	}
}

func normalizePath(filePath string) string {
	return strings.ReplaceAll(filePath, `\`, "/")
}
