// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

type metadata struct {
	baseRevset string
	headRevset string
	baseCommit string
	headCommit string
	universe   []string
}

type jsonTarget struct {
	Target      string  `json:"target"`
	Depth       int     `json:"depth"`
	Reason      string  `json:"reason"`
	AffectedDep *string `json:"affected_dep"`
}

type jsonDocument struct {
	Base       string       `json:"base"`
	Head       string       `json:"head"`
	BaseCommit string       `json:"base_commit"`
	HeadCommit string       `json:"head_commit"`
	Universe   []string     `json:"universe"`
	Count      int          `json:"count"`
	Targets    []jsonTarget `json:"targets"`
}

func render(output io.Writer, format outputFormat, meta *metadata, targets []affectedTarget) error {
	output = strictWriter{Writer: output}
	switch format {
	case formatText:
		for _, target := range targets {
			if !utf8.ValidString(target.target) {
				return fmt.Errorf("target label is not valid UTF-8")
			}
			if _, err := io.WriteString(output, target.target+"\n"); err != nil {
				return err
			}
		}
		return nil
	case formatJSON:
		converted, err := targetsForJSON(targets)
		if err != nil {
			return err
		}
		if err := validateMetadata(meta); err != nil {
			return err
		}
		document := jsonDocument{
			Base:       meta.baseRevset,
			Head:       meta.headRevset,
			BaseCommit: meta.baseCommit,
			HeadCommit: meta.headCommit,
			Universe:   nonNilStrings(meta.universe),
			Count:      len(converted),
			Targets:    nonNilJSONTargets(converted),
		}
		encoder := json.NewEncoder(output)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		return encoder.Encode(document)
	case formatJSONLines:
		converted, err := targetsForJSON(targets)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(output)
		encoder.SetEscapeHTML(false)
		for _, target := range converted {
			if err := encoder.Encode(target); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unknown output format %d", format)
	}
}

type strictWriter struct {
	io.Writer
}

func (writer strictWriter) Write(contents []byte) (int, error) {
	written, err := writer.Writer.Write(contents)
	if err == nil && written != len(contents) {
		return written, io.ErrShortWrite
	}
	return written, err
}

func targetsForJSON(targets []affectedTarget) ([]jsonTarget, error) {
	result := make([]jsonTarget, 0, len(targets))
	for _, target := range targets {
		if !utf8.ValidString(target.target) || !utf8.ValidString(target.reason) || (target.affectedDep != nil && !utf8.ValidString(*target.affectedDep)) {
			return nil, fmt.Errorf("cannot encode invalid UTF-8 as JSON")
		}
		result = append(result, jsonTarget{
			Target:      target.target,
			Depth:       target.depth,
			Reason:      target.reason,
			AffectedDep: target.affectedDep,
		})
	}
	return result, nil
}

func validateMetadata(meta *metadata) error {
	if !utf8.ValidString(meta.baseRevset) || !utf8.ValidString(meta.headRevset) || !utf8.ValidString(meta.baseCommit) || !utf8.ValidString(meta.headCommit) {
		return fmt.Errorf("cannot encode invalid UTF-8 as JSON")
	}
	for _, pattern := range meta.universe {
		if !utf8.ValidString(pattern) {
			return fmt.Errorf("cannot encode invalid UTF-8 as JSON")
		}
	}
	return nil
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nonNilJSONTargets(values []jsonTarget) []jsonTarget {
	if values == nil {
		return []jsonTarget{}
	}
	return values
}
