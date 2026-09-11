package installer

import (
	"os"
	"path/filepath"
)

func TargetDirectory(args []string, executable func() (string, error)) (string, error) {
	for index, arg := range args {
		if arg == "--install-dir" || arg == "/DIR" {
			if index+1 >= len(args) || args[index+1] == "" {
				return "", fail("O parâmetro --install-dir está sem o caminho de destino.")
			}
			return filepath.Abs(args[index+1])
		}
		if len(arg) > 5 && (arg[:5] == "/DIR=" || arg[:5] == "/dir=") {
			return filepath.Abs(arg[5:])
		}
	}
	path, err := executable()
	if err != nil {
		return "", fail("Não foi possível identificar a pasta do instalador: %v", err)
	}
	return filepath.Abs(filepath.Dir(path))
}

func appSettingsPath(targetDir string) string {
	base := os.Getenv("APPDATA")
	if base == "" {
		base = targetDir
	}
	return filepath.Join(base, "mixfiscal-integrador", "local_settings.json")
}
