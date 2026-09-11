package installer

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	manifestURL = "https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json"
	publicHost  = "appmix-retaguarda-importer.vercel.app"
)

type ManifestFile struct {
	Name   string `json:"name,omitempty"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type RemoteManifest struct {
	Schema    int          `json:"schema"`
	Version   string       `json:"version"`
	Channel   string       `json:"channel"`
	Installer ManifestFile `json:"installer"`
}

func RemoteVersionManifest(timeout time.Duration) (RemoteManifest, error) {
	endpoint := fmt.Sprintf("%s?t=%d", manifestURL, time.Now().UTC().Unix())
	request, _ := http.NewRequest(http.MethodGet, endpoint, nil)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "MixFiscalInstallerGo/1")
	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return RemoteManifest{}, fail("Não foi possível consultar as versões publicadas.")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return RemoteManifest{}, fail("A consulta de versões retornou HTTP %d.", response.StatusCode)
	}
	var manifest RemoteManifest
	if json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&manifest) != nil || manifest.Version == "" {
		return RemoteManifest{}, fail("O servidor retornou um manifesto de versões inválido.")
	}
	return manifest, nil
}

func validPublicDownload(entry ManifestFile) bool {
	parsed, err := url.Parse(entry.URL)
	return err == nil && parsed.Scheme == "https" && strings.EqualFold(parsed.Hostname(), publicHost) && entry.Size > 0 && len(entry.SHA256) == 64
}

func MaybeStartInstallerUpdate(currentVersion, targetDir string) (bool, error) {
	manifest, err := RemoteVersionManifest(5 * time.Second)
	if err != nil {
		return false, err
	}
	if compareVersions(manifest.Version, currentVersion) <= 0 || !validPublicDownload(manifest.Installer) {
		return false, nil
	}
	updateDir := filepath.Join(targetDir, ".installer-update")
	if err := os.MkdirAll(updateDir, 0o755); err != nil {
		return false, err
	}
	destination := filepath.Join(updateDir, "Instalador-Mix-Fiscal-"+manifest.Version+".exe")
	valid := false
	if info, statErr := os.Stat(destination); statErr == nil && info.Size() == manifest.Installer.Size {
		hash, hashErr := SHA256File(destination)
		valid = hashErr == nil && strings.EqualFold(hash, manifest.Installer.SHA256) && hasMZHeader(destination)
	}
	if !valid {
		temporary := destination + ".download"
		_ = os.Remove(temporary)
		request, _ := http.NewRequest(http.MethodGet, manifest.Installer.URL, nil)
		request.Header.Set("User-Agent", "MixFiscalInstallerGo/1")
		response, requestErr := (&http.Client{Timeout: 5 * time.Minute}).Do(request)
		if requestErr != nil {
			return false, fail("A nova versão do instalador não pôde ser baixada.")
		}
		file, createErr := os.Create(temporary)
		if createErr == nil {
			_, createErr = io.Copy(file, io.LimitReader(response.Body, manifest.Installer.Size+1))
			closeErr := file.Close()
			if createErr == nil {
				createErr = closeErr
			}
		}
		response.Body.Close()
		defer os.Remove(temporary)
		if response.StatusCode != http.StatusOK || createErr != nil {
			return false, fail("A nova versão do instalador não pôde ser salva.")
		}
		info, statErr := os.Stat(temporary)
		hash, hashErr := SHA256File(temporary)
		if statErr != nil || info.Size() != manifest.Installer.Size || hashErr != nil || !strings.EqualFold(hash, manifest.Installer.SHA256) || !hasMZHeader(temporary) {
			return false, fail("A atualização do instalador não passou na validação de integridade.")
		}
		if err := replaceFile(temporary, destination); err != nil {
			return false, err
		}
	}
	command := exec.Command(destination, "/DIR="+targetDir)
	command.Dir = targetDir
	if err := command.Start(); err != nil {
		return false, fail("A nova versão foi baixada, mas o Windows não permitiu abri-la.")
	}
	return true, nil
}
