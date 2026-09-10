"""Diagnóstico local, pré-requisitos e integridade do instalador Mix Fiscal.

O módulo não lê nem registra credenciais, conteúdo de configurações ou dados de banco.
"""

from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import winreg

from instalador_core import InstallError


WEBVIEW2_CLIENT = r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
WEBVIEW2_BOOTSTRAPPER = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
RUN_AS_ADMIN_KEY = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
MONITOR_TASK = "Mix Fiscal - Monitorar Integrador"
MANIFEST_URL = "https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json"
PUBLIC_HOST = "appmix-retaguarda-importer.vercel.app"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def has_mz_header(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            return stream.read(2) == b"MZ"
    except OSError:
        return False


def _safe_text(value: object, limit: int = 800) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


class InstallationDiagnostics:
    """Mantém log de texto e relatório JSON sem informações de autenticação."""

    def __init__(self, target_dir: Path):
        self.target_dir = target_dir.resolve()
        self.started_at = datetime.now(timezone.utc)
        self.events: list[dict] = []
        self.log_dirs = self._available_log_dirs()
        self.log_path = self.log_dirs[0] / "instalacao.log"
        self.report_path = self.log_dirs[0] / "diagnostico.json"
        self.event("diagnostico", "ok", "Diagnóstico iniciado")

    def _available_log_dirs(self) -> list[Path]:
        candidates = [self.target_dir / "logs"]
        program_data = os.environ.get("PROGRAMDATA")
        if program_data:
            candidates.append(Path(program_data) / "MixFiscal" / "Logs")
        result: list[Path] = []
        for candidate in candidates:
            try:
                candidate.mkdir(parents=True, exist_ok=True)
                probe = candidate / f".probe-{uuid.uuid4().hex}.tmp"
                probe.write_text("ok", encoding="ascii")
                probe.unlink()
                if candidate.resolve() not in [item.resolve() for item in result]:
                    result.append(candidate)
            except OSError:
                continue
        if not result:
            fallback = Path(tempfile.gettempdir()) / "MixFiscal" / "Logs"
            fallback.mkdir(parents=True, exist_ok=True)
            result.append(fallback)
        return result

    def event(self, step: str, status: str, message: str, **details: object) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        item = {
            "timestamp": timestamp,
            "step": _safe_text(step, 80),
            "status": _safe_text(status, 30),
            "message": _safe_text(message),
        }
        if details:
            item["details"] = {str(key): _safe_text(value) for key, value in details.items()}
        self.events.append(item)
        line = f"[{timestamp}] [{item['status'].upper()}] {item['step']}: {item['message']}\n"
        for directory in self.log_dirs:
            try:
                with (directory / "instalacao.log").open("a", encoding="utf-8") as stream:
                    stream.write(line)
            except OSError:
                pass

    def finish(self, status: str, **summary: object) -> Path:
        finished_at = datetime.now(timezone.utc)
        report = {
            "schema": 1,
            "status": _safe_text(status, 30),
            "started_at": self.started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "target_dir": str(self.target_dir),
            "environment": system_information(),
            "summary": {str(key): _safe_text(value) for key, value in summary.items()},
            "events": self.events,
        }
        payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        for directory in self.log_dirs:
            try:
                destination = directory / "diagnostico.json"
                temporary = destination.with_suffix(".json.tmp")
                temporary.write_text(payload, encoding="utf-8")
                os.replace(temporary, destination)
            except OSError:
                pass
        return self.report_path


def system_information() -> dict:
    return {
        "computer": platform.node(),
        "windows": platform.platform(),
        "architecture": platform.machine(),
        "python_frozen": bool(getattr(__import__("sys"), "frozen", False)),
        "administrator": bool(os.name == "nt" and ctypes.windll.shell32.IsUserAnAdmin()),
    }


def probe_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    original = path / f".mix-write-{uuid.uuid4().hex}.tmp"
    renamed = original.with_suffix(".renamed")
    try:
        original.write_bytes(b"mix-fiscal-permission-test")
        if original.read_bytes() != b"mix-fiscal-permission-test":
            raise OSError("a leitura retornou conteúdo diferente")
        original.replace(renamed)
        renamed.unlink()
    except OSError as exc:
        for candidate in (original, renamed):
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass
        raise InstallError(
            f"O Windows não permitiu gravar e executar a instalação em {path}. "
            "Consulte o diagnóstico ou solicite a liberação da pasta para a TI."
        ) from exc


def webview2_version() -> str:
    locations = (
        (winreg.HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT, winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT, winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_CURRENT_USER, WEBVIEW2_CLIENT, winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_CURRENT_USER, WEBVIEW2_CLIENT, winreg.KEY_WOW64_64KEY),
    )
    versions: list[str] = []
    for hive, key_name, view in locations:
        try:
            with winreg.OpenKey(hive, key_name, 0, winreg.KEY_READ | view) as key:
                value = str(winreg.QueryValueEx(key, "pv")[0]).strip()
                if value and value != "0.0.0.0":
                    versions.append(value)
        except OSError:
            continue
    return max(versions, key=_version_tuple) if versions else ""


def _version_tuple(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in value.split("."))
    except ValueError:
        return (0,)


def remote_manifest(timeout: float = 20) -> dict:
    separator = "&" if "?" in MANIFEST_URL else "?"
    url = f"{MANIFEST_URL}{separator}t={int(datetime.now(timezone.utc).timestamp())}"
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "MixFiscalInstaller/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8-sig"))
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise InstallError("Não foi possível consultar as versões publicadas.") from exc
    if not isinstance(data, dict) or not str(data.get("version", "")):
        raise InstallError("O servidor retornou um manifesto de versões inválido.")
    return data


