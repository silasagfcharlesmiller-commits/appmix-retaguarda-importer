package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type DiagnosticEvent struct {
	Timestamp string            `json:"timestamp"`
	Step      string            `json:"step"`
	Status    string            `json:"status"`
	Message   string            `json:"message"`
	Details   map[string]string `json:"details,omitempty"`
}

type Diagnostics struct {
	TargetDir  string
	StartedAt  time.Time
	LogDirs    []string
	LogPath    string
	ReportPath string
	mu         sync.Mutex
	Events     []DiagnosticEvent
}

func NewDiagnostics(targetDir string) *Diagnostics {
	targetDir, _ = filepath.Abs(targetDir)
	candidates := []string{filepath.Join(targetDir, "logs")}
	if programData := os.Getenv("PROGRAMDATA"); programData != "" {
		candidates = append(candidates, filepath.Join(programData, "MixFiscal", "Logs"))
	}
	logDirs := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if ensureWritableDir(candidate) == nil {
			logDirs = append(logDirs, candidate)
		}
	}
	if len(logDirs) == 0 {
		fallback := filepath.Join(os.TempDir(), "MixFiscal", "Logs")
		_ = os.MkdirAll(fallback, 0o755)
		logDirs = append(logDirs, fallback)
	}
	diagnostic := &Diagnostics{
		TargetDir: targetDir, StartedAt: time.Now().UTC(), LogDirs: logDirs,
		LogPath:    filepath.Join(logDirs[0], "instalacao.log"),
		ReportPath: filepath.Join(logDirs[0], "diagnostico.json"),
	}
	diagnostic.Event("diagnostico", "ok", "Diagnóstico iniciado", nil)
	return diagnostic
}

func ensureWritableDir(path string) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	probe, err := os.CreateTemp(path, ".probe-*.tmp")
	if err != nil {
		return err
	}
	name := probe.Name()
	if _, err = probe.WriteString("ok"); err == nil {
		err = probe.Close()
	} else {
		_ = probe.Close()
	}
	_ = os.Remove(name)
	return err
}

func safeText(value any, limit int) string {
	text := strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(fmt.Sprint(value)))
	if len([]rune(text)) > limit {
		return string([]rune(text)[:limit])
	}
	return text
}

func (d *Diagnostics) Event(step, status, message string, details map[string]any) {
	d.mu.Lock()
	defer d.mu.Unlock()
	event := DiagnosticEvent{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Step:      safeText(step, 80), Status: safeText(status, 30), Message: safeText(message, 800),
	}
	if len(details) > 0 {
		event.Details = make(map[string]string, len(details))
		for key, value := range details {
			event.Details[key] = safeText(value, 800)
		}
	}
	d.Events = append(d.Events, event)
	line := fmt.Sprintf("[%s] [%s] %s: %s\n", event.Timestamp, strings.ToUpper(event.Status), event.Step, event.Message)
	for _, directory := range d.LogDirs {
		file, err := os.OpenFile(filepath.Join(directory, "instalacao.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = file.WriteString(line)
			_ = file.Close()
		}
	}
}

func (d *Diagnostics) Finish(status string, summary map[string]any) string {
	d.mu.Lock()
	events := append([]DiagnosticEvent(nil), d.Events...)
	d.mu.Unlock()
	report := map[string]any{
		"schema":      2,
		"status":      safeText(status, 30),
		"started_at":  d.StartedAt.Format(time.RFC3339Nano),
		"finished_at": time.Now().UTC().Format(time.RFC3339Nano),
		"target_dir":  d.TargetDir,
		"environment": systemInformation(),
		"summary":     summary,
		"events":      events,
	}
	for _, directory := range d.LogDirs {
		_ = atomicJSON(filepath.Join(directory, "diagnostico.json"), report)
	}
	return d.ReportPath
}

func systemInformation() map[string]any {
	identity, _ := windowsIdentities()
	computer, _ := os.Hostname()
	return map[string]any{
		"computer":         computer,
		"windows":          windowsVersion(),
		"architecture":     runtime.GOARCH,
		"runtime":          runtime.Version(),
		"administrator":    isAdministrator(),
		"process_user":     identity.ProcessUser,
		"interactive_user": identity.InteractiveUser,
		"session_id":       identity.SessionID,
		"same_user":        identity.SameUser,
	}
}

func decodeJSONObject(data []byte) (map[string]any, error) {
	var value map[string]any
	if err := json.Unmarshal(trimUTF8BOM(data), &value); err != nil {
		return nil, err
	}
	return value, nil
}
