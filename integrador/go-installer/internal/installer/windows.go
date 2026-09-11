package installer

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	webViewClientKey    = `Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	webViewBootstrapper = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
	runAsAdminKey       = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers`
	debugKey            = `SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`
	debugValue          = "desktop-integrador.exe"
	debugPort           = 19327
	monitorTask         = "Mix Fiscal - Monitorar Integrador"
	createNoWindow      = 0x08000000
)

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	secur32                  = windows.NewLazySystemDLL("secur32.dll")
	wtsapi32                 = windows.NewLazySystemDLL("wtsapi32.dll")
	shell32                  = windows.NewLazySystemDLL("shell32.dll")
	user32                   = windows.NewLazySystemDLL("user32.dll")
	procProcessIDToSessionID = kernel32.NewProc("ProcessIdToSessionId")
	procGetUserNameExW       = secur32.NewProc("GetUserNameExW")
	procWTSQuerySessionInfoW = wtsapi32.NewProc("WTSQuerySessionInformationW")
	procWTSFreeMemory        = wtsapi32.NewProc("WTSFreeMemory")
	procIsUserAnAdmin        = shell32.NewProc("IsUserAnAdmin")
	procMessageBoxW          = user32.NewProc("MessageBoxW")
)

type WindowsIdentity struct {
	ProcessUser         string `json:"process_user"`
	InteractiveUser     string `json:"interactive_user"`
	InteractiveDetected bool   `json:"interactive_detected"`
	SessionID           uint32 `json:"session_id"`
	SameUser            bool   `json:"same_user"`
}

