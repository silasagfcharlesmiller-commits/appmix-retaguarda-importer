package installer

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"appmix/integrador-installer/internal/agent"
)

type EnvironmentCheck struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func blockingChecks(checks []EnvironmentCheck) error {
	var failures []string
	for _, check := range checks {
		if check.Status == "error" {
			failures = append(failures, check.Label+": "+check.Message)
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("%s", strings.Join(failures, "\n\n"))
	}
	return nil
}

func environmentChecks(targetDir string, diagnostics *Diagnostics, extended bool) (WindowsIdentity, []EnvironmentCheck) {
	checks := []EnvironmentCheck{}
	add := func(id, label, status, message string) {
		checks = append(checks, EnvironmentCheck{id, label, status, message})
		diagnostics.Event(id, status, message, nil)
	}
	if isAdministrator() {
		add("admin", "Administrador", "ok", "Elevação confirmada.")
	} else {
		add("admin", "Administrador", "error", "Abra o instalador como administrador na conta que executará o robô.")
	}
	identity, identityErr := windowsIdentities()
	if identityErr != nil || !identity.InteractiveDetected {
		add("identity", "Conta do Windows", "warning", "Consulta da sessão indisponível. Confirme com a TI a conta que executará o robô; o teste real do lançador será feito ao instalar o agente.")
		identity.InteractiveUser = processIdentity()
	} else if !identity.SameUser {
		add("identity", "Conta do Windows", "error", "A conta do UAC difere da sessão: "+identity.ProcessUser+" / "+identity.InteractiveUser+". Use a mesma conta para preservar o perfil do robô.")
	} else {
		add("identity", "Conta do Windows", "ok", "Conta da sessão e elevação conferidas: "+identity.InteractiveUser)
	}
	var failures []string
	paths := []string{targetDir, os.TempDir()}
	for _, entry := range []struct{ env, suffix string }{{"APPDATA", "mixfiscal-integrador"}, {"APPDATA", `desktop-integrador.exe\EBWebView`}, {"LOCALAPPDATA", `MixFiscal\Installer`}} {
		if base := os.Getenv(entry.env); base != "" {
			paths = append(paths, filepath.Join(base, entry.suffix))
		} else {
			failures = append(failures, entry.env+" não informado pelo Windows")
		}
	}
	for _, path := range paths {
		if err := ProbeDirectory(path); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if err := agent.ProbeCredential(); err != nil {
		failures = append(failures, "Proteção de credencial DPAPI: "+err.Error())
	}
	if len(failures) > 0 {
		add("profile", "Pastas e credencial protegida", "error", strings.Join(failures, "\n")+". TI: liberar leitura, escrita e renomeação somente nos caminhos indicados.")
	} else {
		add("profile", "Pastas e credencial protegida", "ok", "Leitura, escrita, renomeação e proteção/leitura de uma credencial temporária confirmadas.")
	}
	if err := probeTaskScheduler(); err != nil {
		add("scheduler", "Agendador de Tarefas", "error", err.Error())
	} else {
		add("scheduler", "Agendador de Tarefas", "ok", "Criação de tarefa interativa elevada confirmada; execução será testada pelo agente.")
	}
	if version := WebView2Version(); version != "" {
		add("webview", "WebView2", "ok", "Runtime "+version)
	} else {
		add("webview", "WebView2", "warning", "Versão não identificada. O bootstrap tentará preparar o Runtime; esta consulta não bloqueia a instalação.")
	}
	if extended {
		count := securityProtectionFindings(targetDir)
		message := "Consulta de proteção não comprova permissão para executar. O teste real do agente confirmará a abertura; a TI pode consultar o histórico do antivírus."
		status := "warning"
		if runtimeEXE, err := os.Executable(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			command := exec.CommandContext(ctx, filepath.Join(filepath.Dir(runtimeEXE), "MixFiscalAgentService.exe"), "probe")
			command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
			output, probeErr := command.Output()
			cancel()
			if probeErr == nil && string(output) == "mix-agent-probe-ok" {
				status = "ok"
				message = "Execução do binário do agente e acesso à credencial temporária confirmados. O teste final verificará o serviço na conta SYSTEM."
			}
		}
		if count > 0 {
			status = "warning"
			message = fmt.Sprintf("%d ocorrência(s) no Defender. TI: revisar quarentena e liberar os arquivos Mix Fiscal verificados. Histórico antigo não bloqueia instalação.", count)
		}
		add("protection", "Antivírus e proteção", status, message)
		if err := agent.CheckConnectivity(12 * time.Second); err != nil {
			add("agent", "API do site (ida e volta)", "warning", "O site não confirmou o sinal enviado antes da instalação: "+err.Error()+". TI: verificar DNS, proxy, antivírus e HTTPS de saída para "+agent.DefaultAPI+".")
		} else {
			add("agent", "API do site (ida e volta)", "ok", "Sinal enviado pelo instalador e resposta da API do site confirmada antes da instalação. O teste posterior confirmará também a execução real do Agente.")
		}
	}
	return identity, checks
}

func PreflightEnvironment(targetDir string, diagnostics *Diagnostics) (WindowsIdentity, error) {
	identity, checks := environmentChecks(targetDir, diagnostics, false)
	return identity, blockingChecks(checks)
}
