package installer

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type payloadManifest struct {
	Version string `json:"version"`
	Files   map[string]struct {
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	} `json:"files"`
}

type InstallResult struct {
	CNPJ       string `json:"cnpj"`
	MachineID  string `json:"machine_id"`
	Monitor    string `json:"monitor"`
	Diagnostic string `json:"diagnostic"`
}

type Installer struct {
	TargetDir  string
	TargetEXE  string
	RuntimeDir string
	Version    string
}

func NewInstaller(targetDir, version string) (*Installer, error) {
	runtimeEXE, err := os.Executable()
	if err != nil {
		return nil, err
	}
	targetDir, err = filepath.Abs(targetDir)
	if err != nil {
		return nil, err
	}
	return &Installer{
		TargetDir:  targetDir,
		TargetEXE:  filepath.Join(targetDir, "desktop-integrador.exe"),
		RuntimeDir: filepath.Dir(runtimeEXE),
		Version:    version,
	}, nil
}

func optionalMachineID(path string) (string, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return "", nil
	}
	data, err := readJSONObject(path)
	if err != nil {
		return "", err
	}
	value, _ := data["machine_id"].(string)
	if value == "" {
		return "", nil
	}
	return ValidateMachineID(value)
}

func (installer *Installer) FindLocalMachineID() (string, error) {
	configID, err := optionalMachineID(filepath.Join(installer.TargetDir, "config", "machine_id.json"))
	if err != nil {
		return "", err
	}
	appID, err := optionalMachineID(appSettingsPath(installer.TargetDir))
	if err != nil {
		return "", err
	}
	if configID != "" && appID != "" && configID != appID {
		return "", fail("Os arquivos locais contêm Machine IDs diferentes. Eles foram preservados para revisão.")
	}
	if configID != "" {
		return configID, nil
	}
	return appID, nil
}

func (installer *Installer) VerifyPayload() error {
	manifestPath := filepath.Join(installer.RuntimeDir, "payload_manifest.json")
	data, err := os.ReadFile(manifestPath)
	if os.IsNotExist(err) {
		return fail("O manifesto interno dos componentes não foi encontrado.")
	}
	if err != nil {
		return err
	}
	var manifest payloadManifest
	if json.Unmarshal(trimUTF8BOM(data), &manifest) != nil || len(manifest.Files) == 0 {
		return fail("O manifesto interno dos componentes é inválido.")
	}
	for name, metadata := range manifest.Files {
		if filepath.Base(name) != name || metadata.Size <= 0 || len(metadata.SHA256) != 64 {
			return fail("Metadados internos inválidos para %s.", name)
		}
		destination := filepath.Join(installer.TargetDir, name)
		info, err := os.Stat(destination)
		if err != nil || info.Size() != metadata.Size {
			return fail("O componente %s foi removido ou alterado durante a instalação.", name)
		}
		hash, err := SHA256File(destination)
		if err != nil || !strings.EqualFold(hash, metadata.SHA256) {
			return fail("A integridade do componente %s não foi confirmada.", name)
		}
	}
	return nil
}

func (installer *Installer) PrepareFiles(diagnostics *Diagnostics, progress func(string)) error {
	if err := ProbeDirectory(installer.TargetDir); err != nil {
		return err
	}
	if err := installer.StopIntegrator(); err != nil {
		diagnostics.Event("processo", "atenção", "Não foi possível consultar/encerrar uma instância anterior", map[string]any{"error": err})
	}
	if err := installer.VerifyPayload(); err != nil {
		return err
	}
	if err := ConfigureRunAsAdmin(installer.TargetEXE); err != nil {
		return err
	}
	diagnostics.Event("componentes", "ok", "Arquivos instalados e validados por SHA-256", nil)
	diagnostics.Event("administrador", "ok", "Integrador marcado para executar como administrador", map[string]any{"executable": installer.TargetEXE})
	progress("Aplicativo preparado em " + installer.TargetDir)
	return nil
}

func (installer *Installer) StopIntegrator() error {
	target := installer.TargetEXE
	script := `$target=$args[0]; Get-CimInstance Win32_Process -Filter "Name='desktop-integrador.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.ExecutablePath -eq $target} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}`
	return hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, target).Run()
}