func hiddenCommand(name string, args ...string) *exec.Cmd {
	command := exec.Command(name, args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return command
}

func isAdministrator() bool {
	result, _, _ := procIsUserAnAdmin.Call()
	return result != 0
}

func processIdentity() string {
	var size uint32
	_, _, _ = procGetUserNameExW.Call(2, 0, uintptr(unsafe.Pointer(&size)))
	if size > 0 {
		buffer := make([]uint16, size)
		result, _, _ := procGetUserNameExW.Call(2, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
		if result != 0 {
			return strings.TrimSpace(windows.UTF16ToString(buffer))
		}
	}
	username := strings.TrimSpace(os.Getenv("USERNAME"))
	domain := strings.TrimSpace(os.Getenv("USERDOMAIN"))
	if domain != "" && username != "" {
		return domain + `\` + username
	}
	if username != "" {
		return username
	}
	return "conta não identificada"
}

func currentSessionID() (uint32, error) {
	var sessionID uint32
	result, _, callErr := procProcessIDToSessionID.Call(uintptr(os.Getpid()), uintptr(unsafe.Pointer(&sessionID)))
	if result == 0 {
		return 0, callErr
	}
	return sessionID, nil
}

func wtsSessionValue(sessionID uint32, infoClass uint32) string {
	var buffer *uint16
	var bytes uint32
	result, _, _ := procWTSQuerySessionInfoW.Call(0, uintptr(sessionID), uintptr(infoClass), uintptr(unsafe.Pointer(&buffer)), uintptr(unsafe.Pointer(&bytes)))
	if result == 0 || buffer == nil {
		return ""
	}
	defer procWTSFreeMemory.Call(uintptr(unsafe.Pointer(buffer)))
	return strings.TrimSpace(windows.UTF16PtrToString(buffer))
}

func windowsIdentities() (WindowsIdentity, error) {
	sessionID, err := currentSessionID()
	if err != nil {
		return WindowsIdentity{}, err
	}
	username := wtsSessionValue(sessionID, 5)
	domain := wtsSessionValue(sessionID, 7)
	interactive := username
	if domain != "" && username != "" {
		interactive = domain + `\` + username
	}
	if interactive == "" {
		interactive = "sessão não identificada"
	}
	process := processIdentity()
	detected := username != ""
	return WindowsIdentity{
		ProcessUser: process, InteractiveUser: interactive, InteractiveDetected: detected,
		SessionID: sessionID, SameUser: detected && strings.EqualFold(process, interactive),
	}, nil
}

func ProbeDirectory(path string) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return fail("O Windows não permitiu preparar %s.", path)
	}
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	original := filepath.Join(path, ".mix-write-"+hex.EncodeToString(random)+".tmp")
	renamed := original + ".renamed"
	defer os.Remove(original)
	defer os.Remove(renamed)
	content := []byte("mix-fiscal-permission-test")
	if err := os.WriteFile(original, content, 0o600); err != nil {
		return fail("O Windows não permitiu gravar a instalação em %s.", path)
	}
	read, err := os.ReadFile(original)
	if err != nil || string(read) != string(content) {
		return fail("O Windows não permitiu ler a instalação em %s.", path)
	}
	if err := os.Rename(original, renamed); err != nil {
		return fail("O Windows não permitiu renomear arquivos da instalação em %s.", path)
	}
	if err := os.Remove(renamed); err != nil {
		return fail("O Windows não permitiu remover o teste da instalação em %s.", path)
	}
	return nil
}

func taskSchedulerRunning() bool {
	output, err := hiddenCommand("sc.exe", "query", "Schedule").CombinedOutput()
	return err == nil && schedulerOutputRunning(string(output))
}

func schedulerOutputRunning(output string) bool {
	return strings.Contains(strings.ToUpper(output), "RUNNING")
}

func probeTaskScheduler() error {
	if !taskSchedulerRunning() {
		return fail("O Agendador de Tarefas do Windows não está em execução ou foi bloqueado pela TI.")
	}
	random := make([]byte, 6)
	_, _ = rand.Read(random)
	name := "Mix Fiscal - Teste Permissao " + hex.EncodeToString(random)
	start := time.Now().Add(10 * time.Minute).Format("15:04")
	defer hiddenCommand("schtasks.exe", "/Delete", "/TN", name, "/F").Run()
	output, err := hiddenCommand(
		"schtasks.exe", "/Create", "/TN", name, "/TR", "cmd.exe /c exit 0",
		"/SC", "ONCE", "/ST", start, "/IT", "/RL", "HIGHEST", "/F",
	).CombinedOutput()
	if err != nil {
		return fail("A conta elevada não conseguiu criar uma tarefa interativa no Agendador. Retorno: %s", safeText(string(output), 240))
	}
	return nil
}

func PreflightEnvironment(targetDir string, diagnostics *Diagnostics) (WindowsIdentity, error) {
	if !isAdministrator() {
		return WindowsIdentity{}, fail("Execute o instalador como administrador.")
	}
	identity, err := windowsIdentities()
	if err != nil {
		return identity, fail("O Windows não informou a conta desta sessão.")
	}
	diagnostics.Event("contas", map[bool]string{true: "ok", false: "erro"}[identity.SameUser], "Conta interativa e conta elevada identificadas", map[string]any{
		"interactive_user": identity.InteractiveUser, "process_user": identity.ProcessUser, "session_id": identity.SessionID,
	})
	if !identity.InteractiveDetected {
		return identity, fail("O Windows não informou qual conta está conectada nesta sessão. A TI precisa executar o setup dentro da sessão RDP/console que ficará com o robô.")
	}
	if !identity.SameUser {
		return identity, fail("O usuário conectado ao Windows é diferente da conta informada no UAC. Sessão: %s. Elevação: %s. Entre no servidor com a conta que ficará executando o Integrador. Nenhum login ou Machine ID foi alterado.", identity.InteractiveUser, identity.ProcessUser)
	}
	appData, localData, temporary := os.Getenv("APPDATA"), os.Getenv("LOCALAPPDATA"), os.Getenv("TEMP")
	if temporary == "" {
		temporary = os.TempDir()
	}
	if appData == "" || localData == "" || temporary == "" {
		return identity, fail("O perfil do Windows não informou AppData, LocalAppData ou TEMP.")
	}
	paths := map[string]string{
		"install_dir":     targetDir,
		"temp":            temporary,
		"settings":        filepath.Join(appData, "mixfiscal-integrador"),
		"webview_profile": filepath.Join(appData, "desktop-integrador.exe", "EBWebView"),
		"local_profile":   filepath.Join(localData, "MixFiscal", "Installer"),
	}
	for name, path := range paths {
		if err := ProbeDirectory(path); err != nil {
			diagnostics.Event("perfil", "erro", err.Error(), map[string]any{"area": name, "path": path})
			return identity, fail("A conta %s não consegue preparar %s em %s. A TI precisa liberar leitura, gravação, criação e renomeação nesse caminho.", identity.InteractiveUser, name, path)
		}
		diagnostics.Event("perfil", "ok", "Leitura e gravação confirmadas", map[string]any{"area": name, "path": path})
	}
	if err := probeTaskScheduler(); err != nil {
		diagnostics.Event("agendador", "erro", err.Error(), nil)
		return identity, err
	}
	diagnostics.Event("agendador", "ok", "Serviço Schedule e criação de tarefa confirmados", nil)
	return identity, nil
}

func WebView2Version() string {
	locations := []struct {
		root registry.Key
		view uint32
	}{
		{registry.LOCAL_MACHINE, registry.WOW64_32KEY},
		{registry.LOCAL_MACHINE, registry.WOW64_64KEY},
		{registry.CURRENT_USER, registry.WOW64_32KEY},
		{registry.CURRENT_USER, registry.WOW64_64KEY},
	}
	versions := make([]string, 0)
	for _, location := range locations {
		key, err := registry.OpenKey(location.root, webViewClientKey, registry.QUERY_VALUE|location.view)
		if err != nil {
			continue
		}
		value, _, err := key.GetStringValue("pv")
		key.Close()
		if err == nil && value != "" && value != "0.0.0.0" {
			versions = append(versions, value)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return compareVersions(versions[i], versions[j]) > 0 })
	if len(versions) > 0 {
		return versions[0]
	}
	return ""
}

func authenticodeStatus(path string) (string, string) {
	script := `$s=Get-AuthenticodeSignature -LiteralPath $args[0]; @{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`
	output, err := hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, path).Output()
	if err != nil {
		return "Error", ""
	}
	var result struct{ Status, Subject string }
	if json.Unmarshal(output, &result) != nil {
		return "Unknown", ""
	}
	return result.Status, result.Subject
}

func EnsureWebView2(targetDir string, diagnostics *Diagnostics, progress func(string)) (string, error) {
	if installed := WebView2Version(); installed != "" {
		diagnostics.Event("webview2", "ok", "Runtime encontrado", map[string]any{"version": installed})
		progress("WebView2 Runtime " + installed + " detectado")
		return installed, nil
	}
	progress("WebView2 ausente; baixando o instalador oficial da Microsoft")
	setupDir := filepath.Join(targetDir, ".setup")
	if err := os.MkdirAll(setupDir, 0o755); err != nil {
		return "", err
	}
	setup := filepath.Join(setupDir, "MicrosoftEdgeWebview2Setup.exe")
	client := &http.Client{Timeout: 2 * time.Minute}
	request, _ := http.NewRequest(http.MethodGet, webViewBootstrapper, nil)
	request.Header.Set("User-Agent", "MixFiscalInstallerGo/1")
	response, err := client.Do(request)
	if err != nil {
		return "", fail("O WebView2 não está instalado e o download oficial da Microsoft falhou. Verifique proxy ou firewall.")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fail("O download oficial do WebView2 retornou HTTP %d.", response.StatusCode)
	}
	temporary := setup + ".download"
	file, err := os.Create(temporary)
	if err == nil {
		_, err = io.Copy(file, io.LimitReader(response.Body, 20<<20))
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
	}
	defer os.Remove(temporary)
	if err != nil {
		return "", fail("O instalador oficial do WebView2 não pôde ser salvo.")
	}
	info, err := os.Stat(temporary)
	if err != nil || info.Size() < 100_000 || !hasMZHeader(temporary) {
		return "", fail("O arquivo baixado para instalar o WebView2 é inválido.")
	}
	status, subject := authenticodeStatus(temporary)
	if !strings.EqualFold(status, "Valid") || !strings.Contains(strings.ToLower(subject), "microsoft") {
		return "", fail("A assinatura digital do instalador do WebView2 não foi confirmada.")
	}
	if err := replaceFile(temporary, setup); err != nil {
		return "", err
	}
	progress("Instalando o WebView2 Runtime; aguarde a conclusão")
	command := hiddenCommand(setup, "/silent", "/install")
	if err := command.Start(); err != nil {
		return "", fail("O instalador do WebView2 não pôde ser iniciado.")
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err = <-done:
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 3010 {
			err = nil
		}
	case <-time.After(10 * time.Minute):
		_ = command.Process.Kill()
		return "", fail("A instalação do WebView2 excedeu dez minutos.")
	}
	installed := WebView2Version()
	if err != nil || installed == "" {
		return "", fail("O WebView2 não foi confirmado após a instalação.")
	}
	diagnostics.Event("webview2", "ok", "Runtime instalado", map[string]any{"version": installed})
	return installed, nil
}

func ConfigureRunAsAdmin(executable string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, runAsAdminKey, registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return fail("O Windows não permitiu marcar o Integrador para executar como administrador.")
	}
	defer key.Close()
	current, _, _ := key.GetStringValue(executable)
	flags := strings.Fields(current)
	found := false
	for _, flag := range flags {
		found = found || strings.EqualFold(flag, "RUNASADMIN")
	}
	if !found {
		flags = append(flags, "RUNASADMIN")
	}
	if len(flags) == 1 {
		flags = append([]string{"~"}, flags...)
	}
	if err := key.SetStringValue(executable, strings.Join(flags, " ")); err != nil {
		return fail("O Windows não permitiu marcar o Integrador para executar como administrador.")
	}
	if !IsRunAsAdminConfigured(executable) {
		return fail("A configuração de execução como administrador não foi confirmada.")
	}
	return nil
}

func IsRunAsAdminConfigured(executable string) bool {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, runAsAdminKey, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetStringValue(executable)
	if err != nil {
		return false
	}
	for _, flag := range strings.Fields(value) {
		if strings.EqualFold(flag, "RUNASADMIN") {
			return true
		}
	}
	return false
}

func replaceFile(source, destination string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

func ShowError(title, message string) {
	titlePtr, _ := windows.UTF16PtrFromString(title)
	messagePtr, _ := windows.UTF16PtrFromString(message)
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(messagePtr)), uintptr(unsafe.Pointer(titlePtr)), 0x10)
}

func windowsVersion() string {
	info := windows.RtlGetVersion()
	if info != nil {
		return fmt.Sprintf("Windows %d.%d build %d", info.MajorVersion, info.MinorVersion, info.BuildNumber)
	}
	return runtime.GOOS
}
