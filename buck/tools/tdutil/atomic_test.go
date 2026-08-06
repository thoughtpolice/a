// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAtomicWriteReplacesTheDestinationOnlyOnSuccess(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "targets.txt")
	if err := os.WriteFile(path, []byte("previous\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	failure := errors.New("render exploded")
	err := writeFileAtomically(path, 0o644, func(output io.Writer) error {
		// A partial write before the failure is exactly the case that used to
		// truncate the destination in place.
		if _, err := io.WriteString(output, "root//partial:target\n"); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("error = %v, want the render failure", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "previous\n" {
		t.Fatalf("destination = %q, want the previous contents untouched", contents)
	}

	if err := writeFileAtomically(path, 0o644, func(output io.Writer) error {
		_, err := io.WriteString(output, "root//pkg:target\n")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	contents, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "root//pkg:target\n" {
		t.Fatalf("destination = %q", contents)
	}

	// Neither outcome may leave a temporary file behind for a CI cache step to
	// pick up alongside the real one.
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "targets.txt" {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("directory contains %v, want only the destination", names)
	}
}

func TestAtomicWriteReportsFailureToCreateItsTemporary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-directory", "out.txt")
	err := writeFileAtomically(path, 0o644, func(io.Writer) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "temporary file") {
		t.Fatalf("error = %v, want a temporary-file creation failure", err)
	}
}

// An irreplaceable destination — a device here, a process substitution or
// /dev/stdout in practice — is written through rather than renamed over, which
// a rename would turn into a regular file in a directory nobody may write.
func TestAtomicWriteWritesThroughIrregularDestinations(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /dev/null to write through")
	}
	const path = "/dev/null"
	before, err := os.Stat(path)
	if err != nil {
		t.Skipf("no usable %s: %v", path, err)
	}

	if err := writeFileAtomically(path, 0o644, func(output io.Writer) error {
		_, err := io.WriteString(output, "root//pkg:target\n")
		return err
	}); err != nil {
		t.Fatal(err)
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.Mode().IsRegular() {
		t.Fatalf("%s became a regular file", path)
	}
	if before.Mode() != after.Mode() {
		t.Fatalf("%s mode changed from %v to %v", path, before.Mode(), after.Mode())
	}
}
