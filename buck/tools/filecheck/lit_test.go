// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseLitTest(t *testing.T) {
	src := `; RUN: echo one \
; RUN:   two %(line) %(line+1)
; RUN: echo %(line-1)
; REQUIRES: a, b && c
; UNSUPPORTED: d
; XFAIL: *, e
; ALLOW_RETRIES: 2
; DEFINE: %{x} = 1
; REDEFINE: %{x} = 2
; DEFINE: %{y} = %{x} \
; DEFINE:   plus
; END.
; RUN: echo ignored
`
	tt := parseLitTest("f.test", "f.test", []byte(src))
	if tt.parseErr != nil {
		t.Fatal(tt.parseErr)
	}
	wantRuns := []runLine{{line: 1, text: "echo one two 2 3"}, {line: 3, text: "echo 2"}}
	for i := range tt.runs {
		tt.runs[i].defines = nil
	}
	if !reflect.DeepEqual(tt.runs, wantRuns) {
		t.Errorf("runs = %+v, want %+v", tt.runs, wantRuns)
	}
	// A RUN line sees the DEFINEs that precede it, not later REDEFINEs.
	ordered := parseLitTest("g.test", "g.test", []byte("DEFINE: %{x} = 1\nRUN: echo %{x}\nREDEFINE: %{x} = 2\nRUN: echo %{x}\n"))
	if ordered.parseErr != nil {
		t.Fatal(ordered.parseErr)
	}
	if got := expandRunLine(ordered.runs[0].text, ordered.runs[0].defines, nil); got != "echo 1" {
		t.Errorf("first RUN expands to %q, want \"echo 1\"", got)
	}
	if got := expandRunLine(ordered.runs[1].text, ordered.runs[1].defines, nil); got != "echo 2" {
		t.Errorf("second RUN expands to %q, want \"echo 2\"", got)
	}
	if !reflect.DeepEqual(tt.requires, []string{"a", "b && c"}) || !reflect.DeepEqual(tt.unsupported, []string{"d"}) || !reflect.DeepEqual(tt.xfail, []string{"*", "e"}) {
		t.Errorf("directives = %v %v %v", tt.requires, tt.unsupported, tt.xfail)
	}
	wantDefs := []substitution{{"%{x}", "2"}, {"%{y}", "%{x} plus"}}
	if !reflect.DeepEqual(tt.defines, wantDefs) {
		t.Errorf("defines = %+v, want %+v", tt.defines, wantDefs)
	}

	for _, bad := range []string{
		"RUN: a \\\nnot a run line\n",
		"DEFINE: %{x} = 1\nDEFINE: %{x} = 2\n",
		"REDEFINE: %{x} = 1\n",
		"DEFINE: bad = 1\n",
		"RUN: a \\\n",
	} {
		if tt := parseLitTest("f.test", "f.test", []byte(bad)); tt.parseErr == nil {
			t.Errorf("parseLitTest(%q) accepted", bad)
		}
	}
}

func TestExpandRunLine(t *testing.T) {
	perTest := []substitution{{"%{a}", "A"}, {"%{b}", "%{a}B"}}
	global := []substitution{{"%tool", "/bin/tool"}, {"%t", "/tmp/t"}, {"%{d}", "D"}}
	got := expandRunLine("%tool %t %{b} %{d} 100%%", perTest, global)
	want := "/bin/tool /tmp/t AB D 100%"
	if got != want {
		t.Errorf("expandRunLine = %q, want %q", got, want)
	}
}

func TestProjectRootFromPath(t *testing.T) {
	root := projectRootFromPath("/repo/buck-out/v2/gen/root/abc/pkg/__t__/manifest.json")
	if root != "/repo" {
		t.Errorf("projectRootFromPath = %q", root)
	}
	if got := projectRootFromPath("/no/buck/out/here"); got != "" {
		t.Errorf("projectRootFromPath without buck-out = %q", got)
	}
}