func (installer *Installer) IntegratorRunning() bool {
	target := installer.TargetEXE
	script := `$target=$args[0]; $process=Get-CimInstance Win32_Process -Filter "Name='desktop-integrador.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.ExecutablePath -eq $target} | Select-Object -First 1; if ($null -ne $process) {'running'}`
	output, err := hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, target).Output()
	return err == nil && strings.TrimSpace(string(output)) == "running"
}

func (installer *Installer) StartIntegratorVerified(diagnostics *Diagnostics, progress func(string)) error {
	if _, err := os.Stat(installer.TargetEXE); err != nil {
		return fail("O Integrador desapareceu antes da inicialização final.")
	}
	progress("Abrindo e validando o processo do Integrador")
	command := hiddenCommand(installer.TargetEXE)
	command.Dir = installer.TargetDir
	if err := command.Start(); err != nil {
		return fail("O Windows bloqueou a abertura do Integrador. Consulte o diagnóstico para a TI.")
	}
	time.Sleep(2 * time.Second)
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(command.Process.Pid))
	if err != nil {
		return fail("O Integrador encerrou logo após abrir.")
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil || status != uint32(windows.WAIT_TIMEOUT) {
		return fail("O Integrador encerrou logo após abrir.")
	}
	diagnostics.Event("processo", "ok", "Integrador iniciado e permaneceu em execução", nil)
	return nil
}

type debugRestore struct {
	key      registry.Key
	existed  bool
	previous string
}

func enableTemporaryWebViewDebug() (*debugRestore, error) {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, debugKey, registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return nil, fail("O Windows não permitiu habilitar a automação temporária do WebView2.")
	}
	previous, _, previousErr := key.GetStringValue(debugValue)
	restore := &debugRestore{key: key, existed: previousErr == nil, previous: previous}
	value := fmt.Sprintf("--remote-debugging-port=%d --remote-debugging-address=127.0.0.1", debugPort)
	if err := key.SetStringValue(debugValue, value); err != nil {
		key.Close()
		return nil, err
	}
	return restore, nil
}

func (restore *debugRestore) Close() {
	if restore == nil {
		return
	}
	if restore.existed {
		_ = restore.key.SetStringValue(debugValue, restore.previous)
	} else {
		_ = restore.key.DeleteValue(debugValue)
	}
	restore.key.Close()
}

func waitDebugPort(timeout time.Duration) error {
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", debugPort))
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fail("O WebView2 não abriu a porta temporária de automação.")
}

func waitDebugPortClosed(timeout time.Duration) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", debugPort))
		if err != nil {
			return
		}
		response.Body.Close()
		time.Sleep(200 * time.Millisecond)
	}
}

func persistNativeID(page *CDPPage, machineID string) error {
	script := fmt.Sprintf(`(async()=>{const id=%s;const settings=await window.go.app.App.GetLocalSettings();await window.go.app.App.SaveLocalSettings({...settings,machine_id:id});return await window.go.app.App.LoadSavedMachineID();})()`, jsQuote(machineID))
	result, err := page.EvaluateRetry(script, 3, 700*time.Millisecond)
	if err != nil {
		return fail("Falha ao confirmar o Machine ID no Integrador: %v", err)
	}
	if value, _ := result.(string); value != machineID {
		return fail("O Integrador não confirmou o Machine ID no disco.")
	}
	return nil
}

func authenticateIntegrator(page *CDPPage, username, password string, progress func(string)) error {
	if !page.VisiblePlaceholder("Email ou CPF/CNPJ", 0) {
		return nil
	}
	progress("Autenticando no Integrador")
	if err := page.FillPlaceholder("Email ou CPF/CNPJ", username, 0); err != nil {
		return err
	}
	if err := page.FillPassword(password); err != nil {
		return err
	}
	if err := page.ClickText("Entrar", "button", false); err != nil {
		return err
	}
	if err := page.WaitPlaceholderHidden("Email ou CPF/CNPJ", 25*time.Second, 0); err != nil {
		return err
	}
	return page.WaitIntegratorBridge(20 * time.Second)
}

