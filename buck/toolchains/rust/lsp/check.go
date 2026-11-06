// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
)

// diagnostics turns the diagnostic files of a check, one rustc JSON message
// per line, into the lines rust-analyzer reads. Buck runs rustc in the
// project root, so a span's file is relative to it, and rust-analyzer wants
// it absolute. A target and its unit tests compile the same file and report
// the same diagnostic, which appears once, whatever the notes under it say.
func diagnostics(contents [][]byte, root string) ([][]byte, error) {
	var out [][]byte
	seen := map[string]bool{}
	for _, content := range contents {
		for line := range bytes.Lines(content) {
			line = bytes.TrimSpace(line)
			if len(line) == 0 {
				continue
			}
			var msg map[string]any
			if err := json.Unmarshal(line, &msg); err != nil {
				return nil, err
			}
			if _, ok := msg["message"]; !ok {
				// Pass on what is not a diagnostic, such as an artifact notification.
				out = append(out, line)
				continue
			}
			absoluteSpans(msg, root)

			key := map[string]any{}
			for k, v := range msg {
				key[k] = v
			}
			delete(key, "children")
			delete(key, "rendered")
			keyJSON, err := json.Marshal(key)
			if err != nil {
				return nil, err
			}
			if seen[string(keyJSON)] {
				continue
			}
			seen[string(keyJSON)] = true

			data, err := json.Marshal(msg)
			if err != nil {
				return nil, err
			}
			out = append(out, data)
		}
	}
	return out, nil
}

func absoluteSpans(msg map[string]any, root string) {
	if spans, ok := msg["spans"].([]any); ok {
		for _, s := range spans {
			if span, ok := s.(map[string]any); ok {
				absoluteSpan(span, root)
			}
		}
	}
	if children, ok := msg["children"].([]any); ok {
		for _, c := range children {
			if child, ok := c.(map[string]any); ok {
				absoluteSpans(child, root)
			}
		}
	}
}

func absoluteSpan(span map[string]any, root string) {
	if name, ok := span["file_name"].(string); ok && !filepath.IsAbs(name) {
		span["file_name"] = filepath.Join(root, name)
	}
	if expansion, ok := span["expansion"].(map[string]any); ok {
		for _, key := range []string{"span", "def_site_span"} {
			if s, ok := expansion[key].(map[string]any); ok {
				absoluteSpan(s, root)
			}
		}
	}
}