func writeLitFixture(t *testing.T, dir string) (files []string) {
	t.Helper()
	write := func(name, content string) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, p)
	}
	write("pass.test", "// RUN: echo hi | FileCheck %s\n// RUN: echo %{who} | FileCheck %s --check-prefix=WHO\n// CHECK: hi\n// WHO: world\n")
	write("fail.test", "// RUN: echo hi\n// RUN: echo bye | FileCheck %s\n// RUN: echo never\n// CHECK: hi\n")
	write("skip.test", "// UNSUPPORTED: fixture\n// RUN: false\n")
	write("xfail.test", "// XFAIL: fixture\n// RUN: false\n")
	write("xpass.test", "// XFAIL: *\n// RUN: true\n")
	write("norun.test", "// CHECK: nothing\n")
	return files
}

func TestRunLitProtocol(t *testing.T) {
	dir := t.TempDir()
	files := writeLitFixture(t, dir)
	manifest := filepath.Join(dir, "manifest.json")
	os.WriteFile(manifest, []byte(`{"tools": {}, "defines": {"who": "world"}, "features": ["fixture"], "package": "`+filepath.ToSlash(dir)+`"}`), 0o644)

	var stdout, stderr bytes.Buffer
	inv := invocation{protocolMode: "-list-tests", stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr}
	argv := append([]string{"--manifest", manifest}, files...)
	if status := runLit(inv, argv); status != 0 {
		t.Fatalf("list: status %d\n%s", status, stderr.String())
	}
	// The filter is the file's index; a listing line carries it and the name.
	listing := stdout.String()
	for i, f := range files {
		if !strings.Contains(listing, fmt.Sprintf("test: %d %s\n", i, filepath.Base(f))) {
			t.Errorf("listing lacks %s:\n%s", f, listing)
		}
	}

	run := func(filter string) (int, string) {
		var out, errOut bytes.Buffer
		inv := invocation{protocolMode: "-run-test", stdin: strings.NewReader(""), stdout: &out, stderr: &errOut}
		status := runLit(inv, append(append([]string{"--manifest", manifest}, files...), filter))
		return status, out.String()
	}
	for _, filter := range []string{"0", "pass.test"} {
		status, out := run(filter)
		if status != 0 || !strings.Contains(out, "result: PASS pass.test:1 ") || !strings.Contains(out, "result: PASS pass.test:2 ") || !strings.Contains(out, "result: PASS pass.test ") {
			t.Errorf("pass (filter %q): %d\n%s", filter, status, out)
		}
	}
	status, out := run("1")
	if status != 1 || !strings.Contains(out, "result: PASS fail.test:1 ") || !strings.Contains(out, "result: FAIL fail.test:2 ") ||
		!strings.Contains(out, "result: SKIP fail.test:3 - not run") || !strings.Contains(out, "result: FAIL fail.test ") ||
		!strings.Contains(out, "result-details: Script:") || !strings.Contains(out, "result-details: Exit Code: 1") {
		t.Errorf("fail: %d\n%s", status, out)
	}
	status, out = run("2")
	if status != 0 || !strings.Contains(out, "result: SKIP skip.test - unsupported: fixture") {
		t.Errorf("skip: %d\n%s", status, out)
	}
	status, out = run("3")
	if status != 0 || !strings.Contains(out, "result: PASS xfail.test ") || !strings.Contains(out, "expected failure") || strings.Contains(out, "xfail.test:2") {
		t.Errorf("xfail: %d\n%s", status, out)
	}
	status, out = run("4")
	if status != 1 || !strings.Contains(out, "result: FAIL xpass.test ") || !strings.Contains(out, "unexpectedly passed") {
		t.Errorf("xpass: %d\n%s", status, out)
	}
	status, out = run("5")
	if status != 1 || !strings.Contains(out, "result: FAIL norun.test ") || !strings.Contains(out, "no RUN: lines") {
		t.Errorf("norun: %d\n%s", status, out)
	}
	for _, filter := range []string{"nonexistent", "6", "-1"} {
		if status, _ := run(filter); status != 2 {
			t.Errorf("unknown filter %q: status %d", filter, status)
		}
	}
}

