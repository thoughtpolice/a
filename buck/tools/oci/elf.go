// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// elfFile is an ELF file's program headers and dynamic section, read from
// the program headers alone, the way the loader sees them. Changing them is
// left to patchelf.
type elfFile struct {
	data    []byte
	order   binary.ByteOrder
	is64    bool
	interp  *elf.Prog
	dynamic []dynEntry
	strtab  int64 // file offset of DT_STRTAB, or -1
	strsz   int64
}

type dynEntry struct {
	tag   elf.DynTag
	value uint64
}

func readELF(data []byte) (*elfFile, error) {
	if len(data) < 16 || !bytes.Equal(data[:4], []byte(elf.ELFMAG)) {
		return nil, errors.New("not an ELF file")
	}
	f, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	e := &elfFile{data: data, order: f.ByteOrder, is64: f.Class == elf.ELFCLASS64, strtab: -1}
	var dynamic *elf.Prog
	for _, p := range f.Progs {
		switch p.Type {
		case elf.PT_INTERP:
			e.interp = p
		case elf.PT_DYNAMIC:
			dynamic = p
		}
	}
	if dynamic == nil {
		return e, nil
	}
	size := int64(8)
	if e.is64 {
		size = 16
	}
	var strtabAddr uint64
	haveStrtab := false
	for off := int64(dynamic.Off); off+size <= int64(dynamic.Off+dynamic.Filesz); off += size {
		if off+size > int64(len(data)) {
			return nil, errors.New("truncated dynamic segment")
		}
		var tag, value uint64
		if e.is64 {
			tag, value = e.order.Uint64(data[off:]), e.order.Uint64(data[off+8:])
		} else {
			tag, value = uint64(e.order.Uint32(data[off:])), uint64(e.order.Uint32(data[off+4:]))
		}
		if elf.DynTag(tag) == elf.DT_NULL {
			break
		}
		e.dynamic = append(e.dynamic, dynEntry{elf.DynTag(tag), value})
		switch elf.DynTag(tag) {
		case elf.DT_STRTAB:
			strtabAddr, haveStrtab = value, true
		case elf.DT_STRSZ:
			e.strsz = int64(value)
		}
	}
	if haveStrtab {
		for _, p := range f.Progs {
			if p.Type == elf.PT_LOAD && p.Vaddr <= strtabAddr && strtabAddr < p.Vaddr+p.Filesz {
				e.strtab = int64(p.Off + strtabAddr - p.Vaddr)
				break
			}
		}
		if e.strtab < 0 {
			return nil, errors.New("DT_STRTAB is outside the loadable segments")
		}
	}
	return e, nil
}

func cString(data []byte, off, limit int64) (string, error) {
	if off < 0 || off >= int64(len(data)) || off >= limit {
		return "", fmt.Errorf("string offset %d is outside the file", off)
	}
	if limit > int64(len(data)) {
		limit = int64(len(data))
	}
	end := bytes.IndexByte(data[off:limit], 0)
	if end < 0 {
		return "", fmt.Errorf("unterminated string at offset %d", off)
	}
	return string(data[off : off+int64(end)]), nil
}

// dynString reads a string the dynamic section points at.
func (e *elfFile) dynString(value uint64) (string, error) {
	if e.strtab < 0 {
		return "", errors.New("dynamic strings but no DT_STRTAB")
	}
	limit := int64(len(e.data))
	if e.strsz > 0 {
		limit = e.strtab + e.strsz
	}
	return cString(e.data, e.strtab+int64(value), limit)
}

func (e *elfFile) interpreter() (string, error) {
	if e.interp == nil {
		return "", nil
	}
	return cString(e.data, int64(e.interp.Off), int64(e.interp.Off+e.interp.Filesz))
}

// runtimePaths returns the interpreter, the RPATH and RUNPATH entries, and
// the DT_NEEDED names.
func (e *elfFile) runtimePaths() (string, []string, []string, error) {
	interp, err := e.interpreter()
	if err != nil {
		return "", nil, nil, err
	}
	var search, needed []string
	for _, d := range e.dynamic {
		switch d.tag {
		case elf.DT_RPATH, elf.DT_RUNPATH:
			s, err := e.dynString(d.value)
			if err != nil {
				return "", nil, nil, err
			}
			for _, p := range strings.Split(s, ":") {
				if p != "" {
					search = append(search, p)
				}
			}
		case elf.DT_NEEDED:
			s, err := e.dynString(d.value)
			if err != nil {
				return "", nil, nil, err
			}
			needed = append(needed, s)
		}
	}
	return interp, search, needed, nil
}
