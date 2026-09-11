package main

import (
	"io/fs"
	"os"
	"path/filepath"

	"appmix/integrador-installer/frontend"
	"appmix/integrador-installer/internal/installer"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

var version = "1.2.0-dev"

func main() {
	targetDir, err := installer.TargetDirectory(os.Args, os.Executable)
	if err != nil {
		installer.ShowError("Instalador Mix Fiscal", err.Error())
		os.Exit(2)
	}
	assets, err := fs.Sub(frontend.Assets, "dist")
	if err != nil {
		installer.ShowError("Instalador Mix Fiscal", "A interface incorporada está incompleta.")
		os.Exit(3)
	}
	app := installer.NewApp(targetDir, version)
	err = wails.Run(&options.App{
		Title:                    "Mix Fiscal | Instalador do Integrador",
		Width:                    920,
		Height:                   760,
		MinWidth:                 620,
		MinHeight:                560,
		BackgroundColour:         &options.RGBA{R: 243, G: 247, B: 245, A: 1},
		AssetServer:              &assetserver.Options{Assets: assets},
		OnStartup:                app.Startup,
		OnShutdown:               app.Shutdown,
		Bind:                     []interface{}{app},
		EnableDefaultContextMenu: false,
		Windows: &windows.Options{
			WebviewUserDataPath: filepath.Join(targetDir, ".mix-installer", "webview-profile"),
			Theme:               windows.SystemDefault,
		},
	})
	if err != nil {
		installer.ShowError("Instalador Mix Fiscal", "A interface WebView2 não pôde ser aberta: "+err.Error())
		os.Exit(4)
	}
}
