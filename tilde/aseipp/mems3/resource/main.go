// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Package main adapts mems3 to Buck's LocalResourceInfo setup protocol.
//
// It starts one memory-only server on an ephemeral loopback port, waits for the
// announcement printed after binding, and writes exactly one JSON resource pool
// to stdout. Server output goes to a diagnostic log; stdin is disconnected. On
// success Buck takes ownership of the reported PID and terminates it after use.
// Before that handoff every failure kills and reaps the child and removes its
// log. Successful logs remain available through MEMS3_LOG for test diagnostics.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Leave time for failure cleanup before Buck's 30-second setup deadline.
const startupTimeout = 25 * time.Second

// mems3 accepts anonymous requests and verifies signed ones against these
// fixed credentials, which mirror ../main.rs, so AWS clients can exercise
// their ordinary signed-request path.
const (
	accessKeyID     = "mems3"
	secretAccessKey = "mems3"
	region          = "us-east-1"
)

const usage = "usage: mems3-resource MEMS3 [--bucket NAME]... [--failpoint NAME=PLAN]... [--fault-seed SEED] [--buggify] [--buggify-activation PERCENT] [--buggify-firing PERCENT] [--auto-buggify] [--chaos-warmup-requests COUNT] [--chaos-requests COUNT] [--chaos-trace]"

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
		fmt.Fprintf(os.Stderr, "mems3 resource: %v\n", err)
		os.Exit(1)
	}
}

// run accepts the server executable followed by bucket and fault settings.
func run(args []string, stdout io.Writer) error {
	command, err := resourceCommand(args)
	if err != nil {
		return err
	}
	_, err = setupResource(command, stdout, "", startupTimeout)
	return err
}

func resourceCommand(args []string) (*exec.Cmd, error) {
	if len(args) == 0 || args[0] == "" {
		return nil, errors.New(usage)
	}
	commandArgs := []string{"--listen", "127.0.0.1:0"}
	for remaining := args[1:]; len(remaining) > 0; {
		switch remaining[0] {
		case "--buggify", "--auto-buggify", "--chaos-trace":
			commandArgs = append(commandArgs, remaining[0])
			remaining = remaining[1:]
		case "--bucket", "--failpoint", "--fault-seed", "--buggify-activation", "--buggify-firing", "--chaos-warmup-requests", "--chaos-requests":
			if len(remaining) < 2 || remaining[1] == "" || strings.HasPrefix(remaining[1], "--") {
				return nil, fmt.Errorf("%s requires a value; %s", remaining[0], usage)
			}
			// exec.Command preserves plans as one literal argument. The server
			// validates their names, syntax, numeric ranges, and combinations.
			commandArgs = append(commandArgs, remaining[:2]...)
			remaining = remaining[2:]
		default:
			return nil, errors.New(usage)
		}
	}
	return exec.Command(args[0], commandArgs...), nil
}

// setupResource either hands a live child to Buck with a complete JSON record,
// or removes everything it started. The returned process exists to let tests
// exercise that ownership transfer without involving Buck's resource manager.
func setupResource(command *exec.Cmd, stdout io.Writer, logDir string, timeout time.Duration) (*resourceProcess, error) {
	logFile, err := os.CreateTemp(logDir, "mems3-resource-*.log")
	if err != nil {
		return nil, fmt.Errorf("create mems3 log: %w", err)
	}
	process := &resourceProcess{command: command, done: make(chan struct{}), logPath: logFile.Name()}
	command.Stdin = nil // /dev/null, never Buck's resource-protocol input.
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		_ = os.Remove(process.logPath)
		return nil, fmt.Errorf("start mems3: %w", err)
	}
	go func() {
		process.waitErr = command.Wait()
		close(process.done)
	}()

	// The child inherited its own descriptor; setup need not keep one open.
	if err := logFile.Close(); err != nil {
		process.stop()
		return nil, fmt.Errorf("close mems3 log: %w", err)
	}
	endpoint, err := process.waitForEndpoint(timeout)
	if err != nil {
		contents, _ := os.ReadFile(process.logPath)
		process.stop()
		return nil, fmt.Errorf("mems3 did not become ready: %w\n%s", err, strings.TrimSpace(string(contents)))
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

// waitForEndpoint observes complete startup log lines and detects early exit.
// mems3 publishes this line only after successfully binding its TCP listener.
func (process *resourceProcess) waitForEndpoint(timeout time.Duration) (string, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-process.done:
			return "", fmt.Errorf("mems3 exited before becoming ready: %v", process.waitErr)
		default:
		}
		contents, err := os.ReadFile(process.logPath)
		if err != nil {
			return "", err
		}
		lines := strings.Split(string(contents), "\n")
		for _, line := range lines[:len(lines)-1] {
			const prefix = "mems3 listening on "
			if strings.HasPrefix(line, prefix) {
				endpoint := strings.TrimSpace(strings.TrimPrefix(line, prefix))
				if err := validateEndpoint(endpoint); err != nil {
					return "", err
				}
				return endpoint, nil
			}
		}
		select {
		case <-process.done:
			return "", fmt.Errorf("mems3 exited before becoming ready: %v", process.waitErr)
		case <-deadline.C:
			return "", errors.New("startup timed out")
		case <-ticker.C:
		}
	}
}

// validateEndpoint restricts the announcement to the loopback HTTP listener we
// requested. A malformed log line must never redirect an integration test.
func validateEndpoint(endpoint string) error {
	parsed, err := url.ParseRequestURI(endpoint)
	if err != nil {
		return fmt.Errorf("invalid endpoint %q: %w", endpoint, err)
	}
	ip := net.ParseIP(parsed.Hostname())
	port, portErr := strconv.Atoi(parsed.Port())
	if parsed.Scheme != "http" || ip == nil || !ip.IsLoopback() || portErr != nil || port < 1 || port > 65535 ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("invalid loopback endpoint %q", endpoint)
	}
	return nil
}
