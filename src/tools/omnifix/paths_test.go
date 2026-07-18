// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestShouldProcessFile(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "source file", path: "src/main.rs", want: true},
		{name: "file without extension", path: "README", want: true},
		{name: "nested dotfile", path: "config/.env", want: false},
		{name: "dotfile with extension", path: "config/.env.example", want: true},
		{name: "git metadata", path: ".git/HEAD", want: false},
		{name: "buck output", path: "buck-out/v2/output", want: false},
		{name: "node modules", path: "web/node_modules/pkg/index.js", want: false},
		{name: "node modules substring", path: "web/node_modules-cache/index.js", want: true},
		{name: "windows separators", path: `web\node_modules\pkg\index.js`, want: false},
		{name: "zuo generated source", path: "buck/third-party/zuo/zuo.c", want: false},
		{name: "similar work path", path: "workspace/file.txt", want: true},
		{name: "case insensitive image", path: "assets/logo.PNG", want: false},
		{name: "uppercase stage-1 source", path: "bootstrap/compiler.M1", want: false},
		{name: "lock file", path: "Cargo.lock", want: false},
		{name: "JSON data", path: "testdata/input.json", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldProcessFile(test.path); got != test.want {
				t.Fatalf("shouldProcessFile(%q) = %t, want %t", test.path, got, test.want)
			}
		})
	}
}