func openSettingsWithLogin(page *CDPPage, username, password string, progress func(string)) error {
	if page.VisibleText("Configurações", "h1,h2,h3", false) {
		if !page.VisibleText("Dashboard", "a,button", false) {
			return fail("Não foi possível retornar ao Dashboard para confirmar o acesso.")
		}
		if err := page.ClickText("Dashboard", "a,button", false); err != nil {
			return err
		}
		if err := page.WaitTextHidden("Configurações", 15*time.Second, "h1,h2,h3"); err != nil {
			return err
		}
	}
	if !page.VisibleText("Configurações", "h1,h2,h3", false) {
		progress("Abrindo Configurações do Integrador")
		if err := page.WaitText("Configurações", 20*time.Second, "a,button"); err != nil {
			return err
		}
		if err := page.ClickText("Configurações", "a,button", false); err != nil {
			return err
		}
		predicate := `(()=>{const confirm=[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='Confirmar');const title=[...document.querySelectorAll('h1,h2,h3')].some(e=>e.innerText.trim()==='Configurações');return confirm||title})()`
		if err := page.Wait(predicate, 20*time.Second, "A tela de Configurações não apareceu."); err != nil {
			return err
		}
	}
	if page.VisibleText("Confirmar", "button", false) {
		progress("Confirmando o login em Configurações")
		if err := page.FillPlaceholder("Email ou CPF/CNPJ", username, 0); err != nil {
			return err
		}
		if err := page.FillPlaceholder("Senha", password, 0); err != nil {
			return err
		}
		if err := page.ClickText("Confirmar", "button", false); err != nil {
			return err
		}
	}
	return page.WaitText("Configurações", 25*time.Second, "h1,h2,h3")
}

func (installer *Installer) OpenIntegratorAuthenticatedForReview(username, password string, diagnostics *Diagnostics, progress func(string)) error {
	progress("Aproveitando o Integrador já aberto para a conferência final")
	// A porta pertence somente ao WebView2 do Integrador e é uma evidência mais
	// confiável do que CIM em servidores que restringem a consulta de processos.
	ready := waitDebugPort(8*time.Second) == nil
	if !ready {
		progress("A janela anterior não está disponível; abrindo o Integrador para conferência")
		_ = installer.StopIntegrator()
		waitDebugPortClosed(5 * time.Second)
		command := hiddenCommand(installer.TargetEXE)
		command.Dir = installer.TargetDir
		if err := command.Start(); err != nil {
			return fail("O Windows bloqueou a abertura final do Integrador.")
		}
		// O primeiro PID pode entregar a execução para a instância instalada e sair.
		// A porta do WebView2 identifica a janela real que deve ser automatizada.
		if err := waitDebugPort(35 * time.Second); err != nil {
			return fail("O Integrador foi instalado, mas a janela final não abriu para conferência.")
		}
	}
	page, err := NewCDPPage(debugPort)
	if err != nil {
		return err
	}
	defer page.Close()
	if page.URL == "about:blank" {
		if err := page.Navigate("http://wails.localhost/"); err != nil {
			return err
		}
	}
	if err := page.WaitIntegratorBridge(35 * time.Second); err != nil {
		return err
	}
	if err := authenticateIntegrator(page, username, password, progress); err != nil {
		return fail("O Integrador foi instalado, mas o login da abertura final falhou: %v", err)
	}
	if err := openSettingsWithLogin(page, username, password, progress); err != nil {
		return fail("O Integrador foi instalado e autenticado, mas não permaneceu em Configurações: %v", err)
	}
	progress("Integrador aberto, autenticado e em Configurações")
	diagnostics.Event("processo", "ok", "Integrador reaberto, autenticado e mantido na tela de Configurações", nil)
	return nil
}

