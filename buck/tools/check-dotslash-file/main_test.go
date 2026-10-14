// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func runTool(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(t.Context(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestCheckShim(t *testing.T) {
	dir := t.TempDir()
	shim := bytes.Repeat([]byte("MZ"), shimSize/2)
	valid := []string{sha256Hex([]byte("an older shim")), sha256Hex(shim)}
	for _, tc := range []struct {
		name, want string
		data       []byte
	}{
		{"ok", "", shim},
		{"size", "is 4095 bytes, not the shim's 4096", shim[1:]},
		{"hash", "which is not a known shim", bytes.Repeat([]byte("ZM"), shimSize/2)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".exe")
			writeFile(t, path, tc.data)
			var out bytes.Buffer
			err := checkShim(path, valid, &out)
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Errorf("got %v, want %q\n%s", err, tc.want, out.String())
			}
		})
	}
}

// A relative path is relative to the repository root, and the extension
// picks the check.
func TestRun(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".buckroot"), nil)
	data := []byte("artifact")
	srv := serveFiles(t, map[string][]byte{"/a": data})
	tool := writeDotslash(t, map[string]any{"linux-x86_64": entry(srv.URL+"/a", data)})
	contents, err := os.ReadFile(tool)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "bin", "tool"), contents)
	writeFile(t, filepath.Join(root, "bin", "tool.exe"), make([]byte, shimSize))
	writeFile(t, filepath.Join(root, "sub", "dir", "file"), nil)
	t.Chdir(filepath.Join(root, "sub", "dir"))

	if code, stdout, stderr := runTool(t, "bin/tool"); code != 0 || !strings.Contains(stdout, "linux-x86_64: ✓") {
		t.Errorf("bin/tool: exit %d\n%s%s", code, stdout, stderr)
	}
	if code, stdout, stderr := runTool(t, "bin/tool.exe"); code != 1 || !strings.Contains(stderr, "not a known shim") {
		t.Errorf("bin/tool.exe: exit %d\n%s%s", code, stdout, stderr)
	}
	for _, tc := range []struct {
		args []string
		code int
		want string
	}{
		{nil, 2, "usage:"},
		{[]string{"bin/tool", "bin/tool.exe"}, 2, "usage:"},
		{[]string{"bin/missing"}, 1, "no such file"},
		{[]string{"bin"}, 1, "is not a file"},
		{[]string{"file"}, 1, "no such file"},
	} {
		if code, _, stderr := runTool(t, tc.args...); code != tc.code || !strings.Contains(stderr, tc.want) {
			t.Errorf("%q: exit %d, want %d and %q\n%s", tc.args, code, tc.code, tc.want, stderr)
		}
	}

	// Not another temporary directory: under buck2 test those are in
	// buck-out, inside the repository.
	t.Chdir("/")
	if code, _, stderr := runTool(t, "bin/tool"); code != 1 || !strings.Contains(stderr, "no .buckroot") {
		t.Errorf("outside the repository: exit %d\n%s", code, stderr)
	}
}
