// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// stateFile records, next to rootfs/, what oci_unpack wrote: the image it
// came from and each path's original metadata, which a rootless unpack
// can't keep on disk. oci_repack reads it back.
const stateFile = "oci-unpack.json"

type unpackState struct {
	Manifest Descriptor             `json:"manifest"`
	Config   jsontext.Value         `json:"config"`
	Entries  map[string]rootfsEntry `json:"entries"`
}

// rootfsEntry is one path in the root filesystem as the layers left it.
type rootfsEntry struct {
	Type   string `json:"type"` // file, dir or symlink
	Mode   int64  `json:"mode"`
	UID    int    `json:"uid"`
	GID    int    `json:"gid"`
	Size   int64  `json:"size,omitzero"`
	Digest string `json:"digest,omitempty"`
	Link   string `json:"link,omitempty"`
}

func runUnpack(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := newFlags("unpack", "--image LAYOUT [--tag TAG] --output DIR", stderr)
	image := flags.String("image", "", "image layout")
	tag := flags.String("tag", "latest", "tag of the image in the layout")
	output := flags.String("output", "", "bundle directory to write")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if err := required(flags, "image", "output"); err != nil {
		return err
	}
	return unpack(Layout{*image}, *tag, *output, stderr)
}

// unpack writes an OCI runtime bundle: rootfs/ with the image's layers
// applied in order, config.json for a runtime, and the state file.
func unpack(layout Layout, tag, out string, log io.Writer) error {
	desc, err := layout.Resolve(tag)
	if err != nil {
		return err
	}
	manifest, configData, err := layout.Image(desc)
	if err != nil {
		return err
	}
	rootfs := filepath.Join(out, "rootfs")
	if err := os.MkdirAll(rootfs, 0o755); err != nil {
		return err
	}
	root, err := os.OpenRoot(rootfs)
	if err != nil {
		return err
	}
	defer root.Close()
	u := &unpacker{root: root, meta: map[string]rootfsEntry{}, dirModes: map[string]os.FileMode{}, log: log}
	for i, layer := range manifest.Layers {
		fmt.Fprintf(log, "oci unpack: layer %d/%d, %s\n", i+1, len(manifest.Layers), layer.Digest)
		if err := u.applyLayer(layout, layer); err != nil {
			return fmt.Errorf("layer %s: %w", layer.Digest, err)
		}
	}
	if u.skipped > 0 {
		fmt.Fprintf(log, "oci unpack: skipped %d device nodes and fifos, which a rootless unpack can't create\n", u.skipped)
	}
	// Directories get their modes last, so that a read-only one could still
	// be filled. The owner can always enter them, so Buck can read and
	// remove the bundle.
	for p, mode := range u.dirModes {
		if err := root.Chmod(rootPath(p), mode|0o700); err != nil {
			return err
		}
	}
	for p, e := range u.meta {
		if e.Type == "file" {
			digest, size, err := fileDigest(filepath.Join(rootfs, p))
			if err != nil {
				return err
			}
			e.Digest, e.Size = digest, size
			u.meta[p] = e
		}
	}
	state := unpackState{Manifest: desc, Config: configData, Entries: u.meta}
	state.Manifest.Annotations = nil
	if err := os.WriteFile(filepath.Join(out, stateFile), marshal(state), 0o644); err != nil {
		return err
	}
	spec, err := runtimeSpec(configData, rootfs)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "config.json"), marshal(spec), 0o644)
}

type unpacker struct {
	root     *os.Root
	meta     map[string]rootfsEntry // cleaned path, relative to rootfs -> entry
	dirModes map[string]os.FileMode
	skipped  int
	log      io.Writer
}

// rootPath is a cleaned relative path as os.Root wants it.
func rootPath(p string) string {
	if p == "" {
		return "."
	}
	return p
}

// cleanName turns a tar entry's name into a path below the root, refusing
// one that climbs out of it.
func cleanName(name string) (string, error) {
	p := path.Clean("/" + name)
	if p == "/" {
		return "", nil
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", fmt.Errorf("%q leaves the root filesystem", name)
		}
	}
	return p[1:], nil
}

