// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var year = fmt.Sprint(copyrightYear)

func header(prefix, suffix string) string {
	return prefix + " SPDX-FileCopyrightText: © 2024-" + year + " Austin Seipp" + suffix + "\n" +
		prefix + " SPDX-License-Identifier: Apache-2.0" + suffix + "\n"
}

func TestSPDX(t *testing.T) {
	for _, tc := range []struct {
		name, path, data string
		want             string // a substring of the one problem, or "" for none
	}{
		{"rust", "src/a.rs", header("//", "") + "fn main() {}\n", ""},
		{"starlark build file", "src/BUILD", header("#", ""), ""},
		{"bare year", "a.py", "# SPDX-FileCopyrightText: © " + year + " Someone\n# SPDX-License-Identifier: MIT\n", ""},
		{"two copyright lines", "a.go", "// SPDX-FileCopyrightText: © " + year + " A\n// SPDX-FileCopyrightText: © " + year + " B\n// SPDX-License-Identifier: ISC\n", ""},
		{"compound license", "a.c", "// SPDX-FileCopyrightText: © " + year + " A\n// SPDX-License-Identifier: MIT OR Apache-2.0\n", ""},
		{"block comment", "a.css", header("/*", " */"), ""},
		{"ocaml", "a.ml", header("(*", " *)"), ""},
		{"html after doctype", "a.html", "<!DOCTYPE html>\n" + header("<!--", " -->"), ""},
		{"xml block", "x/dbus-minimos-deny.conf", "<!--\n  SPDX-FileCopyrightText: © " + year + " A\n  SPDX-License-Identifier: MIT\n-->\n", ""},
		{"file name entry", "etc/group", header("#", ""), ""},
		{"bare file name entry", "hosts", header("#", ""), ""},
		{"lit file in a second style", "t/x.test", header(";", ""), ""},
		{"shebang", "tool", "#!/bin/sh\necho hi\n", ""},
		{"document", "README.md", "# hello\n", ""},
		{"license text", "x/LICENSE", "Apache License\n", ""},
		{"no extension", "buck/mode/local", "--config=x=y\n", ""},
		{"account database", "config/passwd", "root:x:0:0::/root:/bin/sh\n", ""},
		{"generated starlark", "BUILD.generated.bzl", "x = 1\n", ""},
		{"cargo manifest", "a/Cargo.toml", "[package]\n", ""},
		{"binary", "logo.png", "\x89PNG\x00\x01", ""},

		{"missing", "a.rs", "fn main() {}\n", "missing SPDX copyright header"},
		{"empty", "a.rs", "", "missing SPDX copyright header"},
		{"wrong style", "a.rs", header("#", ""), "missing SPDX copyright header"},
		{"stale year", "a.rs", "// SPDX-FileCopyrightText: © 2024-2025 A\n// SPDX-License-Identifier: MIT\n", "incorrect copyright year \"2024-2025\""},
		{"no license line", "a.rs", "// SPDX-FileCopyrightText: © " + year + " A\n", "missing SPDX license header"},
		{"bad license line", "a.rs", "// SPDX-FileCopyrightText: © " + year + " A\nfn main() {}\n", "expected SPDX license header"},
		{"bad license", "a.rs", "// SPDX-FileCopyrightText: © " + year + " A\n// SPDX-License-Identifier: GPL-3.0\n", "unsupported license \"GPL-3.0\""},
		{"unknown language", "a.zig", "const x = 1;\n", ""},
		{"html without doctype header", "a.html", "<!DOCTYPE html>\n<html>\n", "missing SPDX copyright header"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := spdxProblems(tc.path, []byte(tc.data))
			checkProblems(t, got, tc.want)
		})
	}
}

