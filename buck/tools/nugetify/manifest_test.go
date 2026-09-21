// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseManifest(t *testing.T) {
	m, err := parseManifest(strings.NewReader(`# the targeting pack
[framework]
package = "Microsoft.NETCore.App.Ref"
version = "11.0.0-rc.1.26425.128" # pinned with the toolchain

[packages]
"Mono.Cecil" = '0.11.6'
"Microsoft.CodeAnalysis.CSharp" = "5.9.0"
Newtonsoft.Json = "13.0.3"
`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Framework != (packageRef{ID: "Microsoft.NETCore.App.Ref", Version: "11.0.0-rc.1.26425.128"}) {
		t.Fatalf("framework = %+v", m.Framework)
	}
	want := []packageRef{
		{ID: "Microsoft.CodeAnalysis.CSharp", Version: "5.9.0"},
		{ID: "Mono.Cecil", Version: "0.11.6"},
		{ID: "Newtonsoft.Json", Version: "13.0.3"},
	}
	if !reflect.DeepEqual(m.Packages, want) {
		t.Fatalf("packages = %+v, want %+v", m.Packages, want)
	}
}

func TestParseManifestRejectsMistakes(t *testing.T) {
	for name, text := range map[string]string{
		"no framework":   "[packages]\n\"A\" = \"1.0\"\n",
		"unknown table":  "[framework]\npackage = \"P\"\nversion = \"1.0\"\n[extra]\n",
		"duplicate":      "[framework]\npackage = \"P\"\nversion = \"1.0\"\n[packages]\n\"A\" = \"1.0\"\n\"a\" = \"2.0\"\n",
		"bad version":    "[framework]\npackage = \"P\"\nversion = \"1.0\"\n[packages]\n\"A\" = \"one\"\n",
		"bad id":         "[framework]\npackage = \"P\"\nversion = \"1.0\"\n[packages]\n\"A/B\" = \"1.0\"\n",
		"unquoted value": "[framework]\npackage = P\nversion = \"1.0\"\n",
		"key outside":    "package = \"P\"\n",
		"unknown fw key": "[framework]\npackage = \"P\"\nversion = \"1.0\"\ntfm = \"net11.0\"\n",
		"array table":    "[[packages]]\n",
	} {
		if _, err := parseManifest(strings.NewReader(text)); err == nil {
			t.Fatalf("%s: parsed", name)
		}
	}
}
