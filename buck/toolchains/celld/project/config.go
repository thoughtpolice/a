// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Fragment is one celld unit's `[ide]` output, written by `celldc fragment`.
// Config is the unit's Deno config as the build writes it, except that its
// paths start with "./" and are relative to the project root.
type Fragment struct {
	Label  string         `json:"label"`
	Srcs   []string       `json:"srcs"`
	Files  []string       `json:"files"`
	Config map[string]any `json:"config"`
}

func LoadFragment(path string) (*Fragment, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var fragment Fragment
	if err := json.Unmarshal(data, &fragment); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if fragment.Label == "" {
		return nil, fmt.Errorf("%s: fragment has no label", path)
	}
	return &fragment, nil
}

func absolute(root, path string) string {
	if strings.HasPrefix(path, "./") || strings.HasPrefix(path, "../") {
		return filepath.Join(root, path)
	}
	return path
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Merge combines fragments into one Deno config with absolute paths, since
// the config lives under buck-out rather than next to the sources. It knows
// only two things about a config: `imports` is a union, and so is
// `compilerOptions.types`. Every other key comes from the first fragment that
// has it. A specifier that two fragments map to different files is reported
// through warn, and the earlier fragment wins.
func Merge(root string, fragments []*Fragment, warn func(string)) map[string]any {
	merged := map[string]any{}
	imports := map[string]string{}
	owners := map[string]string{}
	var options map[string]any
	var types []string
	seenTypes := map[string]bool{}
	for _, fragment := range fragments {
		for _, key := range sortedKeys(fragment.Config) {
			value := fragment.Config[key]
			switch key {
			case "imports":
				entries, _ := value.(map[string]any)
				for _, spec := range sortedKeys(entries) {
					target, ok := entries[spec].(string)
					if !ok {
						continue
					}
					target = absolute(root, target)
					if previous, ok := imports[spec]; ok {
						if previous != target {
							warn(fmt.Sprintf("specifier %q maps to %s in %s and to %s in %s; using the first",
								spec, previous, owners[spec], target, fragment.Label))
						}
						continue
					}
					imports[spec] = target
					owners[spec] = fragment.Label
				}
			case "compilerOptions":
				entries, _ := value.(map[string]any)
				if options == nil {
					options = map[string]any{}
					for k, v := range entries {
						if k != "types" {
							options[k] = v
						}
					}
				}
				list, _ := entries["types"].([]any)
				for _, item := range list {
					if path, ok := item.(string); ok {
						path = absolute(root, path)
						if !seenTypes[path] {
							seenTypes[path] = true
							types = append(types, path)
						}
					}
				}
			default:
				if _, ok := merged[key]; !ok {
					merged[key] = value
				}
			}
		}
	}
	if len(imports) > 0 {
		merged["imports"] = imports
	}
	if options != nil || len(types) > 0 {
		if options == nil {
			options = map[string]any{}
		}
		if len(types) > 0 {
			options["types"] = types
		}
		merged["compilerOptions"] = options
	}
	return merged
}

// WriteConfig writes config to path unless the file already holds it, and
// reports whether it wrote.
func WriteConfig(path string, config map[string]any) (bool, error) {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return false, err
	}
	data = append(data, '\n')
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, path)
}
