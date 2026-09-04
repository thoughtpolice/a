// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// A Discoverer finds the celld units that own some files (absolute paths)
// and returns their fragments.
type Discoverer interface {
	Discover(files []string) ([]*Fragment, error)
}

// BuckDiscoverer runs project.bxl. It uses its own isolation directory, and
// so its own daemon, so that it neither waits for nor interrupts the user's
// builds.
type BuckDiscoverer struct {
	Buck2        string
	Root         string
	IsolationDir string
	Script       string
}

func (d *BuckDiscoverer) Discover(files []string) ([]*Fragment, error) {
	args := []string{"--isolation-dir=" + d.IsolationDir, "bxl", d.Script, "--", "--files"}
	cmd := exec.Command(d.Buck2, append(args, files...)...)
	cmd.Dir = d.Root
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %v\n%s", d.Buck2, strings.Join(args, " "), err, tail(stderr.String(), 20))
	}
	var fragments []*Fragment
	scanner := bufio.NewScanner(&stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if !bytes.HasPrefix(line, []byte("{")) {
			continue
		}
		var unit struct {
			Label    string `json:"label"`
			Fragment string `json:"fragment"`
		}
		if err := json.Unmarshal(line, &unit); err != nil {
			return nil, err
		}
		fragment, err := LoadFragment(unit.Fragment)
		if err != nil {
			return nil, err
		}
		fragments = append(fragments, fragment)
	}
	return fragments, scanner.Err()
}

func tail(text string, lines int) string {
	all := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n")
}

// StaticDiscoverer serves fragments given up front, the way project.bxl
// would: a file's units are those listing it in their srcs, or failing that
// those with a source in the file's directory. For tests.
type StaticDiscoverer struct {
	Root      string
	Fragments []*Fragment

	mu    sync.Mutex
	calls [][]string
}

// Calls returns the file lists Discover has been asked about.
func (d *StaticDiscoverer) Calls() [][]string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([][]string(nil), d.calls...)
}

func LoadStaticDiscoverer(root string, paths []string) (*StaticDiscoverer, error) {
	d := &StaticDiscoverer{Root: root}
	for _, path := range paths {
		fragment, err := LoadFragment(path)
		if err != nil {
			return nil, err
		}
		d.Fragments = append(d.Fragments, fragment)
	}
	return d, nil
}

func (d *StaticDiscoverer) Discover(files []string) ([]*Fragment, error) {
	d.mu.Lock()
	d.calls = append(d.calls, files)
	d.mu.Unlock()
	chosen := map[string]bool{}
	var result []*Fragment
	add := func(fragment *Fragment) {
		if !chosen[fragment.Label] {
			chosen[fragment.Label] = true
			result = append(result, fragment)
		}
	}
	for _, file := range files {
		found := false
		for _, fragment := range d.Fragments {
			for _, src := range fragment.Srcs {
				if filepath.Join(d.Root, src) == file {
					add(fragment)
					found = true
				}
			}
		}
		if found {
			continue
		}
		for _, fragment := range d.Fragments {
			for _, src := range fragment.Srcs {
				if filepath.Dir(filepath.Join(d.Root, src)) == filepath.Dir(file) {
					add(fragment)
				}
			}
		}
	}
	return result, nil
}

// DefaultBuck2 prefers the repository's pinned buck2 over whatever is on PATH.
func DefaultBuck2(root string) string {
	pinned := filepath.Join(root, "buck", "bin", "buck2")
	if _, err := os.Stat(pinned); err == nil {
		return pinned
	}
	return "buck2"
}
