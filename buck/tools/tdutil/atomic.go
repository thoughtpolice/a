// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// writeFileAtomically renders into a sibling temporary file and renames it over
// the destination, so a reader — buck2 consuming an at-file, or a CI cache step
// uploading a snapshot — sees either the previous contents or a complete
// document, never a partial write.
//
// Close and Sync are both checked. A file's deferred write errors, a full
// filesystem being the usual one, do not surface at Write; leaving them
// unchecked would let tdutil exit successfully having written a truncated
// target list, which silently narrows what CI goes on to test.
//
// Destinations which already exist and are not regular files — a device, a
// FIFO, a process substitution — cannot be replaced by a rename, so those are
// written through directly. Such a destination has no meaningful previous
// contents to protect, but its write errors are still reported.
func writeFileAtomically(path string, mode os.FileMode, write func(io.Writer) error) error {
	if info, err := os.Stat(path); err == nil && !info.Mode().IsRegular() {
		return writeFileDirectly(path, write)
	}

	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp")
	if err != nil {
		return fmt.Errorf("creating a temporary file beside `%s`: %w", path, err)
	}
	name := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = temporary.Close()
			_ = os.Remove(name)
		}
	}()

	if err := write(temporary); err != nil {
		return err
	}
	// os.CreateTemp always creates mode 0600; the destination is not private.
	if runtime.GOOS != "windows" {
		if err := temporary.Chmod(mode); err != nil {
			return fmt.Errorf("setting permissions on `%s`: %w", name, err)
		}
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("flushing `%s`: %w", name, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("closing `%s`: %w", name, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("renaming `%s` onto `%s`: %w", name, path, err)
	}
	committed = true
	return nil
}

func writeFileDirectly(path string, write func(io.Writer) error) error {
	output, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("opening `%s`: %w", path, err)
	}
	writeErr := write(output)
	closeErr := output.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return fmt.Errorf("closing `%s`: %w", path, closeErr)
	}
	return nil
}
