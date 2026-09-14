package agent

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func dataDirectory() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "MixFiscal", "Agent")
}

func ConfigPath() string { return filepath.Join(dataDirectory(), "config.json") }

func LogPath() string { return filepath.Join(dataDirectory(), "agent.log") }

func installedExecutable() string {
	base := os.Getenv("ProgramFiles")
	if base == "" {
		base = `C:\Program Files`
	}
	return filepath.Join(base, "Mix Fiscal", "Agent", "MixFiscalAgentService.exe")
}

func protectSecret(value string) (string, error) {
	input := []byte(value)
	if len(input) == 0 {
		return "", fmt.Errorf("segredo vazio")
	}
	in := windows.DataBlob{Size: uint32(len(input)), Data: &input[0]}
	var out windows.DataBlob
	err := windows.CryptProtectData(
		&in, nil, nil, 0, nil,
		windows.CRYPTPROTECT_LOCAL_MACHINE|windows.CRYPTPROTECT_UI_FORBIDDEN,
		&out,
	)
	if err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	protected := unsafe.Slice(out.Data, int(out.Size))
	return base64.StdEncoding.EncodeToString(protected), nil
}

func unprotectSecret(value string) (string, error) {
	input, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(input) == 0 {
		return "", fmt.Errorf("segredo protegido invalido")
	}
	in := windows.DataBlob{Size: uint32(len(input)), Data: &input[0]}
	var out windows.DataBlob
	if err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	plain := unsafe.Slice(out.Data, int(out.Size))
	return string(plain), nil
}

func saveConfig(config Config) error {
	if err := os.MkdirAll(dataDirectory(), 0o700); err != nil {
		return err
	}
	config.UpdatedAt = nowText()
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary := ConfigPath() + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return windows.Rename(temporary, ConfigPath())
}

func loadConfig() (Config, string, error) {
	data, err := os.ReadFile(ConfigPath())
	if err != nil {
		return Config{}, "", err
	}
	var config Config
	if err = json.Unmarshal(data, &config); err != nil {
		return Config{}, "", err
	}
	secret, err := unprotectSecret(config.ProtectedSecret)
	return config, secret, err
}
