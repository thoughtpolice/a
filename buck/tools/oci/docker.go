// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

func runLoad(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("load", "--image LAYOUT --tag NAME:TAG [--source-tag TAG]", stderr)
	image := flags.String("image", "", "image layout")
	tag := flags.String("tag", "", "name and tag to load the image as")
	sourceTag := flags.String("source-tag", "latest", "tag of the image in the layout")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "image", "tag"); err != nil {
		return err
	}
	return dockerLoad(ctx, Layout{*image}, *sourceTag, *tag, stdout)
}

// dockerLoad streams the image to docker load as an archive, so nothing is
// written to disk on the way.
func dockerLoad(ctx context.Context, layout Layout, sourceTag, repoTag string, log io.Writer) error {
	cmd := exec.CommandContext(ctx, "docker", "load")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("docker load: %w", err)
	}
	writeErr := writeArchive(stdin, layout, sourceTag, repoTag)
	stdin.Close()
	waitErr := cmd.Wait()
	io.Copy(log, &output)
	if waitErr != nil {
		return fmt.Errorf("docker load: %w", waitErr)
	}
	if writeErr != nil {
		return fmt.Errorf("docker load: writing the archive: %w", writeErr)
	}
	return nil
}

// docker runs a docker command with a time limit and returns its combined
// output.
func docker(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	return string(out), err
}

func runSmoke(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("smoke", "--image LAYOUT --ready-log TEXT [--timeout-seconds N] [-- ARG...]", stderr)
	image := flags.String("image", "", "image layout to run")
	readyLog := flags.String("ready-log", "", "text in the container's log that means it is ready")
	timeout := flags.Float64("timeout-seconds", 15, "how long the container has to become ready")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "image", "ready-log"); err != nil {
		return err
	}
	suffix := make([]byte, 6)
	rand.Read(suffix)
	name := "buck2-oci-smoke-" + hex.EncodeToString(suffix)
	tag := name + ":latest"

	// Cleanup runs on every way out, an interrupt included: Buck sends
	// SIGTERM before it kills a timed-out test, and the detached container
	// would otherwise outlive it.
	defer func() {
		cleanup := context.Background()
		docker(cleanup, 5*time.Second, "rm", "--force", name)
		docker(cleanup, 5*time.Second, "image", "rm", tag)
	}()
	err := smoke(ctx, Layout{*image}, name, tag, *readyLog, time.Duration(*timeout*float64(time.Second)), flags.Args(), stdout, stderr)
	if ctx.Err() != nil {
		return errors.New("interrupted")
	}
	return err
}

func smoke(ctx context.Context, layout Layout, name, tag, readyLog string, timeout time.Duration, args []string, stdout, stderr io.Writer) error {
	loadCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if err := dockerLoad(loadCtx, layout, "latest", tag, stdout); err != nil {
		return err
	}
	out, err := docker(ctx, 30*time.Second, append([]string{"run", "--detach", "--name", name, tag}, args...)...)
	if err != nil {
		fmt.Fprint(stderr, out)
		return fmt.Errorf("docker run: %w", err)
	}
	fmt.Fprintf(stdout, "oci smoke: started %s\n", strings.TrimSpace(out))

	running := func() bool {
		out, err := docker(ctx, 30*time.Second, "inspect", "--format", "{{.State.Running}}", name)
		return err == nil && strings.TrimSpace(out) == "true"
	}
	deadline := time.Now().Add(timeout)
	var logs string
	for time.Now().Before(deadline) {
		logs, _ = docker(ctx, 30*time.Second, "logs", name)
		if strings.Contains(logs, readyLog) {
			// Catch services that log readiness just before a late bind or
			// initialization failure takes the process down.
			sleep(ctx, 250*time.Millisecond)
			if !running() {
				fmt.Fprint(stderr, logs)
				return errors.New("readiness was logged, but the container exited")
			}
			fmt.Fprint(stdout, logs)
			fmt.Fprintf(stdout, "oci smoke: ready (%q) and still running\n", readyLog)
			return nil
		}
		if !running() {
			fmt.Fprint(stderr, logs)
			return errors.New("container exited before readiness")
		}
		if err := sleep(ctx, 100*time.Millisecond); err != nil {
			return err
		}
	}
	fmt.Fprint(stderr, logs)
	return fmt.Errorf("timed out after %v waiting for %q", timeout, readyLog)
}

func sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}
