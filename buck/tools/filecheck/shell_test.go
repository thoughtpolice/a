// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLexShell(t *testing.T) {
	toks, err := lexShell(`echo 'a b' "c \"d\"" e\ f 2>&1 | not grep x >out && true || false; :`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, tk := range toks {
		switch tk.kind {
		case tokWord:
			got = append(got, "W:"+tk.text)
		case tokRedirect:
			got = append(got, "R:"+string(rune('0'+tk.fd))+tk.op)
		default:
			got = append(got, tk.text)
		}
	}
	want := []string{"W:echo", "W:a b", `W:c "d"`, "W:e f", "R:2>&", "W:1", "|", "W:not", "W:grep", "W:x", "R:1>", "W:out", "&&", "W:true", "||", "W:false", ";", "W::"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tokens = %q\nwant     %q", got, want)
	}
	for _, bad := range []string{"echo 'unterminated", `echo "unterminated`, "a & b", "cat << EOF"} {
		if _, err := lexShell(bad); err == nil {
			t.Errorf("lexShell(%q) accepted", bad)
		}
	}
}

func TestParseShell(t *testing.T) {
	list, err := parseShell("FOO=1 a b | c > out; d && e")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[1].op != ";" || list[2].op != "&&" {
		t.Fatalf("list = %+v", list)
	}
	pl := list[0].pl
	if len(pl.commands) != 2 || !reflect.DeepEqual(pl.commands[0].assigns, []string{"FOO=1"}) || !reflect.DeepEqual(pl.commands[0].args, []string{"a", "b"}) {
		t.Errorf("first pipeline = %+v", pl.commands[0])
	}
	if len(pl.commands[1].redirects) != 1 || pl.commands[1].redirects[0].target != "out" {
		t.Errorf("redirect = %+v", pl.commands[1].redirects)
	}
	for _, bad := range []string{"a |", "| a", "a &&", "a > "} {
		if _, err := parseShell(bad); err == nil {
			t.Errorf("parseShell(%q) accepted", bad)
		}
	}
}

func runShell(t *testing.T, sh *shell, line string) (int, string, string) {
	t.Helper()
	var out, errOut lockedBuffer
	status, err := sh.run(line, &out, &errOut)
	if err != nil {
		return status, out.String(), errOut.String() + "\nERROR: " + err.Error()
	}
	return status, out.String(), errOut.String()
}

func TestShellBuiltins(t *testing.T) {
	dir := t.TempDir()
	sh := newShell(dir, map[string]string{"SHELLTEST": "yes"})

	status, out, _ := runShell(t, sh, `echo -n hello; echo " world"`)
	if status != 0 || out != "hello world\n" {
		t.Errorf("echo: %d %q", status, out)
	}
	status, out, _ = runShell(t, sh, `echo -e 'a\tb'`)
	if status != 0 || out != "a\tb\n" {
		t.Errorf("echo -e: %d %q", status, out)
	}
	status, _, _ = runShell(t, sh, `mkdir sub && cd sub && echo inner > f.txt`)
	if status != 0 {
		t.Fatalf("mkdir/cd: %d", status)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "sub", "f.txt")); err != nil || string(data) != "inner\n" {
		t.Errorf("redirect relative to cd: %q %v", data, err)
	}
	status, out, _ = runShell(t, sh, `cat f.txt f.txt`)
	if status != 0 || out != "inner\ninner\n" {
		t.Errorf("cat: %d %q", status, out)
	}
	status, out, _ = runShell(t, sh, `echo x >> f.txt && cat f.txt | count 2`)
	if status != 0 {
		t.Errorf("append/count: %d %q", status, out)
	}
	status, _, errOut := runShell(t, sh, `cat f.txt | count 5`)
	if status == 0 || !strings.Contains(errOut, "expected 5 lines, got 2") {
		t.Errorf("count mismatch: %d %q", status, errOut)
	}
	status, _, _ = runShell(t, sh, `rm f.txt && not cat f.txt 2>/dev/null`)
	if status != 0 {
		t.Errorf("rm/not: %d", status)
	}
	status, _, _ = runShell(t, sh, `cd .. && rm sub`)
	if status == 0 {
		t.Errorf("rm on a directory without -r succeeded")
	}
	status, _, _ = runShell(t, sh, `rm -rf sub && rm -f missing`)
	if status != 0 {
		t.Errorf("rm -rf: %d", status)
	}
	status, out, _ = runShell(t, sh, `env`)
	if status != 0 || !strings.Contains(out, "SHELLTEST=yes\n") {
		t.Errorf("env: %d %q", status, out)
	}
	status, out, _ = runShell(t, sh, `export EXPORTED=1; env | cat`)
	if status != 0 || !strings.Contains(out, "EXPORTED=1\n") {
		t.Errorf("export: %d %q", status, out)
	}
	status, out, _ = runShell(t, sh, `env -u SHELLTEST X=1 env`)
	if status != 0 || strings.Contains(out, "SHELLTEST=") || !strings.Contains(out, "X=1\n") {
		t.Errorf("env -u: %d %q", status, out)
	}
	status, _, _ = runShell(t, sh, `false || true`)
	if status != 0 {
		t.Errorf("||: %d", status)
	}
	status, _, _ = runShell(t, sh, `true && false`)
	if status != 1 {
		t.Errorf("&&: %d", status)
	}
	status, _, _ = runShell(t, sh, `false; true`)
	if status != 0 {
		t.Errorf(";: %d", status)
	}
	status, _, _ = runShell(t, sh, `not not false`)
	if status != 1 {
		t.Errorf("not not: %d", status)
	}
	status, _, _ = runShell(t, sh, `false | true`)
	if status != 1 {
		t.Errorf("pipefail: %d", status)
	}
	status, _, errOut = runShell(t, sh, `echo a | cd sub`)
	if status == 0 || !strings.Contains(errOut, "cannot be part of a pipeline") {
		t.Errorf("cd in pipeline: %d %q", status, errOut)
	}
	status, _, errOut = runShell(t, sh, `no-such-command-xyz`)
	if status == 0 || !strings.Contains(errOut, "command not found") {
		t.Errorf("missing command: %d %q", status, errOut)
	}
}

