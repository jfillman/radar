package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "extract":
		err = runExtract(os.Args[2:])
	case "evaluate":
		err = runEvaluate(os.Args[2:])
	default:
		usage(os.Stderr)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: issue-stability-harness <extract|evaluate> [flags]")
}

func runExtract(args []string) error {
	flags := flag.NewFlagSet("extract", flag.ContinueOnError)
	input := flags.String("input", "", "directory containing *-claudecode_radar.log transcripts")
	output := flags.String("output", "-", "output corpus JSON path, or - for stdout")
	exclude := flags.String("exclude", "", "comma-separated scenario IDs to exclude")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *input == "" {
		return errors.New("-input is required")
	}
	excluded, err := parseIDSet(*exclude)
	if err != nil {
		return err
	}
	corpus, err := extractDirectory(*input, excluded)
	if err != nil {
		return err
	}
	return writeJSON(*output, corpus)
}

func runEvaluate(args []string) error {
	flags := flag.NewFlagSet("evaluate", flag.ContinueOnError)
	corpusPath := flags.String("corpus", "tools/issue-stability-harness/testdata/corpus.json", "captured corpus JSON")
	truthPath := flags.String("ground-truth", "tools/issue-stability-harness/testdata/ground-truth.json", "ground-truth JSON")
	output := flags.String("output", "-", "output report JSON path, or - for stdout")
	capLimit := flags.Int("cap", 200, "apply candidate ordering after this baseline cap")
	topK := flags.Int("top-k", 10, "visibility boundary for ground-truth rank checks")
	minimumDecoyRate := flags.Float64("min-decoy-rate", unsetMinimumDecoyRate, "explicit minimum for known-decoy scenario and occurrence rates")
	requireGreen := flags.Bool("require-green", false, "return non-zero unless every gate is green")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *capLimit < 1 || *topK < 1 || math.IsNaN(*minimumDecoyRate) || *minimumDecoyRate < 0 || *minimumDecoyRate > 1 {
		return errors.New("-cap and -top-k must be positive; -min-decoy-rate must be in [0,1]")
	}
	if *requireGreen && *minimumDecoyRate == unsetMinimumDecoyRate {
		return errors.New("-require-green requires an explicit positive -min-decoy-rate")
	}
	var corpus Corpus
	if err := readJSON(*corpusPath, &corpus); err != nil {
		return err
	}
	var truth GroundTruth
	if err := readJSON(*truthPath, &truth); err != nil {
		return err
	}
	report := evaluateCorpusWithMinimum(corpus, truth, *capLimit, *topK, *minimumDecoyRate)
	if err := writeJSON(*output, report); err != nil {
		return err
	}
	if *requireGreen && !report.Gate.Green {
		return errors.New("soft-sort gate is red")
	}
	return nil
}

func parseIDSet(value string) (map[int]bool, error) {
	ids := map[int]bool{}
	for _, token := range strings.Split(value, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		id, err := strconv.Atoi(token)
		if err != nil {
			return nil, fmt.Errorf("invalid scenario ID %q: %w", token, err)
		}
		ids[id] = true
	}
	return ids, nil
}

func readJSON(path string, target any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("decode %s: trailing JSON content", path)
	}
	return nil
}

func writeJSON(path string, value any) error {
	var writer io.Writer = os.Stdout
	var file *os.File
	if path != "-" {
		var err error
		file, err = os.Create(path)
		if err != nil {
			return err
		}
		defer file.Close()
		writer = file
	}
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
