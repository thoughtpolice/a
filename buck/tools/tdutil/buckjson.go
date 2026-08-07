// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

type target struct {
	label           string
	name            string
	packageName     string
	repoPackage     string
	ruleType        string
	deps            []string
	inputs          []string
	targetHash      string
	labels          []string
	ciSrcs          []string
	ciSrcsMustMatch []string
	ciDeps          []string
}

func (t target) ruleFile() (string, bool) {
	separator := strings.LastIndexByte(t.ruleType, ':')
	if separator < 0 {
		return "", false
	}
	file := t.ruleType[:separator]
	return file, strings.Contains(file, "//")
}

type fileNode struct {
	cellPath    string
	path        *string
	packageName *string
	repoPackage *string
	imports     []string
}

type snapshot struct {
	targets map[string]target
	files   map[string]fileNode
	cells   cellMap
}

func emptySnapshot(cells cellMap) snapshot {
	return snapshot{
		targets: make(map[string]target),
		files:   make(map[string]fileNode),
		cells:   cells,
	}
}

// targetStreamParser accumulates the `buck2 targets` JSONL stream one line at
// a time so a dump never needs to be held in memory wholesale. The first
// defect wins and is reported with its 1-based physical line number; later
// lines are still counted but otherwise ignored.
type targetStreamParser struct {
	result snapshot
	config tdutilConfig
	line   int
	err    error
}

func newTargetStreamParser(cells cellMap, config tdutilConfig) *targetStreamParser {
	return &targetStreamParser{result: emptySnapshot(cells), config: config}
}

func (parser *targetStreamParser) consume(line []byte) {
	parser.line++
	if parser.err != nil {
		return
	}
	parser.err = parser.parseLine(line, parser.line)
}

func (parser *targetStreamParser) finish() (snapshot, error) {
	if parser.err != nil {
		return snapshot{}, parser.err
	}
	return parser.result, nil
}

func (parser *targetStreamParser) parseLine(line []byte, number int) error {
	if len(bytes.TrimSpace(line)) == 0 {
		return nil
	}
	if !utf8.Valid(line) {
		return fmt.Errorf("`buck2 targets` produced non-UTF-8 stdout")
	}
	if err := validateJSONUnicodeEscapes(line); err != nil {
		return fmt.Errorf("malformed target JSON on output line %d: %w", number, err)
	}
	var object map[string]any
	if err := json.Unmarshal(line, &object); err != nil {
		return fmt.Errorf("malformed target JSON on output line %d: %w", number, err)
	}
	if object == nil {
		return fmt.Errorf("target output line %d is not a JSON object", number)
	}

	// tdutil does not pass --keep-going, so buck2 aborts on a loading error
	// rather than reporting one inline. A record here means buck2 grew a way to
	// emit one that we have not accounted for; the graph would be silently
	// incomplete, so refuse rather than determine against it.
	if _, ok := object["buck.error"]; ok {
		diagnostic, err := requiredString(object, "buck.error")
		if err != nil {
			return fmt.Errorf("invalid error record on output line %d: %w", number, err)
		}
		return fmt.Errorf("`buck2 targets` reported a graph error on output line %d: %s", number, diagnostic)
	}
	_, hasImports := object["buck.imports"]
	_, hasFile := object["buck.file"]
	if hasImports || hasFile {
		file, err := parseFileRecord(object, parser.result.cells)
		if err != nil {
			return fmt.Errorf("invalid import record on output line %d: %w", number, err)
		}
		if _, exists := parser.result.files[file.cellPath]; exists {
			return fmt.Errorf("duplicate import record on output line %d", number)
		}
		parser.result.files[file.cellPath] = file
		return nil
	}
	_, hasName := object["name"]
	_, hasHash := object["buck.target_hash"]
	if hasName || hasHash {
		target, err := parseTargetRecord(object, parser.result.cells, parser.config)
		if err != nil {
			return fmt.Errorf("invalid target record on output line %d: %w", number, err)
		}
		if _, exists := parser.result.targets[target.label]; exists {
			return fmt.Errorf("duplicate target record on output line %d", number)
		}
		parser.result.targets[target.label] = target
		return nil
	}
	return fmt.Errorf("unknown record shape on `buck2 targets` output line %d", number)
}

// encoding/json replaces lone UTF-16 surrogate escapes with U+FFFD, while
// serde_json rejects them when decoding strings. Validate this one permissive
// edge up front so the two implementations fail closed on the same input.
func validateJSONUnicodeEscapes(data []byte) error {
	inString := false
	for index := 0; index < len(data); index++ {
		switch data[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(data) {
				continue
			}
			if data[index+1] != 'u' {
				index++
				continue
			}
			value, ok := jsonHexQuad(data, index+2)
			if !ok {
				continue // encoding/json will provide the syntax error.
			}
			if value >= 0xdc00 && value <= 0xdfff {
				return fmt.Errorf("lone trailing surrogate escape near byte %d", index)
			}
			if value >= 0xd800 && value <= 0xdbff {
				if index+12 > len(data) || data[index+6] != '\\' || data[index+7] != 'u' {
					return fmt.Errorf("lone leading surrogate escape near byte %d", index)
				}
				trailing, ok := jsonHexQuad(data, index+8)
				if !ok || trailing < 0xdc00 || trailing > 0xdfff {
					return fmt.Errorf("lone leading surrogate escape near byte %d", index)
				}
				index += 11
				continue
			}
			index += 5
		}
	}
	return nil
}

