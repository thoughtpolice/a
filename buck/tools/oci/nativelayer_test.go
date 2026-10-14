// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type testELF struct {
	interp  string
	needed  []string
	runpath string
	symbols []string
}

// build writes a little-endian ELF64 executable with an interpreter, a
// dynamic section, a dynamic symbol table and section headers, all in one
// PT_LOAD segment, enough for patchelf to work on.
func (t testELF) build() []byte {
	const base = 0x400000
	le := binary.LittleEndian
	strtab := []byte{0}
	addString := func(s string) uint32 {
		off := uint32(len(strtab))
		strtab = append(append(strtab, s...), 0)
		return off
	}
	var dyn [][2]uint64
	for _, n := range t.needed {
		dyn = append(dyn, [2]uint64{uint64(elf.DT_NEEDED), uint64(addString(n))})
	}
	if t.runpath != "" {
		dyn = append(dyn, [2]uint64{uint64(elf.DT_RUNPATH), uint64(addString(t.runpath))})
	}
	var syms []uint32
	for _, s := range t.symbols {
		syms = append(syms, addString(s))
	}

	ehdr, phdrs := 64, 3*56
	interpOff := ehdr + phdrs
	interp := append([]byte(t.interp), 0)
	strOff := interpOff + len(interp)
	align := func(n int) int { return (n + 7) &^ 7 }
	symOff := align(strOff + len(strtab))
	symtab := make([]byte, 24*(len(syms)+1))
	for i, name := range syms {
		le.PutUint32(symtab[24*(i+1):], name)
	}
	dynOff := symOff + len(symtab)
	dyn = append(dyn, [2]uint64{uint64(elf.DT_STRTAB), uint64(base + strOff)}, [2]uint64{uint64(elf.DT_STRSZ), uint64(len(strtab))}, [2]uint64{uint64(elf.DT_SYMTAB), uint64(base + symOff)}, [2]uint64{})
	dynamic := make([]byte, 16*len(dyn))
	for i, d := range dyn {
		le.PutUint64(dynamic[16*i:], d[0])
		le.PutUint64(dynamic[16*i+8:], d[1])
	}
	shstrOff := dynOff + len(dynamic)
	shstr := []byte("\x00.interp\x00.dynstr\x00.dynsym\x00.dynamic\x00.shstrtab\x00")
	shOff := align(shstrOff + len(shstr))
	total := shOff + 6*64

	var b bytes.Buffer
	w := func(v any) { binary.Write(&b, le, v) }
	b.Write([]byte{0x7f, 'E', 'L', 'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0})
	w(uint16(elf.ET_EXEC))
	w(uint16(elf.EM_X86_64))
	w(uint32(1))
	w(uint64(base))
	w(uint64(ehdr))
	w(uint64(shOff))
	w(uint32(0))
	w(uint16(64))
	w(uint16(56))
	w(uint16(3))
	w(uint16(64))
	w(uint16(6))
	w(uint16(5))
	phdr := func(typ elf.ProgType, off, size int) {
		w(uint32(typ))
		w(uint32(elf.PF_R))
		w(uint64(off))
		w(uint64(base + off))
		w(uint64(base + off))
		w(uint64(size))
		w(uint64(size))
		w(uint64(8))
	}
	phdr(elf.PT_LOAD, 0, total)
	phdr(elf.PT_INTERP, interpOff, len(interp))
	phdr(elf.PT_DYNAMIC, dynOff, len(dynamic))
	pad := func(to int) { b.Write(make([]byte, to-b.Len())) }
	b.Write(interp)
	b.Write(strtab)
	pad(symOff)
	b.Write(symtab)
	b.Write(dynamic)
	b.Write(shstr)
	pad(shOff)
	shdr := func(name uint32, typ elf.SectionType, off, size int, link uint32, entsize uint64) {
		alignment := uint64(1)
		if entsize > 0 {
			alignment = 8
		}
		w(name)
		w(uint32(typ))
		w(uint64(elf.SHF_ALLOC))
		w(uint64(base + off))
		w(uint64(off))
		w(uint64(size))
		w(link)
		w(uint32(0))
		w(alignment)
		w(entsize)
	}
	b.Write(make([]byte, 64))
	shdr(1, elf.SHT_PROGBITS, interpOff, len(interp), 0, 0)
	shdr(9, elf.SHT_STRTAB, strOff, len(strtab), 0, 0)
	shdr(17, elf.SHT_DYNSYM, symOff, len(symtab), 2, 24)
	shdr(25, elf.SHT_DYNAMIC, dynOff, len(dynamic), 2, 16)
	shdr(34, elf.SHT_STRTAB, shstrOff, len(shstr), 0, 0)
	return b.Bytes()
}

func storePath(hash, name string) string {
	return storeDir + "/" + strings.Repeat(hash, 32) + "-" + name
}

func TestRuntimePaths(t *testing.T) {
	glibc, gcc := storePath("a", "glibc-2.42"), storePath("b", "gcc-15-lib")
	data := testELF{interp: glibc + "/lib/ld-linux-x86-64.so.2", needed: []string{"libc.so.6", "libgcc_s.so.1"}, runpath: glibc + "/lib:" + gcc + "/lib", symbols: []string{"main"}}.build()
	e, err := readELF(data)
	if err != nil {
		t.Fatal(err)
	}
	interp, search, needed, err := e.runtimePaths()
	if err != nil || interp != glibc+"/lib/ld-linux-x86-64.so.2" || !reflect.DeepEqual(search, []string{glibc + "/lib", gcc + "/lib"}) || !reflect.DeepEqual(needed, []string{"libc.so.6", "libgcc_s.so.1"}) {
		t.Errorf("got %q %q %q %v", interp, search, needed, err)
	}

	// A relocatable object has no program headers at all.
	rel := append([]byte{0x7f, 'E', 'L', 'F', 2, 1, 1}, make([]byte, 9)...)
	hdr := make([]byte, 48)
	binary.LittleEndian.PutUint16(hdr[0:], uint16(elf.ET_REL))
	binary.LittleEndian.PutUint16(hdr[2:], uint16(elf.EM_X86_64))
	binary.LittleEndian.PutUint32(hdr[4:], 1)
	binary.LittleEndian.PutUint16(hdr[36:], 64)
	e, err = readELF(append(rel, hdr...))
	if err != nil {
		t.Fatal(err)
	}
	if interp, search, needed, err := e.runtimePaths(); interp != "" || search != nil || needed != nil || err != nil {
		t.Errorf("relocatable object: %q %q %q %v", interp, search, needed, err)
	}
}

func useStore(t *testing.T) {
	old := storeDir
	storeDir = filepath.Join(t.TempDir(), "nix", "store")
	t.Cleanup(func() { storeDir = old })
}

func TestStoreClosure(t *testing.T) {
	useStore(t)
	first, second, third := storePath("a", "first"), storePath("b", "second"), storePath("c", "third")
	placeholder := storeDir + "/" + strings.Repeat("e", 32) + "-bootstrap"
	writeFile(t, filepath.Join(first, "lib", "library.so"), []byte("\x7fELF\x00"+placeholder+"\x00"+second+"/lib\x00"))
	os.MkdirAll(second, 0o755)
	os.Symlink(third+"/share/data", filepath.Join(second, "data"))
	writeFile(t, filepath.Join(third, "share", "data"), []byte("data"))

	if refs, _ := embeddedStorePaths(filepath.Join(first, "lib", "library.so")); !reflect.DeepEqual(refs, []string{second}) {
		t.Errorf("embedded %v", refs)
	}
	roots, err := storeClosure([]string{first})
	if err != nil || !reflect.DeepEqual(roots, []string{first, second, third}) {
		t.Errorf("closure %v, %v", roots, err)
	}
	if _, err := storeClosure([]string{storePath("d", "missing")}); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Errorf("a missing root: %v", err)
	}
}

func TestNativeLayer(t *testing.T) {
	useStore(t)
	tmp := t.TempDir()
	glibc := storePath("a", "glibc-2.42")
	writeFile(t, filepath.Join(glibc, "lib", "ld-linux-x86-64.so.2"), []byte("loader"))
	writeFile(t, filepath.Join(glibc, "lib", "first"), []byte("same contents"))
	os.Link(filepath.Join(glibc, "lib", "first"), filepath.Join(glibc, "lib", "second"))
	binary := writeFile(t, filepath.Join(tmp, "worker"), testELF{interp: glibc + "/lib/ld-linux-x86-64.so.2", needed: []string{"libc.so.6"}, runpath: glibc + "/lib", symbols: []string{"main"}}.build())
	os.Chmod(binary, 0o4750)

	optimized := filepath.Join(tmp, "optimized.tar.gz")
	mustRun(t, "native-layer", "--binary", binary, "--output", optimized, "--destination", "/usr/local/bin/worker")
	// Nix may or may not have optimized identical files into hardlinks.
	os.Remove(filepath.Join(glibc, "lib", "second"))
	writeFile(t, filepath.Join(glibc, "lib", "second"), []byte("same contents"))
	plain := filepath.Join(tmp, "plain.tar.gz")
	mustRun(t, "native-layer", "--binary", binary, "--output", plain, "--destination", "/usr/local/bin/worker")
	a, _ := os.ReadFile(optimized)
	b, _ := os.ReadFile(plain)
	if !bytes.Equal(a, b) {
		t.Error("hardlinked store files changed the layer")
	}

	byName := map[string]tarEntry{}
	var names []string
	for _, e := range readTar(t, plain) {
		byName[e.name] = e
		names = append(names, e.name)
	}
	store := strings.TrimPrefix(glibc, "/")
	for _, want := range []string{"usr/", "usr/local/", "usr/local/bin/", "usr/local/bin/worker", store + "/lib/first", store + "/lib/second"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("no %s in %v", want, names)
		}
	}
	if e := byName["usr/local/bin/worker"]; e.mode != 0o751 {
		t.Errorf("worker mode %o, want setuid dropped and execute added", e.mode)
	}
	if e := byName[store+"/lib/second"]; e.typ != '0' || e.body != "same contents" {
		t.Errorf("second is %+v", e)
	}

	// Without the store, every store reference has to be patched away.
	if _, stderr, code := runTool(t, "native-layer", "--binary", binary, "--output", filepath.Join(tmp, "x"), "--destination", "/w", "--include-nix-store=false"); code != 1 || !strings.Contains(stderr, "still references") {
		t.Errorf("an unpatched binary gave exit %d: %s", code, stderr)
	}
	// patchelf comes from the test's environment; see BUILD.
	repointed := filepath.Join(tmp, "repointed.tar.gz")
	mustRun(t, "native-layer", "--binary", binary, "--output", repointed, "--destination", "/w", "--include-nix-store=false",
		"--patchelf", os.Getenv("PATCHELF"), "--interpreter", "/lib64/ld-linux-x86-64.so.2", "--rpath", "/usr/lib")
	entries := readTar(t, repointed)
	if len(entries) != 1 || entries[0].name != "w" {
		t.Fatalf("repointed layer %+v", entries)
	}
	e, err := readELF([]byte(entries[0].body))
	if err != nil {
		t.Fatal(err)
	}
	if interp, search, _, err := e.runtimePaths(); interp != "/lib64/ld-linux-x86-64.so.2" || !reflect.DeepEqual(search, []string{"/usr/lib"}) || err != nil {
		t.Errorf("repointed to %q %q, %v", interp, search, err)
	}
	if _, stderr, code := runTool(t, "native-layer", "--binary", binary, "--output", filepath.Join(tmp, "x"), "--destination", "relative"); code != 2 || !strings.Contains(stderr, "absolute") {
		t.Errorf("a relative destination gave exit %d: %s", code, stderr)
	}
}
