package installer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type EnvironmentReport struct {
	InstallerVersion      string `json:"installer_version"`
	AvailableVersion      string `json:"available_version"`
	UpdateAvailable       bool   `json:"update_available"`
	IntegratorRelease     string `json:"integrator_release"`
	IntegratorFileVersion string `json:"integrator_file_version"`
	PanelVersion          string `json:"panel_version"`
	WebView2Version       string `json:"webview2_version"`
	Monitor               string `json:"monitor"`
	RunAsAdmin            string `json:"run_as_admin"`
	ProtectionFindings    int    `json:"security_findings"`
	TargetDir             string `json:"target_dir"`
	InteractiveUser       string `json:"interactive_user"`
	ProcessUser           string `json:"process_user"`
	ProfileReady          bool   `json:"profile_ready"`
	TaskScheduler         string `json:"task_scheduler"`
	Diagnostic            string `json:"diagnostic"`
}

func fileVersion(path string) string {
	if _, err := os.Stat(path); err != nil {
		return "não instalado"
	}
	script := `[Diagnostics.FileVersionInfo]::GetVersionInfo($args[0]).FileVersion`
	output, err := hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, path).Output()
	if err != nil || strings.TrimSpace(string(output)) == "" {
		return "sem versão interna"
	}
	return strings.TrimSpace(string(output))
}

func taskInstalled(taskName string) bool {
	return hiddenCommand("schtasks.exe", "/Query", "/TN", taskName).Run() == nil
}

func securityProtectionFindings(targetDir string) int {
	script := `$target=[IO.Path]::GetFullPath($args[0]);$result=@();if(Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue){$result=@(Get-MpThreatDetection -ErrorAction SilentlyContinue|Where-Object{($_.Resources -join ' ') -like ('*'+$target+'*') -or ($_.Resources -join ' ') -like '*desktop-integrador.exe*'}|Select-Object -First 10 ThreatID,InitialDetectionTime,ActionSuccess,Resources)};$result|ConvertTo-Json -Depth 4 -Compress`
	output, err := hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, targetDir).Output()
	if err != nil || strings.TrimSpace(string(output)) == "" {
		return 0
	}
	var list []any
	if json.Unmarshal(output, &list) == nil {
		return len(list)
	}
	var one map[string]any
	if json.Unmarshal(output, &one) == nil && len(one) > 0 {
		return 1
	}
	return 0
}

func (installer *Installer) EnvironmentReport(diagnostics *Diagnostics) (EnvironmentReport, error) {
	identity, err := PreflightEnvironment(installer.TargetDir, diagnostics)
	if err != nil {
		return EnvironmentReport{}, err
	}
	release := "não instalado"
	versionPath := filepath.Join(installer.TargetDir, "integrador_version.json")
	if data, readErr := os.ReadFile(versionPath); readErr == nil {
		var value map[string]any
		if json.Unmarshal(trimUTF8BOM(data), &value) == nil {
			if found, ok := value["version"].(string); ok && found != "" {
				release = found
			}
		}
	}
	webView := WebView2Version()
	if webView == "" {
		webView = "não instalado"
	}
	report := EnvironmentReport{
		InstallerVersion:      installer.Version,
		AvailableVersion:      "consulta indisponível",
		IntegratorRelease:     release,
		IntegratorFileVersion: fileVersion(installer.TargetEXE),
		PanelVersion:          map[bool]string{true: release, false: "não instalado"}[fileExists(filepath.Join(installer.TargetDir, "Painel_Mix.bat"))],
		WebView2Version:       webView,
		Monitor:               map[bool]string{true: "instalado", false: "não instalado"}[taskInstalled(monitorTask)],
		RunAsAdmin:            map[bool]string{true: "configurado", false: "não configurado"}[IsRunAsAdminConfigured(installer.TargetEXE)],
		ProtectionFindings:    securityProtectionFindings(installer.TargetDir),
		TargetDir:             installer.TargetDir,
		InteractiveUser:       identity.InteractiveUser,
		ProcessUser:           identity.ProcessUser,
		ProfileReady:          true,
		TaskScheduler:         "disponível",
	}
	if manifest, manifestErr := RemoteVersionManifest(20 * time.Second); manifestErr == nil {
		report.AvailableVersion = manifest.Version
		report.UpdateAvailable = compareVersions(manifest.Version, installer.Version) > 0
	}
	return report, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
