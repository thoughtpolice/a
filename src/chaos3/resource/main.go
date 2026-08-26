// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Package main adapts chaos3 to Buck's LocalResourceInfo setup protocol.
//
// It starts one memory-only server on an ephemeral loopback port, waits for
// the endpoint chaos3 writes to a readiness pipe after binding, and writes
// exactly one JSON resource pool to stdout. Server output goes to a diagnostic
// log; stdin is disconnected. On success Buck takes ownership of the reported
// PID and terminates it after use. Before that handoff every failure kills and
// reaps the child and removes its log. Successful logs remain available through
// CHAOS3_LOG for test diagnostics.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Leave time for failure cleanup before Buck's 30-second setup deadline.
const startupTimeout = 25 * time.Second

// readyDescriptor is the child's number for the readiness pipe, the first
// extra file after stdin, stdout, and stderr.
const readyDescriptor = 3

// chaos3 accepts anonymous requests and verifies signed ones against these
// fixed credentials, which mirror ../main.rs, so AWS clients can exercise
// their ordinary signed-request path.
const (
	accessKeyID     = "chaos3"
	secretAccessKey = "chaos3"
	region          = "us-east-1"
)

const usage = "usage: chaos3-resource CHAOS3 [OPTION]... where OPTION is any chaos3 option except --listen and --ready-fd"

// resourcePool is the single-resource JSON record understood by Buck's runner.
type resourcePool struct {
	PID       int               `json:"pid"`
	Resources []resourceAliases `json:"resources"`
}

// resourceAliases are named by resource_env_vars in ../defs.bzl.
type resourceAliases struct {
	AccessKeyID     string `json:"access_key_id"`
	Endpoint        string `json:"endpoint"`
	Log             string `json:"log"`
	Region          string `json:"region"`
	SecretAccessKey string `json:"secret_access_key"`
}

// resourceProcess supervises startup. waitErr is read only after done closes;
// reaping rather than signal(0) also detects a child that has become a zombie.
type resourceProcess struct {
	command *exec.Cmd
	done    chan struct{}
	waitErr error
	logPath string
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "chaos3 resource: %v\n", err)
		os.Exit(1)
	}
}

// run accepts the server executable followed by its options.
func run(args []string, stdout io.Writer) error {
	command, err := resourceCommand(args)
	if err != nil {
		return err
	}
	_, err = setupResource(command, stdout, "", startupTimeout)
	return err
}

// resourceCommand puts the helper's ephemeral listen address and readiness
// descriptor before the caller's options, which pass through as literal
// arguments so that a plan with spaces or quotes stays one argument. chaos3
// checks their names, syntax, numeric ranges, and combinations and reports a
// usage error through the startup log. The helper owns the two options it
// sets, so a caller's copy of either is rejected wherever it appears.
func resourceCommand(args []string) (*exec.Cmd, error) {
	if len(args) == 0 || args[0] == "" {
		return nil, errors.New(usage)
	}
	for _, arg := range args[1:] {
		for _, reserved := range []string{"--listen", "--ready-fd"} {
			if arg == reserved || strings.HasPrefix(arg, reserved+"=") {
				return nil, fmt.Errorf("%s is reserved for the helper. %s", arg, usage)
			}
		}
	}
	options := []string{"--listen", "127.0.0.1:0", "--ready-fd", strconv.Itoa(readyDescriptor)}
	return exec.Command(args[0], append(options, args[1:]...)...), nil
}

// setupResource either hands a live child to Buck with a complete JSON record,
// or removes everything it started. The returned process exists to let tests
// exercise that ownership transfer without involving Buck's resource manager.
func setupResource(command *exec.Cmd, stdout io.Writer, logDir string, timeout time.Duration) (*resourceProcess, error) {
	logFile, err := os.CreateTemp(logDir, "chaos3-resource-*.log")
	if err != nil {
		return nil, fmt.Errorf("create chaos3 log: %w", err)
	}
	process := &resourceProcess{command: command, done: make(chan struct{}), logPath: logFile.Name()}
	ready, readyWriter, err := os.Pipe()
	if err != nil {
		_ = logFile.Close()
		_ = os.Remove(process.logPath)
		return nil, fmt.Errorf("create readiness pipe: %w", err)
	}
	defer ready.Close()
	command.Stdin = nil // /dev/null, never Buck's resource-protocol input.
	command.Stdout = logFile
	command.Stderr = logFile
	command.ExtraFiles = []*os.File{readyWriter} // readyDescriptor in the child
	err = command.Start()
	// The child inherited its own descriptors. Keeping the parent's copy of
	// the pipe's write end would only stop the read end from reaching EOF.
	_ = readyWriter.Close()
	if err != nil {
		_ = logFile.Close()
		_ = os.Remove(process.logPath)
		return nil, fmt.Errorf("start chaos3: %w", err)
	}
	go func() {
		process.waitErr = command.Wait()
		close(process.done)
	}()
	if err := logFile.Close(); err != nil {
		process.stop()
		return nil, fmt.Errorf("close chaos3 log: %w", err)
	}
	endpoint, err := process.waitForEndpoint(ready, timeout)
	if err != nil {
		contents, _ := os.ReadFile(process.logPath)
		process.stop()
		return nil, fmt.Errorf("chaos3 did not become ready: %w\n%s", err, strings.TrimSpace(string(contents)))
	}
	pool := resourcePool{
		PID: command.Process.Pid,
		Resources: []resourceAliases{{
			AccessKeyID: accessKeyID, Endpoint: endpoint, Log: process.logPath,
			Region: region, SecretAccessKey: secretAccessKey,
		}},
	}
	if err := json.NewEncoder(stdout).Encode(pool); err != nil {
		process.stop()
		return nil, fmt.Errorf("encode local resource: %w", err)
	}
	return process, nil
}

// stop reaps only the child started by this helper and removes its private log.
func (process *resourceProcess) stop() {
	_ = process.command.Process.Kill()
	<-process.done
	_ = os.Remove(process.logPath)
}

// waitForEndpoint reads the readiness announcement, which chaos3 writes and
// closes only after binding its listener. A child that exits first closes the
// pipe without one, and a child that never writes runs into the deadline.
func (process *resourceProcess) waitForEndpoint(ready *os.File, timeout time.Duration) (string, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	announcement := make(chan string, 1)
	go func() {
		contents, _ := io.ReadAll(ready)
		announcement <- string(contents)
	}()
	select {
	case contents := <-announcement:
		endpoint, complete := strings.CutSuffix(contents, "\n")
		if complete && endpoint != "" && !strings.Contains(endpoint, "\n") {
			return endpoint, nil
		}
		// The pipe closed without a whole announcement. An exiting child
		// closes it too, and its exit status says more than the fragment.
		select {
		case <-process.done:
			return "", fmt.Errorf("chaos3 exited before becoming ready: %v", process.waitErr)
		case <-deadline.C:
			return "", fmt.Errorf("incomplete readiness announcement %q", contents)
		}
	case <-deadline.C:
		return "", errors.New("startup timed out")
	}
}
