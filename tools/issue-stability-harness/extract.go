package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var transcriptName = regexp.MustCompile(`^(\d+)-(.+)-claudecode_radar\.log$`)

type transcriptEnvelope struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type contentBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	ToolUseID string          `json:"tool_use_id"`
	Text      string          `json:"text"`
	Content   json.RawMessage `json:"content"`
}

func extractDirectory(inputDir string, excluded map[int]bool) (Corpus, error) {
	entries, err := os.ReadDir(inputDir)
	if err != nil {
		return Corpus{}, err
	}
	run, err := extractRunProvenance(inputDir)
	if err != nil {
		return Corpus{}, err
	}

	var fixtures []ScenarioFixture
	fieldSet := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := transcriptName.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		var id int
		if _, err := fmt.Sscanf(match[1], "%d", &id); err != nil {
			return Corpus{}, fmt.Errorf("parse scenario id from %q: %w", entry.Name(), err)
		}
		if excluded[id] {
			continue
		}
		fixture, fields, err := extractTranscript(filepath.Join(inputDir, entry.Name()), id, match[2])
		if err != nil {
			return Corpus{}, err
		}
		fixtures = append(fixtures, fixture)
		for field := range fields {
			fieldSet[field] = true
		}
	}
	sort.Slice(fixtures, func(i, j int) bool { return fixtures[i].ID < fixtures[j].ID })
	fields := make([]string, 0, len(fieldSet))
	for field := range fieldSet {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return Corpus{
		SchemaVersion: corpusSchemaVersion,
		Source:        filepath.Base(filepath.Clean(inputDir)),
		Run:           run,
		WireFields:    fields,
		Scenarios:     fixtures,
	}, nil
}

func extractRunProvenance(inputDir string) (*BenchmarkRunProvenance, error) {
	path := filepath.Join(inputDir, "STATUS.txt")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	run := &BenchmarkRunProvenance{
		StatusFile: Provenance{File: filepath.Base(path), SHA256: hex.EncodeToString(sum[:])},
	}
	for _, line := range strings.Split(string(data), "\n") {
		switch {
		case strings.HasPrefix(line, "SREGym branch:"):
			run.SREGymRevision = revisionAtEnd(line)
		case strings.HasPrefix(line, "SREGym-applications submodule:"):
			run.ApplicationsRevision = revisionAtEnd(line)
		case strings.HasPrefix(line, "Radar binary:"):
			run.RadarRevision = revisionAtEnd(line)
		}
	}
	if run.SREGymRevision == "" || run.ApplicationsRevision == "" || run.RadarRevision == "" {
		return nil, fmt.Errorf("parse benchmark revisions from %s", path)
	}
	return run, nil
}

func revisionAtEnd(line string) string {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}

func extractTranscript(path string, id int, name string) (ScenarioFixture, map[string]bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ScenarioFixture{}, nil, err
	}
	sum := sha256.Sum256(data)
	fixture := ScenarioFixture{
		ID:   id,
		Name: name,
		Provenance: Provenance{
			File:   filepath.Base(path),
			SHA256: hex.EncodeToString(sum[:]),
		},
	}
	fields := map[string]bool{}
	toolNames := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		fixture.Stats.Lines++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var envelope transcriptEnvelope
		if err := json.Unmarshal(line, &envelope); err != nil {
			fixture.Stats.MalformedJSON++
			continue
		}
		fixture.Stats.JSONLines++
		blocks, err := decodeBlocks(envelope.Message.Content)
		if err != nil {
			continue
		}
		if envelope.Type == "assistant" {
			for _, block := range blocks {
				if block.Type == "tool_use" && block.ID != "" {
					toolNames[block.ID] = block.Name
					if isIssuesTool(block.Name) {
						fixture.Stats.IssueToolCalls++
					}
				}
			}
			continue
		}
		if envelope.Type != "user" {
			continue
		}
		for _, block := range blocks {
			if block.Type != "tool_result" || !isIssuesTool(toolNames[block.ToolUseID]) {
				continue
			}
			texts, err := decodeTextContent(block.Content)
			if err != nil {
				continue
			}
			for _, text := range texts {
				issues, issueFields, ok := decodeIssuesPayload(text)
				if !ok {
					continue
				}
				for field := range issueFields {
					fields[field] = true
				}
				fixture.Snapshots = append(fixture.Snapshots, Snapshot{
					Sequence:   len(fixture.Snapshots) + 1,
					CapturedAt: envelope.Timestamp,
					Line:       fixture.Stats.Lines,
					ToolCallID: block.ToolUseID,
					Issues:     issues,
				})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return ScenarioFixture{}, nil, fmt.Errorf("scan %s: %w", path, err)
	}
	return fixture, fields, nil
}

func decodeBlocks(raw json.RawMessage) ([]contentBlock, error) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		return blocks, nil
	}
	return nil, fmt.Errorf("message content is not a block array")
}

func decodeTextContent(raw json.RawMessage) ([]string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return []string{text}, nil
	}
	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, err
	}
	texts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Type == "text" {
			texts = append(texts, block.Text)
		}
	}
	return texts, nil
}

func decodeIssuesPayload(text string) ([]IssueFixture, map[string]bool, bool) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &payload); err != nil {
		return nil, nil, false
	}
	rawIssues, ok := payload["issues"]
	if !ok {
		return nil, nil, false
	}
	var rawRows []json.RawMessage
	if err := json.Unmarshal(rawIssues, &rawRows); err != nil {
		return nil, nil, false
	}
	issues := make([]IssueFixture, 0, len(rawRows))
	fields := map[string]bool{}
	for _, raw := range rawRows {
		var rowFields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &rowFields); err != nil {
			return nil, nil, false
		}
		for field := range rowFields {
			fields[field] = true
		}
		var issue IssueFixture
		if err := json.Unmarshal(raw, &issue); err != nil {
			return nil, nil, false
		}
		issues = append(issues, issue)
	}
	return issues, fields, true
}

func isIssuesTool(name string) bool {
	return name == "issues" || strings.HasSuffix(name, "__issues")
}