func installFromSettings(page *CDPPage, progress func(string)) error {
	progress("Instalando a inicialização automática")
	value, err := page.EvaluateRetry("window.go.app.App.GetWindowsServiceStatus()", 5, time.Second)
	if err != nil {
		return fail("Falha ao consultar a inicialização automática do Integrador: %v", err)
	}
	status := fmt.Sprint(value)
	if status == "not_installed" {
		if err := page.WaitText("Instalar", 15*time.Second, "button"); err != nil {
			return err
		}
		progress("Clicando em Instalar")
		if err := page.ClickText("Instalar", "button", false); err != nil {
			return err
		}
		// O Integrador pode reconstruir a página logo após instalar suas tarefas.
		// Aguarde a ponte reaparecer antes de confirmar o estado final.
		_ = page.WaitIntegratorBridge(15 * time.Second)
	}
	deadline := time.Now().Add(35 * time.Second)
	var lastStatusErr error
	for time.Now().Before(deadline) {
		value, err = page.EvaluateRetry("window.go.app.App.GetWindowsServiceStatus()", 2, 700*time.Millisecond)
		if err != nil {
			lastStatusErr = err
			time.Sleep(500 * time.Millisecond)
			continue
		}
		lastStatusErr = nil
		status = fmt.Sprint(value)
		if status == "running" {
			return nil
		}
		if status == "stopped" && page.VisibleText("Iniciar", "button", false) {
			_ = page.ClickText("Iniciar", "button", false)
		}
		time.Sleep(500 * time.Millisecond)
	}
	if lastStatusErr != nil {
		return fail("Falha ao confirmar a inicialização automática do Integrador após aguardar a atualização da tela: %v", lastStatusErr)
	}
	return fail("A inicialização não ficou ativa; estado atual: %q.", status)
}

func automateUI(cnpj, username, password, expectedID string, progress func(string)) (string, error) {
	page, err := NewCDPPage(debugPort)
	if err != nil {
		return "", err
	}
	defer page.Close()
	if page.URL == "about:blank" {
		if err := page.Navigate("http://wails.localhost/"); err != nil {
			return "", err
		}
	}
	progress("Aguardando a interface do Integrador ficar pronta")
	if err := page.WaitIntegratorBridge(35 * time.Second); err != nil {
		return "", err
	}
	if err := authenticateIntegrator(page, username, password, progress); err != nil {
		return "", err
	}
	progress("Aproveitando a identidade gerada pelo Integrador")
	savedRaw, err := page.EvaluateRetry("window.go.app.App.LoadSavedMachineID()", 3, 700*time.Millisecond)
	if err != nil {
		return "", fail("Falha ao ler o Machine ID criado pelo Integrador: %v", err)
	}
	savedID, _ := savedRaw.(string)
	machineID := ""
	if expectedID != "" {
		machineID = expectedID
		if savedID != "" && savedID != expectedID {
			return "", fail("O Integrador apresentou um Machine ID diferente do arquivo local. Nenhum cadastro foi alterado.")
		}
	} else if savedID != "" {
		machineID = savedID
	} else if page.VisibleText("iniciar nova configuracao", "button", true) {
		if err := page.ClickText("iniciar nova configuracao", "button", true); err != nil {
			return "", err
		}
		if err := page.WaitCSS("input.machine-generated-id-input", 15*time.Second); err != nil {
			return "", err
		}
		machineID = page.InputValue("input.machine-generated-id-input")
	} else {
		generated, err := page.Evaluate("window.go.app.App.EnsureMachineIDForNewClient()")
		if err != nil {
			return "", err
		}
		machineID, _ = generated.(string)
	}
	if machineID, err = ValidateMachineID(machineID); err != nil {
		return "", err
	}
	if err := persistNativeID(page, machineID); err != nil {
		return "", err
	}
	if page.VisiblePlaceholder("Informe o machine_id legado", 0) {
		if err := page.FillPlaceholder("Informe o machine_id legado", machineID, 0); err != nil {
			return "", err
		}
		if err := page.ClickText("buscar e configurar aplicacao", "button", true); err != nil {
			return "", err
		}
		predicate := `(()=>{const config=[...document.querySelectorAll('h1,h2,h3')].some(e=>e.innerText.trim()==='Configurações');const dashboard=[...document.querySelectorAll('a,button')].some(e=>e.innerText.trim()==='Dashboard');return config||dashboard})()`
		if err := page.Wait(predicate, 25*time.Second, "O Integrador não abriu a configuração do Machine ID."); err != nil {
			return "", err
		}
	}
	if err := openSettingsWithLogin(page, username, password, progress); err != nil {
		return "", err
	}
	progress("Vinculando o CNPJ ao serviço Mix Fiscal")
	if err := page.WaitPlaceholder("00.000.000/0001-00", 20*time.Second, 0); err != nil {
		return "", err
	}
	if err := page.FillPlaceholder("00.000.000/0001-00", cnpj, 0); err != nil {
		return "", err
	}
	hasServiceRaw, err := page.Evaluate(`(()=>{try{const config=JSON.parse(localStorage.getItem('mxf_config')||'{}');return(config.tag_service||[]).includes('mixfiscal')}catch{return false}})()`)
	if err != nil {
		return "", err
	}
	hasService, _ := hasServiceRaw.(bool)
	if !hasService {
		if err := page.AddSelectOption("mixfiscal", "Adicionar"); err != nil {
			return "", err
		}
	}
	_, _ = page.Evaluate("window.scrollTo(0,document.body.scrollHeight)")
	progress("Salvando CNPJ e serviço Mix Fiscal")
	if err := page.ClickText("Salvar Configurações", "button", false); err != nil {
		return "", err
	}
	predicate := fmt.Sprintf(`(()=>{try{const config=JSON.parse(localStorage.getItem('mxf_config')||'{}');return config.cnpj_cpf===%s&&(config.tag_service||[]).includes('mixfiscal')}catch{return false}})()`, jsQuote(cnpj))
	if err := page.Wait(predicate, 30*time.Second, "O CNPJ e o serviço Mix Fiscal não foram confirmados após salvar."); err != nil {
		return "", err
	}
	if err := persistNativeID(page, machineID); err != nil {
		return "", err
	}
	if err := installFromSettings(page, progress); err != nil {
		return "", err
	}
	if page.VisibleText("Dashboard", "a,button", false) {
		_ = page.ClickText("Dashboard", "a,button", false)
	}
	progress("Instalação ativa; o Integrador permanecerá aberto para conferência")
	return machineID, nil
}