// resolveParent follows symlinks in p's directory the way a chroot would,
// with absolute targets starting again at the root, and returns p with a
// directory that contains no symlinks. The last component is not followed.
func (u *unpacker) resolveParent(p string) (string, error) {
	dir, base := path.Split(p)
	resolved, err := u.resolve(strings.TrimSuffix(dir, "/"), 0)
	if err != nil {
		return "", err
	}
	return path.Join(resolved, base), nil
}

func (u *unpacker) resolve(p string, depth int) (string, error) {
	if depth > 40 {
		return "", fmt.Errorf("too many levels of symbolic links resolving %q", p)
	}
	current := ""
	parts := strings.Split(p, "/")
	for i, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			current = path.Dir(current)
			if current == "." {
				current = ""
			}
			continue
		}
		next := path.Join(current, part)
		info, err := u.root.Lstat(next)
		if errors.Is(err, fs.ErrNotExist) {
			// The rest doesn't exist yet and will be created as directories.
			return path.Join(append([]string{next}, parts[i+1:]...)...), nil
		} else if err != nil {
			return "", err
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			current = next
			continue
		}
		target, err := u.root.Readlink(next)
		if err != nil {
			return "", err
		}
		rest := strings.Join(parts[i+1:], "/")
		if !path.IsAbs(target) {
			target = path.Join("/", current, target)
		}
		return u.resolve(strings.TrimPrefix(path.Join(target, rest), "/"), depth+1)
	}
	return current, nil
}

// forget drops metadata for p and everything below it.
func (u *unpacker) forget(p string) {
	for q := range u.meta {
		if q == p || strings.HasPrefix(q, p+"/") {
			delete(u.meta, q)
			delete(u.dirModes, q)
		}
	}
}

func (u *unpacker) applyLayer(layout Layout, desc Descriptor) error {
	blob, err := layout.blobPath(desc.Digest)
	if err != nil {
		return err
	}
	f, err := os.Open(blob)
	if err != nil {
		return err
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 1<<20)
	magic, _ := br.Peek(4)
	var r io.Reader = br
	switch compressionOf(magic) {
	case "gzip":
		zr, err := gzip.NewReader(br)
		if err != nil {
			return err
		}
		r = zr
	case "zstd":
		return errors.New("zstd layers are not supported")
	}

	created := map[string]bool{}
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		name, err := cleanName(hdr.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		dir, base := path.Split(name)
		dir = strings.TrimSuffix(dir, "/")
		if base == ".wh..wh..opq" {
			// Everything below dir that a lower layer put there goes.
			resolved, err := u.resolve(dir, 0)
			if err != nil {
				return err
			}
			entries, err := fs.ReadDir(u.root.FS(), rootPath(resolved))
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
			for _, e := range entries {
				child := path.Join(resolved, e.Name())
				if !created[child] {
					if err := u.root.RemoveAll(child); err != nil {
						return err
					}
					u.forget(child)
				}
			}
			continue
		}
		if strings.HasPrefix(base, ".wh.") {
			target, err := u.resolveParent(path.Join(dir, strings.TrimPrefix(base, ".wh.")))
			if err != nil {
				return err
			}
			if err := u.root.RemoveAll(target); err != nil {
				return err
			}
			u.forget(target)
			continue
		}
		target, err := u.resolveParent(name)
		if err != nil {
			return err
		}
		if err := u.create(target, hdr, tr); err != nil {
			return fmt.Errorf("%s: %w", hdr.Name, err)
		}
		created[target] = true
	}
}

