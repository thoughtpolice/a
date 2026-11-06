// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"testing"
)

func message(file, text, note string) string {
	msg := map[string]any{
		"message": text,
		"code":    nil,
		"level":   "warning",
		"spans": []any{map[string]any{
			"file_name":  file,
			"byte_start": 0,
			"byte_end":   1,
			"line_start": 1,
			"line_end":   1,
			"is_primary": true,
			"expansion": map[string]any{
				"span":            map[string]any{"file_name": file},
				"def_site_span":   map[string]any{"file_name": "/abs/macro.rs"},
				"macro_decl_name": "m!",
			},
		}},
		"children": []any{map[string]any{
			"message":  note,
			"level":    "note",
			"spans":    []any{map[string]any{"file_name": file}},
			"children": []any{},
		}},
		"rendered": text + " " + note,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func TestDiagnosticsAbsolute(t *testing.T) {
	out, err := diagnostics([][]byte{[]byte(message("src/a.rs", "unused", "x") + "\n")}, "/project")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d diagnostics, want 1", len(out))
	}
	var msg struct {
		Spans []struct {
			FileName  string `json:"file_name"`
			Expansion struct {
				Span struct {
					FileName string `json:"file_name"`
				} `json:"span"`
				DefSiteSpan struct {
					FileName string `json:"file_name"`
				} `json:"def_site_span"`
			} `json:"expansion"`
		} `json:"spans"`
		Children []struct {
			Spans []struct {
				FileName string `json:"file_name"`
			} `json:"spans"`
		} `json:"children"`
	}
	if err := json.Unmarshal(out[0], &msg); err != nil {
		t.Fatal(err)
	}
	for what, got := range map[string]string{
		"span":          msg.Spans[0].FileName,
		"expansion":     msg.Spans[0].Expansion.Span.FileName,
		"child":         msg.Children[0].Spans[0].FileName,
		"def_site_span": msg.Spans[0].Expansion.DefSiteSpan.FileName,
	} {
		want := "/project/src/a.rs"
		if what == "def_site_span" {
			want = "/abs/macro.rs"
		}
		if got != want {
			t.Errorf("%s file_name = %q, want %q", what, got, want)
		}
	}
}

func TestDiagnosticsDeduplicated(t *testing.T) {
	// A library and its unit tests report the same warning, with notes that
	// name the target.
	lib := message("src/a.rs", "unused", "in lib")
	test := message("src/a.rs", "unused", "in lib-test")
	other := message("src/b.rs", "unused", "in lib")
	out, err := diagnostics([][]byte{[]byte(lib + "\n" + other + "\n"), []byte(test + "\n\n")}, "/project")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d diagnostics, want 2:\n%s", len(out), out)
	}
}

func TestDiagnosticsOther(t *testing.T) {
	line := `{"reason":"compiler-artifact"}`
	out, err := diagnostics([][]byte{[]byte(line)}, "/project")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || string(out[0]) != line {
		t.Fatalf("got %q, want %q", out, line)
	}
}
