// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The resource helper's tests exercise its real subprocess and JSON boundaries.
// A fixture child announces readiness without opening sockets, so these tests
// remain usable in Buck's network-restricted unit-test sandbox. Hurl and
// Orchestra integration tests separately exercise the actual mems3 listener.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestResourceCommand(t *testing.T) {
	for _, test := range []struct {
		args []string
		want []string
	}{
		{[]string{"/server"}, []string{"/server", "--listen", "127.0.0.1:0"}},
		{[]string{"/path with spaces/server", "--bucket", "first", "--bucket", "second"},
			[]string{"/path with spaces/server", "--listen", "127.0.0.1:0", "--bucket", "first", "--bucket", "second"}},
		{[]string{"/server", "--buggify"}, []string{"/server", "--listen", "127.0.0.1:0", "--buggify"}},
		{[]string{"/server", "--auto-buggify"}, []string{"/server", "--listen", "127.0.0.1:0", "--auto-buggify"}},
		{[]string{
			"/server", "--bucket", "chaos", "--fault-seed", "42", "--auto-buggify",
			"--chaos-warmup-requests", "0", "--chaos-requests", "18446744073709551615", "--chaos-trace",
		}, []string{
			"/server", "--listen", "127.0.0.1:0", "--bucket", "chaos", "--fault-seed", "42", "--auto-buggify",
			"--chaos-warmup-requests", "0", "--chaos-requests", "18446744073709551615", "--chaos-trace",
		}},
		{[]string{
			"/server", "--chaos-trace", "--chaos-requests", "1", "--chaos-warmup-requests", "18446744073709551614", "--auto-buggify",
		}, []string{
			"/server", "--listen", "127.0.0.1:0", "--chaos-trace", "--chaos-requests", "1", "--chaos-warmup-requests", "18446744073709551614", "--auto-buggify",
		}},
		{[]string{
			"/server", "--bucket", "faults", "--failpoint", "get_object=1*return(slow_down)->off",
			"--fault-seed", "18446744073709551615", "--buggify-activation", "50.5", "--buggify", "--buggify-firing", "100",
			"--failpoint", "put_object=return(literal $(command) `command` ; \"quotes\" with spaces)",
		}, []string{
			"/server", "--listen", "127.0.0.1:0", "--bucket", "faults", "--failpoint", "get_object=1*return(slow_down)->off",
			"--fault-seed", "18446744073709551615", "--buggify-activation", "50.5", "--buggify", "--buggify-firing", "100",
			"--failpoint", "put_object=return(literal $(command) `command` ; \"quotes\" with spaces)",
		}},
	} {
		command, err := resourceCommand(test.args)
		if err != nil || !reflect.DeepEqual(command.Args, test.want) {
			t.Fatalf("resourceCommand(%q) = %v, %v; want %q", test.args, command, err, test.want)
		}
	}
}

func TestResourceCommandRejectsInvalidArguments(t *testing.T) {
	invalid := [][]string{
		nil, {""}, {"server", "trailing"}, {"server", "--unknown", "value"},
		{"server", "--listen", "127.0.0.1:9000"}, {"server", "--listen=127.0.0.1:9000"},
		{"server", "--buggify", "true"}, {"server", "--buggify=true"},
		{"server", "--auto-buggify", "true"}, {"server", "--auto-buggify=true"},
		{"server", "--chaos-trace", "true"}, {"server", "--chaos-trace=true"},
		{"server", "--buggify", "--listen", "127.0.0.1:9000"},
		{"server", "--bucket", "first", "--unexpected"},
	}
	for _, flag := range []string{"--bucket", "--failpoint", "--fault-seed", "--buggify-activation", "--buggify-firing", "--chaos-warmup-requests", "--chaos-requests"} {
		invalid = append(invalid,
			[]string{"server", flag},
			[]string{"server", flag, ""},
			[]string{"server", flag, "--buggify"},
			[]string{"server", flag, "--auto-buggify"},
			[]string{"server", flag, "--chaos-trace"},
			[]string{"server", flag, "--unknown"},
			[]string{"server", "--buggify", flag},
		)
	}
	for _, args := range invalid {
		if command, err := resourceCommand(args); command != nil || err == nil {
			t.Errorf("resourceCommand(%q) = %v, %v; want rejected arguments", args, command, err)
		}
		var stdout bytes.Buffer
		if err := run(args, &stdout); err == nil {
			t.Errorf("run(%q) unexpectedly succeeded", args)
		}
		if stdout.Len() != 0 {
			t.Errorf("run(%q) polluted resource stdout: %q", args, stdout.String())
		}
	}
}

func TestValidateEndpoint(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.1:1234", "http://[::1]:1234"} {
		if err := validateEndpoint(endpoint); err != nil {
			t.Errorf("validateEndpoint(%q): %v", endpoint, err)
		}
	}
	for _, endpoint := range []string{
		"", ":", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536",
		"https://127.0.0.1:1234", "http://example.com:1234", "http://0.0.0.0:1234",
		"http://user@127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234/?x=y",
	} {
		if err := validateEndpoint(endpoint); err == nil {
			t.Errorf("validateEndpoint(%q) unexpectedly succeeded", endpoint)
		}
	}
}

