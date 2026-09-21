// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"reflect"
	"testing"
)

func TestParseFramework(t *testing.T) {
	tests := []struct {
		raw      string
		family   string
		major    int
		minor    int
		platform string
		ok       bool
	}{
		{"net11.0", "net", 11, 0, "", true},
		{"net8.0", "net", 8, 0, "", true},
		{"NET6.0-windows7.0", "net", 6, 0, "windows7.0", true},
		{".NETCoreApp5.0", "net", 5, 0, "", true},
		{".NETCoreApp,Version=v3.1", "netcoreapp", 3, 1, "", true},
		{"netcoreapp3.1", "netcoreapp", 3, 1, "", true},
		{"netstandard2.0", "netstandard", 2, 0, "", true},
		{".NETStandard2.1", "netstandard", 2, 1, "", true},
		{"net472", "netframework", 4, 72, "", true},
		{".NETFramework4.7.2", "netframework", 4, 7, "", true},
		{"net4.5", "net", 4, 5, "", false},
		{"portable-net45+win8", "", 0, 0, "", false},
		{"uap10.0", "", 0, 0, "", false},
	}
	for _, test := range tests {
		parsed, ok := parseFramework(test.raw)
		if ok != test.ok {
			t.Fatalf("parseFramework(%q) ok = %t, want %t", test.raw, ok, test.ok)
		}
		if !ok {
			continue
		}
		if parsed.family != test.family || parsed.major != test.major || parsed.minor != test.minor || parsed.platform != test.platform {
			t.Fatalf("parseFramework(%q) = %+v", test.raw, parsed)
		}
	}
}

func TestNearestPicksWhatNuGetWould(t *testing.T) {
	target, _ := parseFramework("net11.0")
	tests := []struct {
		candidates []string
		want       string
		ok         bool
	}{
		{[]string{"netstandard2.0", "net10.0", "net8.0"}, "net10.0", true},
		{[]string{"netstandard2.0", "netstandard2.1", "netcoreapp3.1"}, "netcoreapp3.1", true},
		{[]string{"netstandard2.0", "netstandard2.1"}, "netstandard2.1", true},
		{[]string{"net12.0", "netstandard2.0"}, "netstandard2.0", true},
		{[]string{"net11.0", "net11.0-windows"}, "net11.0", true},
		{[]string{"net12.0", "net472", "netstandard2.2"}, "", false},
		{nil, "", false},
	}
	for _, test := range tests {
		got, ok := nearest(target, test.candidates)
		if ok != test.ok || got != test.want {
			t.Fatalf("nearest(%v) = %q, %t; want %q, %t", test.candidates, got, ok, test.want, test.ok)
		}
	}
}

func TestParseOverrides(t *testing.T) {
	overrides, err := parseOverrides("System.Collections.Immutable|11.0.0\n\nSystem.Memory|4.5.5\n")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"system.collections.immutable": "11.0.0", "system.memory": "4.5.5"}
	got := make(map[string]string)
	for id, v := range overrides {
		got[id] = v.String()
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides = %v, want %v", got, want)
	}
	if _, err := parseOverrides("System.Memory\n"); err == nil {
		t.Fatal("a line without a version parsed")
	}
}