def version_status(current_version: str, timeout: float = 20) -> dict:
    manifest = remote_manifest(timeout)
    available = str(manifest["version"])
    return {
        "installed": current_version,
        "available": available,
        "update_available": _version_tuple(available) > _version_tuple(current_version),
        "manifest": manifest,
    }


def maybe_start_installer_update(current_version: str, target_dir: Path) -> bool:
    """Baixa, valida e inicia o setup mais novo; versões antigas seguem normalmente."""
    import sys

    if not getattr(sys, "frozen", False):
        return False
    status = version_status(current_version, timeout=5)
    if not status["update_available"]:
        return False
    entry = status["manifest"].get("installer")
    if not isinstance(entry, dict):
        return False
    url = str(entry.get("url", ""))
    parsed = urllib.parse.urlparse(url)
    expected_hash = str(entry.get("sha256", "")).upper()
    try:
        expected_size = int(entry.get("size", 0))
    except (TypeError, ValueError):
        expected_size = 0
    if (
        parsed.scheme != "https" or parsed.hostname != PUBLIC_HOST
        or len(expected_hash) != 64 or expected_size <= 0
    ):
        raise InstallError("Os dados da atualização do instalador são inválidos.")

    update_dir = target_dir / ".installer-update"
    update_dir.mkdir(parents=True, exist_ok=True)
    destination = update_dir / f"Instalador-Mix-Fiscal-{status['available']}.exe"
    valid = (
        destination.is_file() and destination.stat().st_size == expected_size
        and sha256_file(destination) == expected_hash
    )
    if not valid:
        temporary = destination.with_suffix(".download")
        temporary.unlink(missing_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "MixFiscalInstaller/1"})
        try:
            with urllib.request.urlopen(request, timeout=300) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
        except (OSError, urllib.error.URLError) as exc:
            temporary.unlink(missing_ok=True)
            raise InstallError("A nova versão do instalador não pôde ser baixada.") from exc
        if (
            temporary.stat().st_size != expected_size
            or sha256_file(temporary) != expected_hash
            or not has_mz_header(temporary)
        ):
            temporary.unlink(missing_ok=True)
            raise InstallError("A atualização do instalador não passou na validação de integridade.")
        os.replace(temporary, destination)
    subprocess.Popen([str(destination), "--install-dir", str(target_dir)], cwd=str(target_dir))
    return True


