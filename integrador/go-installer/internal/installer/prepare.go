package installer

import (
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

func exclusiveProductDirectory(directory string) bool {
	directory = filepath.Clean(directory)
	if resolved, err := filepath.EvalSymlinks(directory); err == nil {
		directory = filepath.Clean(resolved)
	}
	if filepath.Dir(directory) == directory || len(directory) < 5 {
		return false
	}
	for _, variable := range []string{"WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP"} {
		base := os.Getenv(variable)
		if base == "" {
			continue
		}
		if strings.EqualFold(directory, filepath.Clean(base)) {
			return false
		}
		if variable == "WINDIR" && strings.HasPrefix(strings.ToLower(directory), strings.ToLower(filepath.Clean(base))+`\`) {
			return false
		}
	}
	for _, name := range []string{"Desktop", "Documents", "Downloads"} {
		if strings.EqualFold(directory, filepath.Join(os.Getenv("USERPROFILE"), name)) {
			return false
		}
	}
	if profile := os.Getenv("USERPROFILE"); profile != "" && strings.EqualFold(directory, filepath.Dir(profile)) {
		return false
	}
	return true
}

func encodedPowerShell(script string) string {
	units := utf16.Encode([]rune(script))
	data := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(data[i*2:], unit)
	}
	return base64.StdEncoding.EncodeToString(data)
}

// Called only by the explicit Prepare button. No global security policy changes.
func (app *App) PrepareWindows(defenderExclusion bool) (EnvironmentReport, error) {
	app.mu.Lock()
	if app.state.Busy {
		app.mu.Unlock()
		return EnvironmentReport{}, fail("Aguarde a operação em andamento.")
	}
	app.state.Busy = true
	app.mu.Unlock()
	defer app.setState(false, "pronto", "Preparação finalizada; confira os testes")
	diagnostics := NewDiagnostics(app.installer.TargetDir)
	if !isAdministrator() {
		return EnvironmentReport{}, fail("Abra como administrador para preparar o Windows.")
	}
	// ProbeDirectory creates only the application's directories and temporary probes.
	_, _ = PreflightEnvironment(app.installer.TargetDir, diagnostics)
	if fileExists(app.installer.TargetEXE) {
		if err := ConfigureRunAsAdmin(app.installer.TargetEXE); err != nil {
			diagnostics.Event("preparação", "warning", err.Error(), nil)
		}
	}
	if defenderExclusion {
		directory := filepath.Clean(app.installer.TargetDir)
		if !exclusiveProductDirectory(directory) {
			return EnvironmentReport{}, fail("Escolha uma pasta exclusiva do Integrador, nunca uma pasta geral ou do Windows.")
		}
		escaped := strings.ReplaceAll(directory, "'", "''")
		script := "$ErrorActionPreference='Stop'; if (-not (Get-Command Add-MpPreference -ErrorAction SilentlyContinue)) { throw 'Defender indisponível; solicite a liberação à TI no antivírus instalado.' }; Add-MpPreference -ExclusionPath '" + escaped + "'; if (@((Get-MpPreference).ExclusionPath) -notcontains '" + escaped + "') { throw 'A política corporativa não confirmou a exceção.' }"
		output, err := hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)).CombinedOutput()
		if err != nil {
			diagnostics.Event("preparação", "warning", "Exceção não confirmada: "+safeText(string(output), 600), nil)
		} else {
			diagnostics.Event("preparação", "ok", "Exceção do Defender confirmada somente para "+directory, nil)
		}
	}
	report, err := app.installer.EnvironmentReport(diagnostics)
	diagnostics.mu.Lock()
	for _, event := range diagnostics.Events {
		if event.Step == "preparação" {
			report.Preparation = append(report.Preparation, event.Message)
		}
	}
	diagnostics.mu.Unlock()
	report.Diagnostic = diagnostics.Finish("preparado", map[string]any{"checks": report.Checks})
	app.mu.Lock()
	app.report = report
	app.mu.Unlock()
	return report, err
}
