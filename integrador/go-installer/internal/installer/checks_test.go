package installer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAllConfirmedFailuresAppearInReport(t *testing.T) {
	checks := []EnvironmentCheck{
		{Label: "Conta", Status: "error", Message: "Conta diferente"},
		{Label: "Rede", Status: "warning", Message: "Proxy sem confirmação"},
		{Label: "Pasta", Status: "error", Message: "Escrita recusada"},
	}
	err := blockingChecks(checks)
	if err == nil || !strings.Contains(err.Error(), "Conta diferente") || !strings.Contains(err.Error(), "Escrita recusada") {
		t.Fatalf("incomplete report: %v", err)
	}
	if strings.Contains(err.Error(), "Proxy") {
		t.Fatal("inconclusive network probe blocked installation")
	}
}

func TestUncertainProtectionAndNetworkDoNotBlockInstallation(t *testing.T) {
	for _, status := range []string{"warning", "pending", "ok"} {
		if err := blockingChecks([]EnvironmentCheck{{Label: "Antivírus", Status: status}, {Label: "Rede", Status: status}, {Label: "Agente", Status: status}}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDefenderExclusionRejectsBroadDirectories(t *testing.T) {
	t.Setenv("WINDIR", `C:\Windows`)
	t.Setenv("USERPROFILE", `C:\Users\Client`)
	for _, path := range []string{`C:\`, `C:\Windows`, `C:\Windows\System32`, `C:\Users\Client`, `C:\Users\Client\Desktop`} {
		if exclusiveProductDirectory(path) {
			t.Fatalf("broad directory accepted: %s", path)
		}
	}
	if !exclusiveProductDirectory(`C:\Mix Fiscal\integrador`) {
		t.Fatal("exclusive product directory rejected")
	}
}

func TestAgentOnlyDoesNotCreateMissingIntegrator(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "desktop-integrador.exe")
	installer := &Installer{TargetDir: root, TargetEXE: exe}
	// This must fail before API, service, credentials or any file mutations.
	_, err := installer.installAgentOnly(InstallInput{CNPJ: "52703958000142"}, nil, func(string) {})
	if err == nil {
		t.Fatal("missing existing executable accepted")
	}
	if _, err := os.Stat(exe); !os.IsNotExist(err) {
		t.Fatal("agent-only installed the integrator")
	}
}