def _authenticode_status(path: Path) -> tuple[str, str]:
    command = (
        "$s=Get-AuthenticodeSignature -LiteralPath $args[0];"
        "@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}"
        "|ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command, str(path)],
        check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode:
        return "Error", _safe_text(result.stderr or result.stdout)
    try:
        data = json.loads(result.stdout.strip())
        return str(data.get("status", "")), str(data.get("subject", ""))
    except (TypeError, ValueError):
        return "Unknown", ""


def ensure_webview2(progress, diagnostics: InstallationDiagnostics) -> str:
    installed = webview2_version()
    if installed:
        diagnostics.event("webview2", "ok", "Runtime encontrado", version=installed)
        progress(f"WebView2 Runtime {installed} detectado")
        return installed

    progress("WebView2 ausente; baixando o instalador oficial da Microsoft")
    setup_dir = diagnostics.target_dir / ".setup"
    setup_dir.mkdir(parents=True, exist_ok=True)
    setup = setup_dir / "MicrosoftEdgeWebview2Setup.exe"
    request = urllib.request.Request(WEBVIEW2_BOOTSTRAPPER, headers={"User-Agent": "MixFiscalInstaller/1"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, setup.open("wb") as output:
            shutil.copyfileobj(response, output)
    except (OSError, urllib.error.URLError) as exc:
        diagnostics.event("webview2", "erro", "Falha ao baixar o instalador oficial", error=exc)
        raise InstallError(
            "O WebView2 não está instalado e o download oficial da Microsoft falhou. "
            "Verifique proxy, firewall ou liberação de rede pela TI."
        ) from exc

    if setup.stat().st_size < 100_000 or not has_mz_header(setup):
        raise InstallError("O arquivo baixado para instalar o WebView2 é inválido.")
    signature, subject = _authenticode_status(setup)
    if signature.casefold() != "valid" or "microsoft" not in subject.casefold():
        diagnostics.event("webview2", "erro", "Assinatura Microsoft não confirmada", signature=signature)
        raise InstallError("A assinatura digital do instalador do WebView2 não foi confirmada.")

    progress("Instalando o WebView2 Runtime; aguarde a conclusão")
    result = subprocess.run(
        [str(setup), "/silent", "/install"], check=False, timeout=600,
        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    installed = webview2_version()
    if result.returncode not in (0, 3010) or not installed:
        diagnostics.event(
            "webview2", "erro", "O Runtime não foi confirmado após a instalação",
            exit_code=result.returncode,
        )
        raise InstallError(
            f"O WebView2 não foi confirmado após a instalação (código {result.returncode})."
        )
    diagnostics.event("webview2", "ok", "Runtime instalado", version=installed)
    return installed


def _admin_registry_access() -> int:
    access = winreg.KEY_READ | winreg.KEY_WRITE
    if platform.machine().endswith("64"):
        access |= winreg.KEY_WOW64_64KEY
    return access


def configure_run_as_admin(executable: Path) -> None:
    executable = executable.resolve()
    if not executable.is_file():
        raise InstallError(f"Não foi possível configurar administrador: {executable.name} está ausente.")
    try:
        with winreg.CreateKeyEx(
            winreg.HKEY_LOCAL_MACHINE, RUN_AS_ADMIN_KEY, 0, _admin_registry_access()
        ) as key:
            try:
                current = str(winreg.QueryValueEx(key, str(executable))[0])
            except FileNotFoundError:
                current = "~"
            flags = current.split()
            if "RUNASADMIN" not in {flag.upper() for flag in flags}:
                flags.append("RUNASADMIN")
            value = " ".join(flags).strip() or "~ RUNASADMIN"
            winreg.SetValueEx(key, str(executable), 0, winreg.REG_SZ, value)
            confirmed = str(winreg.QueryValueEx(key, str(executable))[0])
    except OSError as exc:
        raise InstallError(
            "O Windows não permitiu marcar o Integrador para executar como administrador. "
            "Verifique as políticas da TI."
        ) from exc
    if "RUNASADMIN" not in confirmed.upper().split():
        raise InstallError("A configuração de execução como administrador não foi confirmada.")


def is_run_as_admin_configured(executable: Path) -> bool:
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, RUN_AS_ADMIN_KEY, 0, _admin_registry_access()
        ) as key:
            value = str(winreg.QueryValueEx(key, str(executable.resolve()))[0])
        return "RUNASADMIN" in value.upper().split()
    except OSError:
        return False


def file_version(path: Path) -> str:
    if not path.is_file():
        return "não instalado"
    command = "[Diagnostics.FileVersionInfo]::GetVersionInfo($args[0]).FileVersion"
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command, str(path)],
        check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    value = result.stdout.strip()
    return value or "sem versão interna"


def task_installed(task_name: str = MONITOR_TASK) -> bool:
    result = subprocess.run(
        ["schtasks.exe", "/Query", "/TN", task_name], check=False, capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return result.returncode == 0


def security_protection_findings(target_dir: Path) -> list[dict]:
    """Coleta somente ocorrências do Defender relacionadas à pasta ou ao Integrador."""
    command = (
        "$target=[IO.Path]::GetFullPath($args[0]);$result=@();"
        "if(Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue){"
        "$result=@(Get-MpThreatDetection -ErrorAction SilentlyContinue|"
        "Where-Object{($_.Resources -join ' ') -like ('*'+$target+'*') -or "
        "($_.Resources -join ' ') -like '*desktop-integrador.exe*'}|"
        "Select-Object -First 10 ThreatID,InitialDetectionTime,ActionSuccess,Resources)};"
        "$result|ConvertTo-Json -Depth 4 -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command, str(target_dir)],
        check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode or not result.stdout.strip():
        return []
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return []
    if isinstance(data, dict):
        return [data]
    return data if isinstance(data, list) else []


def environment_report(target_dir: Path, bundled_version: str = "", check_remote: bool = True) -> dict:
    target = target_dir / "desktop-integrador.exe"
    installed_release = "não instalado"
    version_file = target_dir / "integrador_version.json"
    try:
        data = json.loads(version_file.read_text(encoding="utf-8-sig"))
        installed_release = str(data.get("version", "não informada"))
    except (OSError, TypeError, ValueError):
        pass
    report = {
        "installer_version": bundled_version or "não informada",
        "integrator_release": installed_release,
        "integrator_file_version": file_version(target),
        "panel_version": installed_release if (target_dir / "Painel_Mix.bat").is_file() else "não instalado",
        "webview2_version": webview2_version() or "não instalado",
        "monitor": "instalado" if task_installed() else "não instalado",
        "run_as_admin": "configurado" if is_run_as_admin_configured(target) else "não configurado",
        "target_dir": str(target_dir),
        "security_findings": len(security_protection_findings(target_dir)),
    }
    if check_remote:
        try:
            status = version_status(bundled_version)
            report["available_version"] = status["available"]
            report["update_available"] = status["update_available"]
        except InstallError as exc:
            report["available_version"] = "consulta indisponível"
            report["update_available"] = False
            report["update_error"] = str(exc)
    return report
