// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
)

// nupkg is one downloaded package: its manifest, the files it carries and
// the hashes the lock records.
type nupkg struct {
	ID      string
	Version string
	Groups  []dependencyGroup
	Entries []string
	SHA256  string
	SHA512  string
	data    []byte
}

// dependencyGroup is one <group> of the nuspec's dependencies; Framework is
// empty for the group that applies to every framework.
type dependencyGroup struct {
	Framework    string
	Dependencies []dependency
}

type dependency struct {
	ID    string
	Range string
}

type nuspecXML struct {
	Metadata struct {
		ID           string `xml:"id"`
		Version      string `xml:"version"`
		Dependencies struct {
			Groups       []groupXML      `xml:"group"`
			Dependencies []dependencyXML `xml:"dependency"`
		} `xml:"dependencies"`
	} `xml:"metadata"`
}

type groupXML struct {
	Framework    string          `xml:"targetFramework,attr"`
	Dependencies []dependencyXML `xml:"dependency"`
}

type dependencyXML struct {
	ID      string `xml:"id,attr"`
	Version string `xml:"version,attr"`
	Exclude string `xml:"exclude,attr"`
}

func readNupkg(data []byte) (*nupkg, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("not a zip file: %w", err)
	}
	result := &nupkg{data: data}
	var nuspec *zip.File
	for _, file := range reader.File {
		name := file.Name
		if strings.HasSuffix(name, "/") {
			continue
		}
		result.Entries = append(result.Entries, name)
		if !strings.Contains(name, "/") && strings.HasSuffix(strings.ToLower(name), ".nuspec") {
			nuspec = file
		}
	}
	if nuspec == nil {
		return nil, fmt.Errorf("no .nuspec at the root of the package")
	}
	opened, err := nuspec.Open()
	if err != nil {
		return nil, err
	}
	defer opened.Close()
	var parsed nuspecXML
	if err := xml.NewDecoder(opened).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("%s: %w", nuspec.Name, err)
	}
	if parsed.Metadata.ID == "" || parsed.Metadata.Version == "" {
		return nil, fmt.Errorf("%s: missing id or version", nuspec.Name)
	}
	result.ID = parsed.Metadata.ID
	parsedVersion, err := parseVersion(parsed.Metadata.Version)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", nuspec.Name, err)
	}
	result.Version = parsedVersion.String()
	// Dependencies listed outside any group apply everywhere, the same as a
	// group without a targetFramework.
	if len(parsed.Metadata.Dependencies.Dependencies) > 0 {
		parsed.Metadata.Dependencies.Groups = append(parsed.Metadata.Dependencies.Groups, groupXML{
			Dependencies: parsed.Metadata.Dependencies.Dependencies,
		})
	}
	for _, group := range parsed.Metadata.Dependencies.Groups {
		converted := dependencyGroup{Framework: group.Framework}
		for _, dep := range group.Dependencies {
			if excludesEverything(dep.Exclude) {
				continue
			}
			converted.Dependencies = append(converted.Dependencies, dependency{ID: dep.ID, Range: dep.Version})
		}
		result.Groups = append(result.Groups, converted)
	}
	sum256 := sha256.Sum256(data)
	sum512 := sha512.Sum512(data)
	result.SHA256 = hex.EncodeToString(sum256[:])
	result.SHA512 = base64.StdEncoding.EncodeToString(sum512[:])
	return result, nil
}

// excludesEverything reports whether a dependency's exclude list removes
// both its compile and runtime assets, which leaves nothing this build can
// consume from it.
func excludesEverything(exclude string) bool {
	compile, runtime := false, false
	for _, asset := range strings.Split(exclude, ",") {
		switch strings.ToLower(strings.TrimSpace(asset)) {
		case "all":
			return true
		case "compile":
			compile = true
		case "runtime":
			runtime = true
		}
	}
	return compile && runtime
}

// dependenciesFor picks the nuspec dependency group for the target the way
// NuGet does: the nearest framework-specific group, else the group that
// applies everywhere, else nothing.
func (p *nupkg) dependenciesFor(target framework) []dependency {
	var candidates []string
	var fallback *dependencyGroup
	for index := range p.Groups {
		group := &p.Groups[index]
		if group.Framework == "" {
			fallback = group
			continue
		}
		candidates = append(candidates, group.Framework)
	}
	if chosen, ok := nearest(target, candidates); ok {
		for index := range p.Groups {
			if p.Groups[index].Framework == chosen {
				return p.Groups[index].Dependencies
			}
		}
	}
	if fallback != nil {
		return fallback.Dependencies
	}
	return nil
}

// assets finds the lib/ folder the target consumes and the assemblies in
// it. A folder holding only the `_._` placeholder, or no lib/ folder at
// all, means the package contributes no assemblies (analyzers, tools and
// meta-packages), which is not an error.
func (p *nupkg) assets(target framework) (folder string, assemblies, symbols []string, err error) {
	folders := make(map[string]string) // lower-cased TFM -> folder as spelled
	for _, entry := range p.Entries {
		parts := strings.Split(entry, "/")
		if len(parts) < 3 || !strings.EqualFold(parts[0], "lib") {
			continue
		}
		folders[strings.ToLower(parts[1])] = parts[0] + "/" + parts[1]
	}
	if len(folders) == 0 {
		return "", nil, nil, nil
	}
	candidates := make([]string, 0, len(folders))
	for tfm := range folders {
		candidates = append(candidates, tfm)
	}
	sort.Strings(candidates)
	chosen, ok := nearest(target, candidates)
	if !ok {
		return "", nil, nil, fmt.Errorf("%s %s has no lib/ folder compatible with %s (found %s)", p.ID, p.Version, target.text, strings.Join(candidates, ", "))
	}
	folder = folders[chosen]
	present := make(map[string]struct{})
	for _, entry := range p.Entries {
		if !strings.HasPrefix(strings.ToLower(entry), strings.ToLower(folder)+"/") {
			continue
		}
		name := entry[len(folder)+1:]
		if strings.Contains(name, "/") {
			continue
		}
		present[name] = struct{}{}
	}
	for name := range present {
		if strings.EqualFold(path.Ext(name), ".dll") {
			assemblies = append(assemblies, strings.TrimSuffix(name, path.Ext(name)))
		}
	}
	sort.Strings(assemblies)
	for _, assembly := range assemblies {
		if _, ok := present[assembly+".pdb"]; ok {
			symbols = append(symbols, assembly)
		}
	}
	if len(assemblies) == 0 {
		return "", nil, nil, nil
	}
	return folder, assemblies, symbols, nil
}

// file returns one entry's contents.
func (p *nupkg) file(name string) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(p.data), int64(len(p.data)))
	if err != nil {
		return nil, err
	}
	for _, entry := range reader.File {
		if strings.EqualFold(entry.Name, name) {
			opened, err := entry.Open()
			if err != nil {
				return nil, err
			}
			defer opened.Close()
			return io.ReadAll(opened)
		}
	}
	return nil, fmt.Errorf("%s %s does not contain %s", p.ID, p.Version, name)
}
