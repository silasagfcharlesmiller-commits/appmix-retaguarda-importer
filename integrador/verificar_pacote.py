"""Valida integralmente o CArchive gerado pelo PyInstaller."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Uso: verificar_pacote.py <Instalador-Mix-Fiscal.exe>")

    package = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parent
    archive = CArchiveReader(str(package))
    extracted: dict[str, bytes] = {}

    for name, entry in archive.toc.items():
        typecode = entry[4]
        if typecode in {"o", "n"}:
            continue
        data = archive.extract(name)
        if len(data) != entry[2]:
            raise RuntimeError(
                f"Entrada {name!r} possui {len(data)} bytes; esperado: {entry[2]}."
            )
        if name in {"desktop-integrador.exe", r"playwright\driver\node.exe"}:
            extracted[name] = data

    required = {
        "Painel_Mix.bat",
        "atualizador_mix.ps1",
        "desktop-integrador.exe",
        "integrador_version.json",
        r"playwright\driver\node.exe",
    }
    missing = required.difference(archive.toc)
    if missing:
        raise RuntimeError(f"Arquivos obrigatorios ausentes: {sorted(missing)}")

    source_integrator = (root / "desktop-integrador.exe").read_bytes()
    if sha256(extracted["desktop-integrador.exe"]) != sha256(source_integrator):
        raise RuntimeError("O Integrador embutido difere do arquivo de origem.")

    source_node = (
        Path(sys.executable).resolve().parent.parent
        / "Lib"
        / "site-packages"
        / "playwright"
        / "driver"
        / "node.exe"
    )
    if not source_node.is_file():
        raise RuntimeError(f"Node do Playwright nao encontrado em {source_node}.")
    if sha256(extracted[r"playwright\driver\node.exe"]) != sha256(source_node.read_bytes()):
        raise RuntimeError("O Node do Playwright embutido difere do arquivo de origem.")

    with package.open("rb") as stream:
        mz_header = stream.read(2)
    if mz_header != b"MZ":
        raise RuntimeError("O pacote nao possui cabecalho executavel MZ.")

    print(f"Pacote integro: {len(archive.toc)} entradas descompactadas e validadas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