func TestWhitespace(t *testing.T) {
	for _, tc := range []struct {
		name, path, data string
		want             []int // lines with problems
	}{
		{"clean", "a.rs", "a\nb\n", nil},
		{"empty", "a.rs", "", nil},
		{"crlf", "a.rs", "a\r\nb\r\n", nil},
		{"trailing space", "a.rs", "a \nb\n", []int{1}},
		{"trailing tab and nbsp", "a.rs", "a\nb\t\nc \n", []int{2, 3}},
		{"no final newline", "a.rs", "a\nb", []int{2}},
		{"both", "a.rs", "a \nb", []int{1, 2}},
		{"skipped extension", "a.JSON", "{} ", nil},
		{"binary", "a.dat", "x \x00 ", nil},
		{"dotfile has no extension", ".envrc", "x ", []int{1, 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := whitespaceProblems(tc.path, []byte(tc.data))
			var lines []int
			for _, p := range got {
				lines = append(lines, p.Line)
			}
			if fmt.Sprint(lines) != fmt.Sprint(tc.want) {
				t.Errorf("problems on lines %v, want %v: %v", lines, tc.want, got)
			}
		})
	}
}

func checkProblems(t *testing.T, got []problem, want string) {
	t.Helper()
	if want == "" {
		if len(got) != 0 {
			t.Errorf("unexpected problems: %v", got)
		}
		return
	}
	if len(got) != 1 || !strings.Contains(got[0].Message, want) {
		t.Errorf("got %v, want one problem containing %q", got, want)
	}
}

// TestCheckAndReport runs the two steps a srclint test takes, over files in a
// temporary directory standing in for the project root.
func TestCheckAndReport(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	write := func(name, data string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("good.rs", header("//", ""))
	// The load check has no exclusion, so it runs with the other two off.
	write("BUILD", header("#", "")+"load(\"//a/b.bzl\", \"c\")\n")
	write("bad.rs", "fn main() {} \n")
	// Excluded from the SPDX check only, as with vendored source.
	write("vendored.rs", "fn main() {} \n")
	m := manifest{Label: "root//pkg:t", Files: []manifestFile{
		{Path: "good.rs", SPDX: true, Whitespace: true},
		{Path: "bad.rs", SPDX: true, Whitespace: true},
		{Path: "vendored.rs", SPDX: false, Whitespace: true},
		{Path: "BUILD", SPDX: false, Whitespace: false},
	}}
	data, _ := json.Marshal(m)
	write("manifest.json", string(data))

	var stderr bytes.Buffer
	if code := run([]string{"check", "--manifest", "manifest.json", "--out", "report.json"}, &stderr, &stderr); code != 0 {
		t.Fatalf("check exited %d: %s", code, stderr.String())
	}
	var stdout bytes.Buffer
	if code := run([]string{"report", "report.json"}, &stdout, &stderr); code != 1 {
		t.Fatalf("report exited %d, want 1: %s%s", code, stdout.String(), stderr.String())
	}
	want := strings.Join([]string{
		"BUILD:3: [load] load(\"//a/b.bzl\", ...) names a file path; write it as load(\"//a:b.bzl\", ...)",
		"bad.rs:1: [spdx] missing SPDX copyright header \"// SPDX-FileCopyrightText: ©\"",
		"bad.rs:1: [whitespace] trailing whitespace",
		"vendored.rs:1: [whitespace] trailing whitespace",
		"srclint: checked 4 files of root//pkg:t; found 4 problems",
		"",
	}, "\n")
	if stdout.String() != want {
		t.Errorf("report printed\n%s\nwant\n%s", stdout.String(), want)
	}

	// The same files named directly, with nothing wrong.
	stdout.Reset()
	if code := run([]string{"good.rs"}, &stdout, &stderr); code != 0 {
		t.Errorf("direct check exited %d: %s", code, stdout.String())
	}
	if got := stdout.String(); got != "srclint: checked 1 files; no problems\n" {
		t.Errorf("direct check printed %q", got)
	}

	// A file the build named but that is not there is the tool's failure,
	// not the file's.
	write("manifest.json", `{"files": [{"path": "gone.rs", "spdx": true}]}`)
	stderr.Reset()
	if code := run([]string{"check", "--manifest", "manifest.json", "--out", "report.json"}, &stderr, &stderr); code != 1 {
		t.Errorf("check of a missing file exited %d, want 1", code)
	}
}