func jsonHexQuad(data []byte, start int) (uint16, bool) {
	if start+4 > len(data) {
		return 0, false
	}
	var result uint16
	for _, value := range data[start : start+4] {
		result <<= 4
		switch {
		case value >= '0' && value <= '9':
			result += uint16(value - '0')
		case value >= 'a' && value <= 'f':
			result += uint16(value-'a') + 10
		case value >= 'A' && value <= 'F':
			result += uint16(value-'A') + 10
		default:
			return 0, false
		}
	}
	return result, true
}

func parseTargetRecord(object map[string]any, cells cellMap, config tdutilConfig) (target, error) {
	name, err := requiredString(object, "name")
	if err != nil {
		return target{}, err
	}
	packageName, err := requiredString(object, "buck.package")
	if err != nil {
		return target{}, err
	}
	repoPackage, err := cells.toRepoPath(packageName)
	if err != nil {
		return target{}, err
	}
	if repoPackage == nil {
		return target{}, fmt.Errorf("target package `%s` is outside the JJ workspace", packageName)
	}
	ruleType, err := requiredString(object, "buck.type")
	if err != nil {
		return target{}, err
	}
	deps, err := requiredStringArray(object, "buck.deps")
	if err != nil {
		return target{}, err
	}
	cellInputs, err := requiredStringArray(object, "buck.inputs")
	if err != nil {
		return target{}, err
	}
	inputs := make([]string, 0, len(cellInputs))
	for _, input := range cellInputs {
		path, err := cells.toRepoPath(input)
		if err != nil {
			return target{}, err
		}
		if path != nil {
			inputs = append(inputs, *path)
		}
	}
	hashField := "buck.hash"
	if _, ok := object["buck.target_hash"]; ok {
		hashField = "buck.target_hash"
	}
	targetHash, err := requiredString(object, hashField)
	if err != nil {
		return target{}, err
	}
	labels, err := optionalStringArray(object, "labels")
	if err != nil {
		return target{}, err
	}
	// Read under the repository's own names, but stored — and serialized into
	// snapshots — under tdutil's, so the document shape stays the same
	// whatever a repository calls its CI metadata.
	ciSrcs, err := optionalStringArray(object, config.ciSrcsAttribute)
	if err != nil {
		return target{}, err
	}
	ciSrcsMustMatch, err := optionalStringArray(object, config.ciSrcsMustMatch)
	if err != nil {
		return target{}, err
	}
	ciDeps, err := optionalStringArray(object, config.ciDepsAttribute)
	if err != nil {
		return target{}, err
	}
	return target{
		label:           packageName + ":" + name,
		name:            name,
		packageName:     packageName,
		repoPackage:     *repoPackage,
		ruleType:        ruleType,
		deps:            deps,
		inputs:          inputs,
		targetHash:      targetHash,
		labels:          labels,
		ciSrcs:          ciSrcs,
		ciSrcsMustMatch: ciSrcsMustMatch,
		ciDeps:          ciDeps,
	}, nil
}

func parseFileRecord(object map[string]any, cells cellMap) (fileNode, error) {
	cellPath, err := requiredString(object, "buck.file")
	if err != nil {
		return fileNode{}, err
	}
	path, err := cells.toRepoPath(cellPath)
	if err != nil {
		return fileNode{}, err
	}
	packageName, err := optionalString(object, "buck.package")
	if err != nil {
		return fileNode{}, err
	}
	var repoPackage *string
	if packageName != nil {
		repoPackage, err = cells.toRepoPath(*packageName)
		if err != nil {
			return fileNode{}, err
		}
	}
	cellImports, err := requiredStringArray(object, "buck.imports")
	if err != nil {
		return fileNode{}, err
	}
	imports := make([]string, 0, len(cellImports))
	for _, imported := range cellImports {
		repoPath, err := cells.toRepoPath(imported)
		if err != nil {
			return fileNode{}, err
		}
		if repoPath != nil {
			imports = append(imports, *repoPath)
		}
	}
	return fileNode{
		cellPath:    cellPath,
		path:        path,
		packageName: packageName,
		repoPackage: repoPackage,
		imports:     imports,
	}, nil
}

func requiredString(object map[string]any, key string) (string, error) {
	value, ok := object[key]
	if !ok {
		return "", fmt.Errorf("missing required field `%s`", key)
	}
	result, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("field `%s` is not a string", key)
	}
	return result, nil
}

func optionalString(object map[string]any, key string) (*string, error) {
	value, ok := object[key]
	if !ok || value == nil {
		return nil, nil
	}
	result, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("field `%s` is not a string", key)
	}
	return &result, nil
}

func requiredStringArray(object map[string]any, key string) ([]string, error) {
	value, ok := object[key]
	if !ok {
		return nil, fmt.Errorf("missing required field `%s`", key)
	}
	return stringArray(value, key)
}

func optionalStringArray(object map[string]any, key string) ([]string, error) {
	value, ok := object[key]
	if !ok || value == nil {
		return []string{}, nil
	}
	return stringArray(value, key)
}

func stringArray(value any, key string) ([]string, error) {
	values, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("field `%s` is not an array", key)
	}
	result := make([]string, 0, len(values))
	for index, value := range values {
		item, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("field `%s` item %d is not a string", key, index)
		}
		result = append(result, item)
	}
	return result, nil
}