func TestRunLitBatch(t *testing.T) {
	dir := t.TempDir()
	files := writeLitFixture(t, dir)
	var stdout, stderr bytes.Buffer
	inv := invocation{stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr}
	argv := append([]string{"--define", "who=world", "--feature", "fixture", "--package", dir}, files...)
	status := runLit(inv, argv)
	out := stdout.String()
	if status != 1 {
		t.Errorf("batch status = %d\n%s", status, out)
	}
	for _, w := range []string{"PASS: " + dir + " :: pass.test (1 of 6)", "FAIL: " + dir + " :: fail.test (2 of 6)", "UNSUPPORTED: ", "XFAIL: ", "XPASS: ", "UNRESOLVED: ",
		"Script:", "Command Output (stderr):", "Passed              : 1", "Failed              : 1", "Unexpectedly Passed : 1"} {
		if !strings.Contains(out, w) {
			t.Errorf("batch output lacks %q:\n%s", w, out)
		}
	}
}

func TestParseLitArgs(t *testing.T) {
	a, err := parseLitArgs([]string{"--tool", "t=/bin/t", "-Dx=1", "--define", "y=2", "--feature", "f", "--env", "K=V", "--package", "p", "-v", "--keep-tmp", "a.test", "b.test"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a.tools, map[string][]string{"t": {"/bin/t"}}) || !reflect.DeepEqual(a.defines, map[string]string{"x": "1", "y": "2"}) ||
		!reflect.DeepEqual(a.features, []string{"f"}) || a.env["K"] != "V" || a.pkg != "p" || !a.verbose || !a.keepTmp ||
		!reflect.DeepEqual(a.files, []string{"a.test", "b.test"}) {
		t.Errorf("args = %+v", a)
	}
	if _, err := parseLitArgs([]string{"--tool", "novalue"}); err == nil {
		t.Errorf("--tool without '=' accepted")
	}
}

func TestLoadManifestTools(t *testing.T) {
	dir := t.TempDir()
	manifest := filepath.Join(dir, "m.json")
	os.WriteFile(manifest, []byte(`{"tools": {"a": ["/bin/a"], "b": ["/usr/bin/python", "b.py"]}, "package": "pkg"}`), 0o644)
	a := &litArgs{manifest: manifest, tools: map[string][]string{}, defines: map[string]string{}, env: map[string]string{}}
	if err := a.loadManifest(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a.tools["a"], []string{"/bin/a"}) || !reflect.DeepEqual(a.tools["b"], []string{"/usr/bin/python", "b.py"}) || a.pkg != "pkg" {
		t.Errorf("manifest = %+v", a)
	}
	for _, bad := range []string{`{"tools": {"a": []}}`, `{"tools": {"a": "/bin/a"}}`} {
		os.WriteFile(manifest, []byte(bad), 0o644)
		if err := a.loadManifest(); err == nil {
			t.Errorf("manifest %s accepted", bad)
		}
	}
}

// The project root is where the manifest's buck-out sits, whatever the
// current directory is.
func TestLoadManifestProjectRoot(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "buck-out", "v2", "gen", "pkg", "__tests__")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "manifest.json")
	data, err := json.Marshal(map[string]any{
		"tools":   map[string][]string{"t": {projectRootMarker + "bin/t", "--data=" + projectRootMarker + "data/x"}},
		"defines": map[string]string{"input": projectRootMarker + "inputs/a.txt", "plain": "value"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifest, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	a, err := parseLitArgs([]string{"--manifest", manifest, "--define", "plain=override"})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.loadManifest(); err != nil {
		t.Fatal(err)
	}
	slash := filepath.ToSlash(root) + "/"
	wantTool := []string{slash + "bin/t", "--data=" + slash + "data/x"}
	if a.root != root || !reflect.DeepEqual(a.tools["t"], wantTool) || a.defines["input"] != slash+"inputs/a.txt" || a.defines["plain"] != "override" {
		t.Errorf("root = %q, tools = %q, defines = %q", a.root, a.tools, a.defines)
	}
}

func TestManifestArtifactPathsSurviveCd(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "project with spaces")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	input := "input with spaces.txt"
	if err := os.WriteFile(input, []byte("artifact data\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "manifest.json")
	data, err := json.Marshal(map[string]any{
		"tools": map[string][]string{
			"reader": {"cat", projectRootMarker + input},
			"args":   {"tool-name", "--input=" + projectRootMarker + input, "literal/path", "ordinary value"},
		},
		"defines": map[string]string{"input": projectRootMarker + input},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifest, data, 0o644); err != nil {
		t.Fatal(err)
	}
	a, err := parseLitArgs([]string{"--manifest", manifest})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.loadManifest(); err != nil {
		t.Fatal(err)
	}
	want := []string{"tool-name", "--input=" + filepath.ToSlash(filepath.Join(dir, input)), "literal/path", "ordinary value"}
	if !reflect.DeepEqual(a.tools["args"], want) {
		t.Errorf("tool arguments = %q, want %q", a.tools["args"], want)
	}
	r := litRunner{cwd: dir, tools: a.tools, defines: a.defines}
	test := parseLitTest("reader.test", "reader.test", []byte("RUN: cd %T && %reader\nRUN: cd %T && cat \"%{input}\"\n"))
	res := r.runTest(test)
	if res.status != "PASS" {
		t.Fatalf("status = %s\n%s", res.status, res.details(true))
	}
	for i := range res.runs {
		if got := res.runs[i].stdout; got != "artifact data\n" {
			t.Errorf("RUN %d output = %q", i, got)
		}
	}
}

func TestRedefinePreservesDependentSubstitutions(t *testing.T) {
	src := `DEFINE: %{x} = one
DEFINE: %{y} = %{x}
RUN: echo %{y}
REDEFINE: %{x} = two \
REDEFINE: more
RUN: echo %{y}
RUN: echo %{x}
`
	r := litRunner{cwd: t.TempDir()}
	res := r.runTest(parseLitTest("redefine.test", "redefine.test", []byte(src)))
	if res.status != "PASS" {
		t.Fatalf("status = %s\n%s", res.status, res.details(true))
	}
	for i, want := range []string{"one\n", "two more\n", "two more\n"} {
		if got := res.runs[i].stdout; got != want {
			t.Errorf("RUN %d output = %q, want %q", i, got, want)
		}
	}
}

func TestLitSyntaxErrorsAreUnresolved(t *testing.T) {
	for _, prefix := range []string{"", "XFAIL: *\n"} {
		for _, command := range []string{`echo "unterminated`, "echo hi |", "echo hi >"} {
			t.Run(prefix+command, func(t *testing.T) {
				r := litRunner{cwd: t.TempDir()}
				// Syntax is checked before execution, even when an earlier RUN
				// would fail and otherwise hide the invalid command.
				src := prefix + "RUN: false\nRUN: " + command + "\n"
				res := r.runTest(parseLitTest("syntax.test", "syntax.test", []byte(src)))
				if res.status != "UNRESOLVED" || len(res.runs) != 0 || !strings.Contains(res.message, "shell parser error") {
					t.Fatalf("result = %+v", res)
				}
				var out bytes.Buffer
				if status := emitProtocolResults(&out, res); status != 1 || !strings.Contains(out.String(), "result: FAIL syntax.test ") {
					t.Errorf("protocol status = %d\n%s", status, out.String())
				}
			})
		}
	}
}

func TestLitIntrinsicTrueFeature(t *testing.T) {
	for _, tc := range []struct{ directive, status string }{
		{"REQUIRES: true", "FAIL"},
		{"REQUIRES: !true", "UNSUPPORTED"},
		{"REQUIRES: {{tr.*}}", "FAIL"},
		{"UNSUPPORTED: true", "UNSUPPORTED"},
		{"XFAIL: true", "XFAIL"},
	} {
		t.Run(tc.directive, func(t *testing.T) {
			r := litRunner{cwd: t.TempDir()}
			test := parseLitTest("true.test", "true.test", []byte(tc.directive+"\nRUN: false\n"))
			if res := r.runTest(test); res.status != tc.status {
				t.Errorf("status = %s, want %s\n%s", res.status, tc.status, res.details(true))
			}
		})
	}
}
