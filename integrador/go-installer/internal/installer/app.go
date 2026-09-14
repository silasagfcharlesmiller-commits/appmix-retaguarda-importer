package installer

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type InstallInput struct {
	CNPJ       string `json:"cnpj"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	AgentOnly  bool   `json:"agent_only"`
	ClientName string `json:"client_name"`
	Retaguarda string `json:"retaguarda"`
}

type UIState struct {
	Busy      bool   `json:"busy"`
	Stage     string `json:"stage"`
	Message   string `json:"message"`
	UpdatedAt string `json:"updated_at"`
}

type App struct {
	ctx       context.Context
	installer *Installer
	mu        sync.RWMutex
	report    EnvironmentReport
	state     UIState
}

func NewApp(targetDir, version string) *App {
	engine, err := NewInstaller(targetDir, version)
	if err != nil {
		panic(err)
	}
	return &App{installer: engine, state: UIState{Stage: "inicial", Message: "Preparando verificação"}}
}

func (app *App) Startup(ctx context.Context) {
	app.ctx = ctx
}

func (app *App) Shutdown(context.Context) {
	app.mu.Lock()
	app.state.Busy = false
	app.mu.Unlock()
}

func (app *App) setState(busy bool, stage, message string) {
	app.mu.Lock()
	app.state = UIState{Busy: busy, Stage: stage, Message: message, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	app.mu.Unlock()
}

func (app *App) State() UIState {
	app.mu.RLock()
	defer app.mu.RUnlock()
	return app.state
}

func (app *App) CheckInstallerUpdate() (bool, error) {
	started, err := MaybeStartInstallerUpdate(app.installer.Version, app.installer.TargetDir, app.installer.SetupPath)
	if started && app.ctx != nil {
		wailsruntime.Quit(app.ctx)
	}
	return started, err
}

func (app *App) CheckEnvironment() (EnvironmentReport, error) {
	app.mu.Lock()
	if app.state.Busy {
		app.mu.Unlock()
		return EnvironmentReport{}, fail("Aguarde a operação atual.")
	}
	app.state.Busy = true
	app.mu.Unlock()
	app.setState(true, "diagnóstico", "Verificando conta, perfil e versões")
	diagnostics := NewDiagnostics(app.installer.TargetDir)
	report, err := app.installer.EnvironmentReport(diagnostics)
	if err != nil {
		app.setState(false, "erro", err.Error())
		report.Diagnostic = diagnostics.Finish("falhou", map[string]any{"error": err.Error()})
		return report, err
	}
	diagnostics.Event("ambiente", "ok", "Verificação do ambiente concluída", nil)
	status := "verificado"
	if !report.Ready {
		status = "bloqueios_confirmados"
	}
	report.Diagnostic = diagnostics.Finish(status, map[string]any{"target": app.installer.TargetDir, "checks": report.Checks})
	app.mu.Lock()
	app.report = report
	app.mu.Unlock()
	app.setState(false, "pronto", "Ambiente verificado")
	return report, nil
}

func (app *App) Install(input InstallInput) (InstallResult, error) {
	app.mu.Lock()
	if app.state.Busy {
		app.mu.Unlock()
		return InstallResult{}, fail("Já existe uma instalação em andamento.")
	}
	app.state.Busy = true
	app.mu.Unlock()
	progress := func(message string) { app.setState(true, "instalação", message) }
	result, err := app.installer.InstallWithOptions(input, progress)
	input.Password = ""
	app.mu.Lock()
	app.report.Checks = result.Checks
	app.report.Warning = result.Warning
	app.report.Diagnostic = result.Diagnostic
	app.mu.Unlock()
	if err != nil {
		app.setState(false, "erro", err.Error())
		return InstallResult{}, err
	}
	if result.AgentVerified {
		app.setState(false, "concluído", "Instalação concluída e controle confirmado")
	} else {
		app.setState(false, "pendente", "Instalado; controle remoto ainda não confirmado")
	}
	return result, nil
}

// Select the existing executable before diagnostics so the actual directory is tested.
func (app *App) SelectExistingIntegrator() (string, error) {
	if app.State().Busy {
		return "", fail("Aguarde a operação em andamento.")
	}
	path, err := wailsruntime.OpenFileDialog(app.ctx, wailsruntime.OpenDialogOptions{
		Title: "Selecione o desktop-integrador.exe existente", Filters: []wailsruntime.FileFilter{{DisplayName: "Integrador Mix Fiscal", Pattern: "desktop-integrador.exe"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	if !strings.EqualFold(filepath.Base(path), "desktop-integrador.exe") || !hasMZHeader(path) {
		return "", fail("Selecione o executável desktop-integrador.exe existente.")
	}
	app.installer.TargetDir = filepath.Dir(path)
	app.installer.TargetEXE = path
	return path, nil
}

func (app *App) LastReport() EnvironmentReport {
	app.mu.RLock()
	defer app.mu.RUnlock()
	return app.report
}