func (installer *Installer) Install(cnpj, username, password string, progress func(string)) (InstallResult, error) {
	diagnostics := NewDiagnostics(installer.TargetDir)
	result, machineID, err := installer.runInstall(cnpj, username, password, diagnostics, progress)
	if err != nil {
		if waitDebugPort(time.Second) == nil || installer.IntegratorRunning() {
			diagnostics.Event("processo", "atenção", "Integrador mantido aberto para revisão manual após a falha", nil)
		} else if machineID != "" {
			if startErr := installer.StartIntegratorVerified(diagnostics, func(string) {}); startErr != nil {
				diagnostics.Event("processo", "atenção", "Não foi possível reabrir o Integrador após a falha", map[string]any{"error": startErr})
			}
		}
		diagnostics.Event("instalação", "erro", err.Error(), nil)
		if findings := securityProtectionFindings(installer.TargetDir); findings > 0 {
			diagnostics.Event("proteção", "atenção", "O Microsoft Defender registrou ocorrência relacionada ao Integrador", map[string]any{"occurrences": findings})
		}
		report := diagnostics.Finish("falhou", map[string]any{"error": err.Error()})
		return InstallResult{}, fail("%s\n\nDiagnóstico salvo em:\n%s", err.Error(), report)
	}

	result.Diagnostic = diagnostics.Finish("concluído", map[string]any{"monitor": monitorTask, "result": "online"})
	return result, nil
}

