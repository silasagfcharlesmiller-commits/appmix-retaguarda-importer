"""Valida os executáveis nativos Go/Wails e o setup Inno gerado."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def mz(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            return stream.read(2) == b"MZ"
    except OSError:
        return False


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit(
            "Uso: verificar_pacote.py <setup.exe> <runtime_dir> <payload_manifest.json>"
        )

    setup = Path(sys.argv[1]).resolve()
    runtime = Path(sys.argv[2]).resolve()
    manifest_path = Path(sys.argv[3]).resolve()
    root = Path(__file__).resolve().parent

    if not setup.is_file() or setup.stat().st_size < 1_000_000 or not mz(setup):
        raise RuntimeError("O instalador Inno Setup não é um executável Windows válido.")

    required_runtime = {
        "Instalador-Mix-Fiscal-App.exe",
        "MixFiscal-Bootstrap.exe",
        "payload_manifest.json",
    }
    runtime_files = {path.name for path in runtime.iterdir() if path.is_file()}
    if runtime_files != required_runtime:
        raise RuntimeError(f"Runtime Go/Wails inesperado: {sorted(runtime_files)}")
    for name in ("Instalador-Mix-Fiscal-App.exe", "MixFiscal-Bootstrap.exe"):
        executable = runtime / name
        if executable.stat().st_size < 500_000 or not mz(executable):
            raise RuntimeError(f"Executável nativo ausente ou inválido: {name}.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    files = manifest.get("files", {})
    required = {
        "desktop-integrador.exe", "Painel_Mix.bat", "atualizador_mix.ps1",
        "monitor_mix.ps1", "run_silent.vbs", "integrador_version.json",
    }
    if set(files) != required:
        raise RuntimeError("O manifesto interno não contém exatamente os componentes esperados.")
    for name, metadata in files.items():
        source = root / name
        if not source.is_file():
            raise RuntimeError(f"Componente de origem ausente: {name}.")
        if source.stat().st_size != int(metadata["size"]) or sha256(source) != metadata["sha256"]:
            raise RuntimeError(f"Manifesto interno não corresponde a {name}.")

    embedded_manifest = runtime / "payload_manifest.json"
    if sha256(embedded_manifest) != sha256(manifest_path):
        raise RuntimeError("O manifesto de componentes não foi incorporado ao runtime.")

    forbidden_names = {"node.exe", "python3.dll", "python312.dll"}
    forbidden = [
        path for path in runtime.rglob("*")
        if path.name.casefold() in forbidden_names
        or any(part.casefold() in {"playwright", "pyqt6", "_internal"} for part in path.parts)
    ]
    if forbidden:
        raise RuntimeError(f"Runtime legado ainda incluído no pacote: {forbidden[0]}")

    print(
        "Pacote Go/Wails íntegro: 2 executáveis nativos, sem Python/PyQt/Playwright/Node; "
        f"setup {setup.stat().st_size} bytes; SHA-256 {sha256(setup)}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