func (u *unpacker) create(target string, hdr *tar.Header, r io.Reader) error {
	if hdr.Typeflag == tar.TypeChar || hdr.Typeflag == tar.TypeBlock || hdr.Typeflag == tar.TypeFifo {
		u.skipped++
		return nil
	}
	if parent := path.Dir(target); parent != "." {
		if err := u.mkdirParents(parent); err != nil {
			return err
		}
	}
	existing, err := u.root.Lstat(target)
	exists := err == nil
	if exists && !(existing.IsDir() && hdr.Typeflag == tar.TypeDir) {
		if err := u.root.RemoveAll(target); err != nil {
			return err
		}
		u.forget(target)
	}
	entry := rootfsEntry{Mode: hdr.Mode & 0o7777, UID: hdr.Uid, GID: hdr.Gid}
	switch hdr.Typeflag {
	case tar.TypeDir:
		entry.Type = "dir"
		if !exists || !existing.IsDir() {
			if err := u.root.Mkdir(target, 0o700); err != nil {
				return err
			}
		}
		u.dirModes[target] = os.FileMode(entry.Mode) & os.ModePerm
	case tar.TypeReg, tar.TypeRegA:
		entry.Type = "file"
		f, err := u.root.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, r)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
		if err := u.root.Chmod(target, fileMode(entry.Mode)); err != nil {
			return err
		}
	case tar.TypeSymlink:
		entry.Type, entry.Link = "symlink", hdr.Linkname
		if err := u.root.Symlink(hdr.Linkname, target); err != nil {
			return err
		}
	case tar.TypeLink:
		linkName, err := cleanName(hdr.Linkname)
		if err != nil {
			return err
		}
		source, err := u.resolveParent(linkName)
		if err != nil {
			return err
		}
		if err := u.root.Link(source, target); err != nil {
			return err
		}
		if e, ok := u.meta[source]; ok {
			entry = e
		} else {
			entry.Type = "file"
		}
	default:
		return fmt.Errorf("unsupported tar entry type %q", hdr.Typeflag)
	}
	u.meta[target] = entry
	return nil
}

// fileMode keeps a file's permission and setuid, setgid and sticky bits,
// with read access for the owner added so Buck can hash it.
func fileMode(mode int64) os.FileMode {
	m := os.FileMode(mode&0o777) | 0o400
	if mode&0o4000 != 0 {
		m |= os.ModeSetuid
	}
	if mode&0o2000 != 0 {
		m |= os.ModeSetgid
	}
	if mode&0o1000 != 0 {
		m |= os.ModeSticky
	}
	return m
}

// mkdirParents creates the missing directories of a symlink-free path, the
// way a layer that lists a file without its directory implies them.
func (u *unpacker) mkdirParents(dir string) error {
	current := ""
	for _, part := range strings.Split(dir, "/") {
		current = path.Join(current, part)
		info, err := u.root.Lstat(current)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("%s is not a directory", current)
			}
			continue
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := u.root.Mkdir(current, 0o700); err != nil {
			return err
		}
		u.meta[current] = rootfsEntry{Type: "dir", Mode: 0o755}
		u.dirModes[current] = 0o755
	}
	return nil
}