func (installer *Installer) runInstall(cnpj, username, password string, diagnostics *Diagnostics, progress func(string)) (InstallResult, string, error) {
	machineID := ""
	if !isAdministrator() {
		return InstallResult{}, machineID, fail("Execute o instalador como administrador.")
	}
	diagnostics.Event("administrador", "ok", "Instalador executando elevado", nil)
	progress("Validando conta do Windows, perfil e permissões")
	if _, err := PreflightEnvironment(installer.TargetDir, diagnostics); err != nil {
		return InstallResult{}, machineID, err
	}
	normalizedCNPJ, err := NormalizeCNPJ(cnpj)
	if err != nil {
		return InstallResult{}, machineID, err
	}
	if strings.TrimSpace(username) == "" || password == "" {
		return InstallResult{}, machineID, fail("Informe usuário e senha do Integrador.")
	}
	if _, err := EnsureWebView2(installer.TargetDir, diagnostics, progress); err != nil {
		return InstallResult{}, machineID, err
	}
	progress("Validando o acesso à API")
	api := NewMixAPI()
	if err := api.Login(username, password); err != nil {
		return InstallResult{}, machineID, err
	}
	diagnostics.Event("api", "ok", "Autenticação confirmada", nil)
	localMachineID, localErr := installer.FindLocalMachineID()
	if localErr != nil {
		return InstallResult{}, machineID, localErr
	}
	if err := installer.PrepareFiles(diagnostics, progress); err != nil {
		return InstallResult{}, machineID, err
	}
	restore, debugErr := enableTemporaryWebViewDebug()
	if debugErr != nil {
		return InstallResult{}, machineID, debugErr
	}
	defer restore.Close()
	var automationErr error
	func() {
		_ = installer.StopIntegrator()
		command := hiddenCommand(installer.TargetEXE)
		command.Dir = installer.TargetDir
		if startErr := command.Start(); startErr != nil {
			automationErr = fail("O Windows bloqueou a abertura do Integrador.")
			return
		}
		if waitErr := waitDebugPort(30 * time.Second); waitErr != nil {
			automationErr = waitErr
			return
		}
		machineID, automationErr = automateUI(normalizedCNPJ, username, password, localMachineID, progress)
	}()
	if automationErr != nil {
		return InstallResult{}, machineID, automationErr
	}
	if err := installer.InstallMonitor(progress); err != nil {
		return InstallResult{}, machineID, err
	}
	diagnostics.Event("monitor", "ok", "Tarefa de monitoramento instalada e verificada", nil)
	progress("Confirmando cadastro na API")
	if err := api.VerifyRegistration(normalizedCNPJ, machineID); err != nil {
		return InstallResult{}, machineID, err
	}
	configID, configErr := optionalMachineID(filepath.Join(installer.TargetDir, "config", "machine_id.json"))
	appID, appErr := optionalMachineID(appSettingsPath(installer.TargetDir))
	if configErr != nil || appErr != nil || configID != machineID || appID != machineID {
		return InstallResult{}, machineID, fail("O Machine ID não ficou igual nos dois arquivos locais.")
	}
	progress("Aguardando o Machine ID ficar online no App Mix")
	if err := api.WaitUntilOnline(normalizedCNPJ, machineID, 40*time.Second); err != nil {
		return InstallResult{}, machineID, err
	}
	diagnostics.Event("cadastro", "ok", "CNPJ, serviço Mix Fiscal e Machine ID confirmados", nil)
	if err := installer.OpenIntegratorAuthenticatedForReview(username, password, diagnostics, progress); err != nil {
		return InstallResult{}, machineID, err
	}
	return InstallResult{CNPJ: normalizedCNPJ, MachineID: machineID, Monitor: monitorTask}, machineID, nil
}

func (installer *Installer) InstallMonitor(progress func(string)) error {
	progress("Instalando o monitor automático do Integrador")
	panel := filepath.Join(installer.TargetDir, "Painel_Mix.bat")
	if _, err := os.Stat(panel); err != nil {
		return fail("Painel_Mix.bat não foi encontrado na pasta da instalação.")
	}
	command := hiddenCommand("cmd.exe", "/D", "/C", "call", panel, "--install-monitor")
	command.Dir = installer.TargetDir
	output, err := command.CombinedOutput()
	_ = os.WriteFile(filepath.Join(installer.TargetDir, "painel_install_log.txt"), output, 0o644)
	if err != nil {
		return fail("O Painel Mix não conseguiu instalar a tarefa do monitor. Consulte painel_install_log.txt.")
	}
	if err := hiddenCommand("schtasks.exe", "/Query", "/TN", monitorTask).Run(); err != nil {
		return fail("A tarefa do Monitor Mix Fiscal não foi encontrada após a instalação.")
	}
	progress("Monitor do Windows instalado pelo Painel Mix e verificado")
	return nil
}
