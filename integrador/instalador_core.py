"""Validação e consultas da instalação do Integrador."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse

AUTH_URL = "https://authentication-builder.mixfiscal.com.br/v1/login"
API_BASE = "https://api.mixfiscal.com.br/integrador/api/v1"
ROBOT_PROXY = "https://api.mixfiscal.com.br/interno/v1/proxy/robot"


class InstallError(RuntimeError):
    pass


class ApiError(InstallError):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def normalize_cnpj(value: str) -> str:
    cnpj = re.sub(r"\D", "", value)
    if len(cnpj) != 14 or len(set(cnpj)) == 1:
        raise InstallError("Informe um CNPJ válido.")
    for length, weights in ((12, (5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)),
                            (13, (6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2))):
        remainder = sum(int(n) * w for n, w in zip(cnpj[:length], weights)) % 11
        digit = 0 if remainder < 2 else 11 - remainder
        if int(cnpj[length]) != digit:
            raise InstallError("Os dígitos verificadores do CNPJ estão incorretos.")
    return cnpj


def host_id() -> str:
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography",
                       0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        return str(winreg.QueryValueEx(key, "MachineGuid")[0]).strip().lower()


def generate_machine_id() -> str:
    # NewRandom no executável: SHA256(HostID + "|" + hostname + "|" + hex(rand[16])).
    seed = f"{host_id()}|{socket.gethostname()}|{secrets.token_hex(16)}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


def validate_machine_id(value: str) -> str:
    # IDs legados editados podem ter comprimento diferente de 64. Nunca usar como caminho livre.
    if not isinstance(value, str) or not re.fullmatch(r"[a-fA-F0-9]{32,128}", value):
        raise InstallError("Machine ID local inválido; configuração preservada.")
    return value


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise InstallError(f"Não foi possível ler {path.name}; arquivo preservado.") from exc
    if not isinstance(data, dict):
        raise InstallError(f"Formato inesperado em {path.name}; arquivo preservado.")
    return data


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def registration_payload(cnpj: str, machine_id: str) -> dict:
    return {
        "machine_id": validate_machine_id(machine_id), "cnpj_cpf": normalize_cnpj(cnpj),
        "database": "", "host": "", "port": "", "service_name": "", "username": "",
        "password": "", "dialect": "", "mixfiscal_service_name": "", "observation": "",
        "vw_pis_cofins": "", "vw_icms_entrada": "", "vw_icms_saida": "", "vw_ibs_cbs": "",
        "tmp_pis_cofins": "", "tmp_icms_entrada": "", "tmp_icms_saida": "", "tmp_ibs_cbs": "",
        "push_schedule_time": "", "pull_schedule_time": "", "max_message_size_mb": 4,
        "metadata": {"tag_service": ["mixfiscal"], "cnpjs": [], "connections": [],
                     "isXmlClient": False, "processXmlRealtime": False, "xmlObserver": None},
    }


class MixApi:
    def __init__(self):
        self.token = ""

    def request(self, method: str, url: str, payload=None):
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(url, method=method, headers=headers,
                                         data=None if payload is None else json.dumps(payload).encode())
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            # Respostas podem incluir dados de conexão: não registrar o corpo.
            raise ApiError(exc.code, f"A API retornou HTTP {exc.code} na etapa {method}.") from None
        except (urllib.error.URLError, TimeoutError) as exc:
            raise InstallError("Não foi possível comunicar com a API. Verifique a conexão e tente novamente.") from exc
        except ValueError as exc:
            raise InstallError("A API retornou um documento que não é JSON válido.") from exc

    def login(self, username: str, password: str) -> None:
        self.token = ""
        data = self.request("POST", AUTH_URL, {"email": username.strip(), "password": password,
                                               "browser_id": "integrador"})
        token = data.get("token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise InstallError("O login não retornou um token válido.")
        self.token = re.sub(r"^Bearer\s+", "", token.strip(), flags=re.I)

    def settings(self, machine_id: str):
        try:
            data = self.request("GET", API_BASE + "/settings/details/" + validate_machine_id(machine_id))
        except ApiError as exc:
            if exc.status == 404:
                return None
            raise
        if data is None or data == {}:
            return None
        if not isinstance(data, dict) or data.get("machine_id") != machine_id:
            raise InstallError("A consulta retornou uma identidade inesperada; nenhuma configuração foi gravada.")
        return data

    def client_machines(self, cnpj: str) -> list[dict]:
        cnpj = normalize_cnpj(cnpj)
        query = urllib.parse.urlencode({"search": cnpj, "page_size": 100})
        data = self.request("GET", API_BASE + "/clients/list?" + query)
        clients = data.get("clients", []) if isinstance(data, dict) else []
        result = []
        seen = set()
        for item in clients:
            if not isinstance(item, dict):
                continue
            item_cnpj = re.sub(r"\D", "", str(item.get("cnpj_cpf", "")))
            item_id = item.get("machine_id")
            try:
                item_id = validate_machine_id(item_id)
            except InstallError:
                continue
            if item_cnpj == cnpj and item_id not in seen:
                result.append(item)
                seen.add(item_id)
        return result

    def client_machine(self, cnpj: str, machine_id: str):
        machine_id = validate_machine_id(machine_id)
        for item in self.client_machines(cnpj):
            if item.get("machine_id") == machine_id:
                return item
        return None

    def wait_until_online(self, cnpj: str, machine_id: str, timeout: float = 40):
        online_statuses = {"active", "online", "connected", "conectado"}
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.client_machine(cnpj, machine_id)
            status = str((last or {}).get("status", "")).strip().lower()
            if status in online_statuses:
                return last
            time.sleep(1)
        raise InstallError(
            "O Machine ID foi cadastrado, mas ainda não apareceu online para o App Mix."
        )

    def verify_registration(self, cnpj: str, machine_id: str) -> dict:
        cnpj = normalize_cnpj(cnpj)
        current = self.settings(machine_id)
        if not current or re.sub(r"\D", "", str(current.get("cnpj_cpf", ""))) != cnpj:
            raise InstallError("Não foi confirmado o vínculo deste Machine ID com o CNPJ informado.")
        tags = (current.get("metadata") or {}).get("tag_service", [])
        if isinstance(tags, str):
            tags = [tags]
        if "mixfiscal" not in tags:
            raise InstallError("O cadastro existente não contém o serviço Mix Fiscal; foi preservado.")
        return current

    def robot_details(self, cnpj: str, machine_id: str) -> dict:
        data = self.request("GET", ROBOT_PROXY + "/" + validate_machine_id(machine_id))
        if not isinstance(data, dict) or not data:
            raise InstallError("A API ainda não retornou os detalhes do robô. Execute novamente para retomar.")
        if data.get("machineId", data.get("machine_id")) != machine_id:
            raise InstallError("Os detalhes do robô pertencem a outra identidade.")
        return data
