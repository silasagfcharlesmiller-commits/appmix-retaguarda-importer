package main

import (
	"os"

	"appmix/integrador-installer/internal/installer"
)

func main() {
	targetDir, err := installer.TargetDirectory(os.Args, os.Executable)
	if err != nil {
		installer.ShowError("Instalador Mix Fiscal", err.Error())
		os.Exit(2)
	}
	diagnostics := installer.NewDiagnostics(targetDir)
	if _, err = installer.EnsureWebView2(targetDir, diagnostics, func(string) {}); err != nil {
		diagnostics.Finish("falhou", map[string]any{"error": err.Error()})
		installer.ShowError("WebView2 necessário", err.Error())
		os.Exit(3)
	}
	diagnostics.Finish("bootstrap concluído", nil)
}