// runtimeSpec converts an image config to an OCI runtime configuration for
// a rootless container, following the image specification's conversion
// rules, with the mounts and namespaces runc spec --rootless uses.
func runtimeSpec(configData []byte, rootfs string) (map[string]any, error) {
	var image struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Created      string `json:"created"`
		Author       string `json:"author"`
		Config       struct {
			User         string              `json:"User"`
			Env          []string            `json:"Env"`
			Entrypoint   []string            `json:"Entrypoint"`
			Cmd          []string            `json:"Cmd"`
			WorkingDir   string              `json:"WorkingDir"`
			Labels       map[string]string   `json:"Labels"`
			ExposedPorts map[string]struct{} `json:"ExposedPorts"`
			StopSignal   string              `json:"StopSignal"`
		} `json:"config"`
	}
	if err := decodeJSON(configData, &image); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	c := image.Config
	uid, gid, err := resolveUser(rootfs, c.User)
	if err != nil {
		return nil, err
	}
	cwd := c.WorkingDir
	if cwd == "" {
		cwd = "/"
	}
	annotations := map[string]string{}
	for k, v := range c.Labels {
		annotations[k] = v
	}
	set := func(key, value string) {
		if value != "" {
			annotations[key] = value
		}
	}
	set("org.opencontainers.image.os", image.OS)
	set("org.opencontainers.image.architecture", image.Architecture)
	set("org.opencontainers.image.created", image.Created)
	set("org.opencontainers.image.author", image.Author)
	set("org.opencontainers.image.stopSignal", c.StopSignal)
	if len(c.ExposedPorts) > 0 {
		ports := sortedKeys(c.ExposedPorts)
		annotations["org.opencontainers.image.exposedPorts"] = strings.Join(ports, ",")
	}
	mount := func(dest, typ, source string, options ...string) map[string]any {
		return map[string]any{"destination": dest, "type": typ, "source": source, "options": options}
	}
	idMap := func(host int) []map[string]int {
		return []map[string]int{{"containerID": 0, "hostID": host, "size": 1}}
	}
	return map[string]any{
		"ociVersion": "1.0.2",
		"process": map[string]any{
			"terminal":        false,
			"user":            map[string]int{"uid": uid, "gid": gid},
			"args":            append(append([]string{}, c.Entrypoint...), c.Cmd...),
			"env":             c.Env,
			"cwd":             cwd,
			"noNewPrivileges": true,
		},
		"root":        map[string]any{"path": "rootfs", "readonly": false},
		"hostname":    "oci",
		"annotations": annotations,
		"mounts": []map[string]any{
			mount("/proc", "proc", "proc"),
			mount("/dev", "tmpfs", "tmpfs", "nosuid", "strictatime", "mode=755", "size=65536k"),
			mount("/dev/pts", "devpts", "devpts", "nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"),
			mount("/dev/shm", "tmpfs", "shm", "nosuid", "noexec", "nodev", "mode=1777", "size=65536k"),
			mount("/dev/mqueue", "mqueue", "mqueue", "nosuid", "noexec", "nodev"),
			mount("/sys", "none", "/sys", "rbind", "nosuid", "noexec", "nodev", "ro"),
		},
		"linux": map[string]any{
			"uidMappings": idMap(os.Getuid()),
			"gidMappings": idMap(os.Getgid()),
			"namespaces": []map[string]string{
				{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "user"}, {"type": "cgroup"},
			},
			"maskedPaths":   []string{"/proc/kcore", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/sys/firmware"},
			"readonlyPaths": []string{"/proc/asound", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"},
		},
	}, nil
}

// resolveUser turns an image's User, name or number with an optional
// group, into ids, reading names from the image's /etc/passwd and
// /etc/group.
func resolveUser(rootfs, user string) (int, int, error) {
	if user == "" {
		return 0, 0, nil
	}
	userPart, groupPart, hasGroup := strings.Cut(user, ":")
	lookup := func(file, name string) (int, int, bool) {
		data, err := os.ReadFile(filepath.Join(rootfs, "etc", file))
		if err != nil {
			return 0, 0, false
		}
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Split(line, ":")
			if len(fields) >= 4 && fields[0] == name {
				id, err1 := strconv.Atoi(fields[2])
				gid, err2 := strconv.Atoi(fields[3])
				if file == "group" {
					gid, err2 = id, nil
				}
				return id, gid, err1 == nil && err2 == nil
			}
		}
		return 0, 0, false
	}
	uid, gid := 0, 0
	if n, err := strconv.Atoi(userPart); err == nil {
		uid = n
	} else if id, primary, ok := lookup("passwd", userPart); ok {
		uid, gid = id, primary
	} else {
		return 0, 0, fmt.Errorf("user %q is not in the image's /etc/passwd", userPart)
	}
	if hasGroup {
		if n, err := strconv.Atoi(groupPart); err == nil {
			gid = n
		} else if id, _, ok := lookup("group", groupPart); ok {
			gid = id
		} else {
			return 0, 0, fmt.Errorf("group %q is not in the image's /etc/group", groupPart)
		}
	}
	return uid, gid, nil
}

// readState reads a bundle's state file.
func readState(bundle string) (*unpackState, error) {
	data, err := os.ReadFile(filepath.Join(bundle, stateFile))
	if err != nil {
		return nil, fmt.Errorf("%s is not a bundle from oci_unpack: %w", bundle, err)
	}
	var s unpackState
	if err := decodeJSON(data, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", stateFile, err)
	}
	return &s, nil
}

// sortedPaths returns a state's paths in archive order.
func sortedPaths(entries map[string]rootfsEntry) []string {
	paths := make([]string, 0, len(entries))
	for p := range entries {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}
