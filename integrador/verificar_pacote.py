"""Valida o runtime onedir e o instalador convencional gerado pelo Inno Setup."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader


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
    runtime_exe = runtime / "Instalador-Mix-Fiscal-App.exe"
    if not runtime_exe.is_file() or not mz(runtime_exe):
        raise RuntimeError("A aplicação interna do instalador está ausente ou inválida.")

    archive = CArchiveReader(str(runtime_exe))
    for name, entry in archive.toc.items():
        if entry[4] in {"o", "n"}:
            continue
        data = archive.extract(name)
        if len(data) != entry[2]:
            raise RuntimeError(f"Entrada interna corrompida: {name!r}.")

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

    forbidden = [
        path for path in runtime.rglob("*")
        if path.name.casefold() == "node.exe"
        or any(part.casefold() == "playwright" for part in path.parts)
    ]
    if forbidden:
        raise RuntimeError(f"Playwright/Node ainda foi incluído no runtime: {forbidden[0]}")

    embedded_manifest = runtime / "_internal" / "payload_manifest.json"
    if not embedded_manifest.is_file() or sha256(embedded_manifest) != sha256(manifest_path):
        raise RuntimeError("O manifesto de componentes não foi incorporado ao runtime.")

    print(
        f"Pacote convencional íntegro: runtime com {len(archive.toc)} entradas, "
        f"sem Playwright/Node; setup {setup.stat().st_size} bytes; SHA-256 {sha256(setup)}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