// Subprocesses use the Buck-built test binary so environment tests do not
// depend on an external shell or utilities being present on PATH.
func TestShellSubprocessHelper(t *testing.T) {
	switch os.Getenv("FILECHECK_SHELL_HELPER") {
	case "path":
		exe, err := os.Executable()
		if err != nil {
			os.Exit(2)
		}
		fmt.Printf("%s|%s\n", filepath.Base(filepath.Dir(exe)), os.Getenv("PATH"))
	case "env":
		value, present := os.LookupEnv("SHELLTEST")
		fmt.Printf("%t:%s\n", present, value)
	default:
		return
	}
	os.Exit(0)
}

func TestShellEffectivePath(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	one, two := filepath.Join(dir, "one"), filepath.Join(dir, "two")
	name := "shell-path-helper" + filepath.Ext(exe)
	for _, binDir := range []string{one, two} {
		if err := os.Mkdir(binDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(binDir, name), data, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", one)
	command := shellQuote(name) + " -test.run=^TestShellSubprocessHelper$"
	for _, tc := range []struct {
		name string
		path string
		line string
		want string
	}{
		{"shell environment", two, command, "two|" + two + "\n"},
		{"export", one, "export PATH=" + shellQuote(two) + "; " + command, "two|" + two + "\n"},
		{"assignment", one, "PATH=" + shellQuote(two) + " " + command + "; " + command, "two|" + two + "\none|" + one + "\n"},
		{"env", one, "env PATH=" + shellQuote(two) + " " + command + "; " + command, "two|" + two + "\none|" + one + "\n"},
		{"relative directory", one, "PATH=two " + command, "two|two\n"},
		{"empty path", one, "cd two; PATH='' " + command, "two|\n"},
		{"empty entry", one, "cd two; PATH=" + shellQuote(string(os.PathListSeparator)+one) + " " + command, "two|" + string(os.PathListSeparator) + one + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sh := newShell(dir, map[string]string{"PATH": tc.path, "FILECHECK_SHELL_HELPER": "path"})
			status, out, errOut := runShell(t, sh, tc.line)
			if status != 0 || out != tc.want {
				t.Fatalf("status=%d output=%q stderr=%q, want output=%q", status, out, errOut, tc.want)
			}
		})
	}
	for _, prefix := range []string{"env -u PATH", "PATH=" + shellQuote(filepath.Join(dir, "missing"))} {
		sh := newShell(dir, map[string]string{"FILECHECK_SHELL_HELPER": "path"})
		status, _, errOut := runShell(t, sh, prefix+" "+command)
		if status != 127 || !strings.Contains(errOut, "command not found") {
			t.Errorf("%s used the parent PATH: status=%d stderr=%q", prefix, status, errOut)
		}
	}
}

func TestShellEnvUnset(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := shellQuote(exe) + " -test.run=^TestShellSubprocessHelper$"
	sh := newShell(t.TempDir(), map[string]string{"SHELLTEST": "original", "FILECHECK_SHELL_HELPER": "env"})
	for _, tc := range []struct {
		prefix string
		want   string
	}{
		{"env -u SHELLTEST", "false:\n"},
		{"env -uSHELLTEST", "false:\n"},
		{"SHELLTEST=override env -u SHELLTEST", "false:\n"},
		{"env -u SHELLTEST env SHELLTEST=again", "true:again\n"},
		{"env SHELLTEST=", "true:\n"},
	} {
		status, out, errOut := runShell(t, sh, tc.prefix+" "+command)
		if status != 0 || out != tc.want {
			t.Errorf("%s: status=%d output=%q stderr=%q, want %q", tc.prefix, status, out, errOut, tc.want)
		}
	}
	for _, prefix := range []string{"env -u SHELLTEST", "env -uSHELLTEST"} {
		status, out, errOut := runShell(t, sh, prefix)
		if status != 0 || strings.Contains(out, "SHELLTEST=") {
			t.Errorf("%s: status=%d stderr=%q; unset variable remains in printed environment", prefix, status, errOut)
		}
	}
	status, out, errOut := runShell(t, sh, command)
	if status != 0 || out != "true:original\n" {
		t.Fatalf("env changed persistent environment: status=%d output=%q stderr=%q", status, out, errOut)
	}
}

func TestShellPersistentBuiltinRedirects(t *testing.T) {
	dir := t.TempDir()
	sh := newShell(dir, nil)
	for _, line := range []string{"cd . > cd.out", "export SHELLTEST=exported > export.out", "SHELLTEST=assigned > assign.out"} {
		status, _, errOut := runShell(t, sh, line)
		if status != 0 {
			t.Fatalf("%s: status=%d stderr=%q", line, status, errOut)
		}
	}
	for _, name := range []string{"cd.out", "export.out", "assign.out"} {
		if data, err := os.ReadFile(filepath.Join(dir, name)); err != nil || len(data) != 0 {
			t.Errorf("redirect %s: data=%q error=%v", name, data, err)
		}
	}
	for _, builtin := range []string{"cd missing", "export invalid"} {
		status, _, errOut := runShell(t, sh, builtin+" 2> errors.out")
		data, err := os.ReadFile(filepath.Join(dir, "errors.out"))
		if status != 1 || errOut != "" || err != nil || len(data) == 0 {
			t.Errorf("%s: status=%d stderr=%q redirected=%q error=%v", builtin, status, errOut, data, err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, builtin := range []string{"cd sub", "export SHELLTEST=changed", "SHELLTEST=changed"} {
		status, _, _ := runShell(t, sh, builtin+" > missing/out")
		if status == 0 || sh.cwd != dir || sh.env["SHELLTEST"] != "assigned" {
			t.Errorf("failed redirect executed %s: status=%d cwd=%q variable=%q", builtin, status, sh.cwd, sh.env["SHELLTEST"])
		}
	}
	status, _, errOut := runShell(t, sh, "cd sub > before-cd.out")
	if _, err := os.Stat(filepath.Join(dir, "before-cd.out")); status != 0 || err != nil {
		t.Errorf("cd redirect resolved after changing directories: status=%d stderr=%q error=%v", status, errOut, err)
	}
}

func TestShellNotEnv(t *testing.T) {
	sh := newShell(t.TempDir(), nil)
	for _, tc := range []struct {
		line string
		want int
	}{
		{"not env", 1},
		{"not env SHELLTEST=value", 1},
		{"not env -u SHELLTEST", 1},
		{"not not env", 0},
		{"env not env", 1},
		{"not env not env", 0},
		{"not env | cat", 1},
		{"not env false", 0},
		{"not env true", 1},
	} {
		status, _, errOut := runShell(t, sh, tc.line)
		if status != tc.want || errOut != "" {
			t.Errorf("%s: status=%d stderr=%q, want %d", tc.line, status, errOut, tc.want)
		}
	}
}

func TestShellFileCheckEnvironmentOptions(t *testing.T) {
	dir := t.TempDir()
	for name, data := range map[string]string{
		"alt.txt":   "ALT: hello\n",
		"check.txt": "CHECK: hello\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name string
		opts string
		line string
	}{
		{"shell environment", "--check-prefix=ALT", "echo hello | FileCheck alt.txt"},
		{"export", "", "export FILECHECK_OPTS=--check-prefix=ALT; echo hello | FileCheck alt.txt"},
		{"assignment", "", "echo hello | FILECHECK_OPTS=--check-prefix=ALT FileCheck alt.txt"},
		{"env assignment", "--check-prefix=MISSING", "echo hello | env FILECHECK_OPTS=--check-prefix=ALT FileCheck alt.txt"},
		{"unset", "--check-prefix=ALT", "echo hello | env -u FILECHECK_OPTS FileCheck check.txt"},
		{"quoted options", `--check-prefix=ALT "--implicit-check-not=bad word"`, "echo hello | FileCheck alt.txt"},
		{"command option precedence", "--ignore-case=true", "echo HELLO | not FileCheck check.txt --ignore-case=false"},
		{"check subcommand", "--check-prefix=ALT", "echo hello | filecheck check alt.txt"},
		{"local environment", "", "echo hello | env FILECHECK_OPTS=--check-prefix=ALT FileCheck alt.txt && echo hello | FileCheck check.txt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sh := newShell(dir, map[string]string{"FILECHECK_OPTS": tc.opts})
			status, _, errOut := runShell(t, sh, tc.line)
			if status != 0 {
				t.Fatalf("status=%d stderr=%q", status, errOut)
			}
		})
	}
}

func TestShellFileCheckBuiltin(t *testing.T) {
	dir := t.TempDir()
	check := filepath.Join(dir, "c.txt")
	os.WriteFile(check, []byte("CHECK: hello [[#N:]]\nCHECK-NEXT: [[#N+1]]\n"), 0o644)
	sh := newShell(dir, nil)
	status, _, errOut := runShell(t, sh, `printf 'hello 1\n2\n' | FileCheck c.txt`)
	if status != 0 {
		t.Errorf("builtin FileCheck: %d %q", status, errOut)
	}
	status, _, errOut = runShell(t, sh, `printf 'hello 1\n3\n' | filecheck c.txt`)
	if status != 1 || !strings.Contains(errOut, "expected string not found") {
		t.Errorf("builtin filecheck failure: %d %q", status, errOut)
	}
	status, _, errOut = runShell(t, sh, `printf 'hello 1\n3\n' | not FileCheck c.txt 2>&1 | cat`)
	if status != 0 {
		t.Errorf("not FileCheck with 2>&1: %d %q", status, errOut)
	}
	os.WriteFile(filepath.Join(dir, "in.txt"), []byte("hello 4\n5\n"), 0o644)
	status, _, errOut = runShell(t, sh, `FileCheck --input-file in.txt c.txt`)
	if status != 0 {
		t.Errorf("--input-file relative to shell cwd: %d %q", status, errOut)
	}
}

func TestShellExternalPipeline(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	sh := newShell(t.TempDir(), nil)
	status, out, errOut := runShell(t, sh, `sh -c 'echo out; echo err >&2' 2>&1 | cat`)
	if status != 0 || !strings.Contains(out, "out") || !strings.Contains(out, "err") {
		t.Errorf("2>&1 into pipe: %d %q %q", status, out, errOut)
	}
	status, out, _ = runShell(t, sh, `sh -c 'exit 3'`)
	if status != 3 {
		t.Errorf("exit status: %d", status)
	}
	// A downstream stage that stops reading must not hang the pipeline.
	// The writer may see SIGPIPE (141) once the reader is gone, which
	// pipefail reports; what matters is that nothing hangs.
	status, out, _ = runShell(t, sh, `sh -c 'yes | head -c 1000000' | true`)
	if status != 0 && status != 141 {
		t.Errorf("early close: %d", status)
	}
	status, out, _ = runShell(t, sh, `FOO=bar sh -c 'echo $FOO'`)
	if status != 0 || out != "bar\n" {
		t.Errorf("assignment prefix: %d %q", status, out)
	}
}
