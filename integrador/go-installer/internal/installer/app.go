package installer

import (
	"context"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type InstallInput struct {
	CNPJ     string `json:"cnpj"`
	Username string `json:"username"`
	Password string `json:"password"`
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
	started, err := MaybeStartInstallerUpdate(app.installer.Version, app.installer.TargetDir)
	if started && app.ctx != nil {
		wailsruntime.Quit(app.ctx)
	}
	return started, err
}

func (app *App) CheckEnvironment() (EnvironmentReport, error) {
	app.setState(true, "diagnóstico", "Verificando conta, perfil e versões")
	diagnostics := NewDiagnostics(app.installer.TargetDir)
	report, err := app.installer.EnvironmentReport(diagnostics)
	if err != nil {
		app.setState(false, "erro", err.Error())
		report.Diagnostic = diagnostics.Finish("falhou", map[string]any{"error": err.Error()})
		return report, err
	}
	diagnostics.Event("ambiente", "ok", "Verificação do ambiente concluída", nil)
	report.Diagnostic = diagnostics.Finish("verificado", map[string]any{"target": app.installer.TargetDir})
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
	result, err := app.installer.Install(input.CNPJ, input.Username, input.Password, progress)
	input.Password = ""
	if err != nil {
		app.setState(false, "erro", err.Error())
		return InstallResult{}, err
	}
	app.setState(false, "concluído", "Instalação concluída e monitoramento ativo")
	return result, nil
}
