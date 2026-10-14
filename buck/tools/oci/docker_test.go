// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeDocker puts a docker on PATH that keeps its state in files: the
// loaded archive, the container's logs and whether it is running, and a
// log of every command.
func fakeDocker(t *testing.T, logs, running string) string {
	t.Helper()
	state := t.TempDir()
	bin := t.TempDir()
	writeFile(t, filepath.Join(state, "logs"), []byte(logs))
	writeFile(t, filepath.Join(state, "running"), []byte(running))
	script := `#!/bin/sh
state=` + state + `
echo "$*" >>"$state/commands"
case "$1" in
load) cat >"$state/loaded.tar"; echo "Loaded image" ;;
run) echo 0123456789abcdef ;;
logs) cat "$state/logs" ;;
inspect) cat "$state/running" ;;
esac
`
	writeFile(t, filepath.Join(bin, "docker"), []byte(script))
	os.Chmod(filepath.Join(bin, "docker"), 0o755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	return state
}

func dockerCommands(t *testing.T, state string) string {
	data, _ := os.ReadFile(filepath.Join(state, "commands"))
	return string(data)
}

func TestSmokeReady(t *testing.T) {
	state := fakeDocker(t, "starting\nworker ready\n", "true")
	l := testImage(t, filepath.Join(t.TempDir(), "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	stdout := mustRun(t, "smoke", "--image", l.Dir, "--ready-log", "worker ready", "--", "serve", "--port", "1")
	if !strings.Contains(stdout, "still running") {
		t.Errorf("stdout %q", stdout)
	}
	cmds := dockerCommands(t, state)
	if !strings.Contains(cmds, " serve --port 1\n") || !strings.Contains(cmds, "rm --force buck2-oci-smoke-") || !strings.Contains(cmds, "image rm buck2-oci-smoke-") {
		t.Errorf("commands:\n%s", cmds)
	}
	files := untar(t, filepath.Join(state, "loaded.tar"), filepath.Join(t.TempDir(), "x"))
	if !strings.Contains(string(files["manifest.json"]), "buck2-oci-smoke-") {
		t.Errorf("loaded manifest.json %s", files["manifest.json"])
	}
}

func TestSmokeFailures(t *testing.T) {
	l := testImage(t, filepath.Join(t.TempDir(), "image"), baseConfig("amd64"), tarBytes(t, map[string]string{"a": "a"}))
	for _, c := range []struct{ logs, running, timeout, want string }{
		{"starting\n", "false", "5", "exited before readiness"},
		{"ready\n", "false", "5", "readiness was logged, but the container exited"},
		{"starting\n", "true", "0.3", "timed out"},
	} {
		state := fakeDocker(t, c.logs, c.running)
		_, stderr, code := runTool(t, "smoke", "--image", l.Dir, "--ready-log", "ready", "--timeout-seconds", c.timeout)
		if code != 1 || !strings.Contains(stderr, c.want) {
			t.Errorf("%+v gave exit %d: %s", c, code, stderr)
		}
		if !strings.Contains(dockerCommands(t, state), "rm --force") {
			t.Errorf("%+v did not clean up", c)
		}
	}
}