func TestSetupResourceHandsOffOnlyJSON(t *testing.T) {
	directory := t.TempDir()
	var stdout bytes.Buffer
	command := fixtureCommand(t, "ready")
	process, err := setupResource(command, &stdout, directory, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(process.stop)
	var pool resourcePool
	decoder := json.NewDecoder(&stdout)
	if err := decoder.Decode(&pool); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		t.Fatalf("resource stdout contains more than one JSON record: %v", err)
	}
	want := resourcePool{PID: command.Process.Pid, Resources: []resourceAliases{{
		AccessKeyID: accessKeyID, Endpoint: "http://127.0.0.1:12345", Log: process.logPath,
		Region: region, SecretAccessKey: secretAccessKey,
	}}}
	if !reflect.DeepEqual(pool, want) {
		t.Fatalf("resource record = %#v, want %#v", pool, want)
	}
	select {
	case <-process.done:
		t.Fatal("resource exited before Buck could use it")
	default:
	}
	contents, err := os.ReadFile(pool.Resources[0].Log)
	if err != nil || !strings.Contains(string(contents), "stdin is disconnected") || !strings.Contains(string(contents), "stderr diagnostic") {
		t.Fatalf("server stdout/stderr were not captured: %q, %v", contents, err)
	}
}

func TestSetupResourceRejectsPartialAnnouncement(t *testing.T) {
	// A partial write is not a complete startup record even if its current
	// contents happen to parse as an endpoint.
	testFailedSetup(t, "partial", 100*time.Millisecond, "startup timed out")
}

func TestSetupResourceDetectsEarlyExit(t *testing.T) {
	testFailedSetup(t, "exit", 5*time.Second, "fixture startup failure")
}

func TestSetupResourceTimesOutAndReapsChild(t *testing.T) {
	testFailedSetup(t, "silent", 100*time.Millisecond, "startup timed out")
}

func TestSetupResourceRejectsInvalidAnnouncement(t *testing.T) {
	testFailedSetup(t, "invalid", 5*time.Second, "invalid loopback endpoint")
}

func testFailedSetup(t *testing.T, mode string, timeout time.Duration, message string) {
	t.Helper()
	directory := t.TempDir()
	var stdout bytes.Buffer
	command := fixtureCommand(t, mode)
	process, err := setupResource(command, &stdout, directory, timeout)
	if process != nil || err == nil || !strings.Contains(err.Error(), message) {
		if process != nil {
			process.stop()
		}
		t.Fatalf("setupResource(%s) = %v, %v; want %q", mode, process, err, message)
	}
	if stdout.Len() != 0 {
		t.Errorf("failed setup emitted resource JSON: %s", &stdout)
	}
	if command.ProcessState == nil {
		t.Error("failed setup did not reap its child")
	}
	assertEmptyDirectory(t, directory)
}

func TestSetupResourceFailedHandoffReapsChild(t *testing.T) {
	directory := t.TempDir()
	command := fixtureCommand(t, "ready")
	process, err := setupResource(command, failingWriter{}, directory, 5*time.Second)
	if process != nil || err == nil || !strings.Contains(err.Error(), "encode local resource: fixture broken pipe") {
		if process != nil {
			process.stop()
		}
		t.Fatalf("failed handoff = %v, %v", process, err)
	}
	if command.ProcessState == nil {
		t.Error("failed handoff did not reap its child")
	}
	assertEmptyDirectory(t, directory)
}

func TestSetupResourceFailedStartRemovesLog(t *testing.T) {
	directory := t.TempDir()
	process, err := setupResource(exec.Command(filepath.Join(directory, "missing-server")), io.Discard, directory, time.Second)
	if process != nil || err == nil || !strings.Contains(err.Error(), "start mems3") {
		t.Fatalf("missing executable = %v, %v", process, err)
	}
	assertEmptyDirectory(t, directory)
}

func TestSetupResourceFailedLogCreationDoesNotStart(t *testing.T) {
	command := fixtureCommand(t, "ready")
	process, err := setupResource(command, io.Discard, filepath.Join(t.TempDir(), "missing-directory"), time.Second)
	if process != nil || err == nil || !strings.Contains(err.Error(), "create mems3 log") || command.Process != nil {
		t.Fatalf("missing log directory = %v, %v, child %v", process, err, command.Process)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("fixture broken pipe") }

func assertEmptyDirectory(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Errorf("failed setup left logs behind: %v, %v", entries, err)
	}
}

func fixtureCommand(t *testing.T, mode string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestResourceSubprocess$")
	command.Env = append(os.Environ(), "MEMS3_RESOURCE_TEST_CHILD="+mode)
	return command
}

// TestResourceSubprocess is a self-exec fixture, not a second server model. The
// live resource must survive helper setup; tests kill and reap each such child.
func TestResourceSubprocess(t *testing.T) {
	mode := os.Getenv("MEMS3_RESOURCE_TEST_CHILD")
	if mode == "" {
		return
	}
	if input, err := io.ReadAll(os.Stdin); err != nil || len(input) != 0 {
		fmt.Fprintln(os.Stderr, "unexpected inherited stdin")
		os.Exit(19)
	}
	fmt.Fprintln(os.Stderr, "stdin is disconnected; stderr diagnostic")
	switch mode {
	case "ready":
		fmt.Fprintln(os.Stdout, "mems3 listening on http://127.0.0.1:12345")
	case "partial":
		fmt.Fprint(os.Stdout, "mems3 listening on http://127.0.0.1:12345")
	case "invalid":
		fmt.Fprintln(os.Stdout, "mems3 listening on http://0.0.0.0:12345")
	case "exit":
		fmt.Fprintln(os.Stderr, "fixture startup failure")
		os.Exit(17)
	case "silent":
	default:
		os.Exit(18)
	}
	for {
		time.Sleep(time.Hour)
	}
}
