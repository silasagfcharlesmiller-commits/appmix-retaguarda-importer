package installer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeCNPJ(t *testing.T) {
	value, err := NormalizeCNPJ("52.703.958/0001-42")
	if err != nil || value != "52703958000142" {
		t.Fatalf("CNPJ válido recusado: %q, %v", value, err)
	}
	for _, invalid := range []string{"52.703.958/0001-43", "00000000000000", "123"} {
		if _, err := NormalizeCNPJ(invalid); err == nil {
			t.Fatalf("CNPJ inválido aceito: %s", invalid)
		}
	}
}

func TestValidateMachineID(t *testing.T) {
	valid := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := ValidateMachineID(valid); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"../other", `C:\other`, valid + "/file", ""} {
		if _, err := ValidateMachineID(invalid); err == nil {
			t.Fatalf("Machine ID inválido aceito: %q", invalid)
		}
	}
}

func TestAtomicJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "machine_id.json")
	if err := atomicJSON(path, map[string]any{"machine_id": "abc"}); err != nil {
		t.Fatal(err)
	}
	value, err := readJSONObject(path)
	if err != nil || value["machine_id"] != "abc" {
		t.Fatalf("JSON não persistido: %#v, %v", value, err)
	}
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	if len(matches) != 0 {
		t.Fatalf("temporários restantes: %v", matches)
	}
}

func TestTargetDirectory(t *testing.T) {
	want := filepath.Join(t.TempDir(), "Mix Fiscal", "integrador")
	got, err := TargetDirectory([]string{"setup.exe", "--install-dir", want}, func() (string, error) {
		return "", os.ErrNotExist
	})
	if err != nil || got != want {
		t.Fatalf("destino: %q, %v", got, err)
	}
}

func TestVersionComparison(t *testing.T) {
	if compareVersions("1.2.0", "1.1.9") <= 0 || compareVersions("1.2.0", "1.2.0") != 0 {
		t.Fatal("comparação SemVer incorreta")
	}
}

func TestSchedulerOutputRunning(t *testing.T) {
	if !schedulerOutputRunning("ESTADO : 4 RUNNING") {
		t.Fatal("serviço Schedule em execução não foi reconhecido")
	}
	if schedulerOutputRunning("STATE : 1 STOPPED") {
		t.Fatal("serviço Schedule parado foi aceito")
	}
}

func TestFindLocalMachineIDReusesOneIdentityAndRejectsConflict(t *testing.T) {
	root := t.TempDir()
	appData := filepath.Join(root, "appdata")
	t.Setenv("APPDATA", appData)
	first := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	second := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	installer := &Installer{TargetDir: filepath.Join(root, "integrador")}
	if err := atomicJSON(filepath.Join(installer.TargetDir, "config", "machine_id.json"), map[string]any{"machine_id": first}); err != nil {
		t.Fatal(err)
	}
	got, err := installer.FindLocalMachineID()
	if err != nil || got != first {
		t.Fatalf("Machine ID existente não reutilizado: %q, %v", got, err)
	}
	if err := atomicJSON(appSettingsPath(installer.TargetDir), map[string]any{"machine_id": second}); err != nil {
		t.Fatal(err)
	}
	if _, err := installer.FindLocalMachineID(); err == nil {
		t.Fatal("IDs conflitantes deveriam interromper a instalação")
	}
}

func TestVerifyPayloadDetectsTampering(t *testing.T) {
	root := t.TempDir()
	runtimeDir := filepath.Join(root, "runtime")
	targetDir := filepath.Join(root, "target")
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	component := filepath.Join(targetDir, "Painel_Mix.bat")
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(component, []byte("componente confiável"), 0o644); err != nil {
		t.Fatal(err)
	}
	hash, err := SHA256File(component)
	if err != nil {
		t.Fatal(err)
	}
	manifest := payloadManifest{Files: map[string]struct {
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}{"Painel_Mix.bat": {Size: int64(len("componente confiável")), SHA256: hash}}}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(runtimeDir, "payload_manifest.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	installer := &Installer{TargetDir: targetDir, RuntimeDir: runtimeDir}
	if err := installer.VerifyPayload(); err != nil {
		t.Fatalf("payload íntegro recusado: %v", err)
	}
	if err := os.WriteFile(component, []byte("conteúdo adulterado"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installer.VerifyPayload(); err == nil {
		t.Fatal("payload adulterado deveria ser recusado")
	}
}
