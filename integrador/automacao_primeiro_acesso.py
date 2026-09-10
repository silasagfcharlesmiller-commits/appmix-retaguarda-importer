"""Automação do primeiro acesso do Desktop Integrador.

O fluxo usa a própria interface e a ponte nativa Wails do aplicativo. A porta de
depuração é habilitada somente durante a instalação e removida no bloco finally.
"""

from __future__ import annotations

from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Callable
import urllib.request
import winreg

from cdp_browser import CdpPage
from diagnostico_instalador import (
    InstallationDiagnostics, configure_run_as_admin, ensure_webview2,
    is_run_as_admin_configured, probe_directory, security_protection_findings, sha256_file,
)
from instalador_core import (
    InstallError, MixApi, normalize_cnpj, read_json, validate_machine_id,
)

def installer_directory() -> Path:
    """Usa a pasta do instalador empacotado como destino da instalação."""
    if "--install-dir" in sys.argv:
        try:
            value = sys.argv[sys.argv.index("--install-dir") + 1]
        except IndexError as exc:
            raise InstallError("O parâmetro --install-dir está sem o caminho de destino.") from exc
        return Path(value).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    development_dir = Path(__file__).resolve().parent
    return Path(os.environ.get("MIX_INSTALL_DIR", str(development_dir))).resolve()


TARGET_DIR = installer_directory()
TARGET_EXE = TARGET_DIR / "desktop-integrador.exe"
APP_SETTINGS = Path(os.environ["APPDATA"]) / "mixfiscal-integrador" / "local_settings.json"
DEBUG_KEY = r"SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
DEBUG_VALUE = "desktop-integrador.exe"
DEBUG_PORT = 19327
MONITOR_TASK = "Mix Fiscal - Monitorar Integrador"

Progress = Callable[[str], None]


def _source_exe() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    source = base / "desktop-integrador.exe"
    if not source.is_file():
        source = TARGET_DIR / "desktop-integrador.exe"
    if not source.is_file():
        raise InstallError("desktop-integrador.exe não foi encontrado junto do instalador.")
    return source


def _source_asset(name: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    source = base / name
    if not source.is_file():
        source = TARGET_DIR / name
    if not source.is_file():
        raise InstallError(f"{name} não foi encontrado junto do instalador.")
    return source


def require_admin() -> None:
    if os.name != "nt" or not ctypes.windll.shell32.IsUserAnAdmin():
        raise InstallError("Execute o instalador como administrador.")


def _stop_integrator() -> None:
    target = str(TARGET_EXE).replace("'", "''")
    # O filtro usa o destino atual e só encerra esta instalação.
    command = (
        f"$target='{target}';"
        "Get-CimInstance Win32_Process -Filter \"Name='desktop-integrador.exe'\" | "
        "Where-Object {$_.ExecutablePath -eq $target} | "
        "ForEach-Object {Stop-Process -Id $_.ProcessId -Force}"
    )
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        check=False, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )


def _optional_machine_id(path: Path) -> str:
    if not path.is_file():
        return ""
    value = read_json(path).get("machine_id", "")
    return validate_machine_id(value) if value else ""


def find_local_machine_id() -> str:
    config_id = _optional_machine_id(TARGET_DIR / "config" / "machine_id.json")
    app_id = _optional_machine_id(APP_SETTINGS)
    if config_id and app_id and config_id != app_id:
        raise InstallError(
            "Os arquivos locais contêm Machine IDs diferentes. Eles foram preservados para revisão."
        )
    return config_id or app_id


def _copy_verified(source: Path, destination: Path) -> str:
    """Copia de forma atômica e confirma a integridade; repete uma vez se houver bloqueio."""
    source_hash = sha256_file(source)
    if source.resolve() == destination.resolve():
        if not destination.is_file() or sha256_file(destination) != source_hash:
            raise InstallError(f"O componente local {destination.name} está corrompido.")
        return source_hash
    last_error: Exception | None = None
    for attempt in range(2):
        temporary = destination.with_name(f".{destination.name}.installing")
        try:
            temporary.unlink(missing_ok=True)
            shutil.copy2(source, temporary)
            if sha256_file(temporary) != source_hash:
                raise OSError("o SHA-256 da cópia temporária não confere")
            os.replace(temporary, destination)
            if not destination.is_file() or sha256_file(destination) != source_hash:
                raise OSError("o arquivo desapareceu ou foi alterado após a cópia")
            return source_hash
        except OSError as exc:
            last_error = exc
            temporary.unlink(missing_ok=True)
            if attempt == 0:
                time.sleep(0.8)
    raise InstallError(
        f"Não foi possível instalar {destination.name}. O arquivo pode ter sido bloqueado "
        "ou removido pela proteção da máquina. Consulte o diagnóstico para a TI."
    ) from last_error


def _verify_payload_manifest() -> None:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    manifest_path = base / "payload_manifest.json"
    if not manifest_path.is_file():
        return
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise InstallError("O manifesto interno dos componentes é inválido.") from exc
    files = manifest.get("files", {}) if isinstance(manifest, dict) else {}
    if not isinstance(files, dict) or not files:
        raise InstallError("O manifesto interno não contém os componentes.")
    for name, metadata in files.items():
        destination = TARGET_DIR / name
        try:
            expected_size = int(metadata["size"])
            expected_hash = str(metadata["sha256"]).upper()
        except (KeyError, TypeError, ValueError) as exc:
            raise InstallError(f"Metadados internos inválidos para {name}.") from exc
        if (
            not destination.is_file()
            or destination.stat().st_size != expected_size
            or sha256_file(destination) != expected_hash
        ):
            raise InstallError(
                f"O componente {name} foi removido ou alterado durante a instalação. "
                "Consulte o diagnóstico para a TI."
            )


def prepare_files(progress: Progress, diagnostics: InstallationDiagnostics | None = None) -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    probe_directory(TARGET_DIR)
    if diagnostics:
        diagnostics.event("permissões", "ok", "Leitura, gravação e renomeação confirmadas")
    _stop_integrator()
    source_exe = _source_exe()
    installed = {TARGET_EXE.name: _copy_verified(source_exe, TARGET_EXE)}
    for name in (
        "Painel_Mix.bat", "atualizador_mix.ps1", "monitor_mix.ps1",
        "run_silent.vbs", "integrador_version.json",
    ):
        destination = TARGET_DIR / name
        source = _source_asset(name)
        installed[name] = _copy_verified(source, destination)
    _verify_payload_manifest()
    configure_run_as_admin(TARGET_EXE)
    if not is_run_as_admin_configured(TARGET_EXE):
        raise InstallError("A execução permanente como administrador não foi confirmada.")
    if diagnostics:
        diagnostics.event(
            "componentes", "ok", "Arquivos instalados e validados por SHA-256",
            count=len(installed),
        )
        diagnostics.event(
            "administrador", "ok", "Integrador marcado para executar como administrador",
            executable=TARGET_EXE,
        )
    progress(f"Aplicativo preparado em {TARGET_DIR}")


def install_monitor(progress: Progress) -> None:
    """Instala o monitor pelo Painel Mix, sem exibir uma janela de console."""
    progress("Instalando o monitor automático do Integrador")
    script = TARGET_DIR / "monitor_mix.ps1"
    monitor_source = _source_asset("monitor_mix.ps1")
    if monitor_source.resolve() != script.resolve():
        shutil.copy2(monitor_source, script)
    launcher = TARGET_DIR / "run_silent.vbs"
    launcher_source = _source_asset("run_silent.vbs")
    if launcher_source.resolve() != launcher.resolve():
        shutil.copy2(launcher_source, launcher)
    if not script.is_file() or not launcher.is_file():
        raise InstallError("Os arquivos do monitor não foram instalados.")

    panel = TARGET_DIR / "Painel_Mix.bat"
    if not panel.is_file():
        raise InstallError("Painel_Mix.bat não foi encontrado na pasta da instalação.")
    result = subprocess.run(
        ["cmd.exe", "/D", "/C", "call", str(panel), "--install-monitor"],
        cwd=str(TARGET_DIR), check=False, capture_output=True, text=True,
        encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW,
    )
    (TARGET_DIR / "painel_install_log.txt").write_text(
        (result.stdout or "") + (result.stderr or ""), encoding="utf-8"
    )
    if result.returncode:
        raise InstallError(
            "O Painel Mix não conseguiu instalar a tarefa do monitor. "
            "Consulte painel_install_log.txt."
        )
    check = subprocess.run(
        ["schtasks.exe", "/Query", "/TN", MONITOR_TASK],
        check=False, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if check.returncode:
        raise InstallError("A tarefa do Monitor Mix Fiscal não foi encontrada após a instalação.")
    progress("Monitor do Windows instalado pelo Painel Mix e verificado")

@contextmanager
def temporary_webview_debug():
    """Habilita CDP em HKLM; WebView2 elevado ignora HKCU e variáveis de usuário."""
    existed = False
    previous = None
    access = winreg.KEY_READ | winreg.KEY_WRITE | winreg.KEY_WOW64_64KEY
    key = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, DEBUG_KEY, 0, access)
    try:
        try:
            previous, _ = winreg.QueryValueEx(key, DEBUG_VALUE)
            existed = True
        except FileNotFoundError:
            pass
        winreg.SetValueEx(
            key, DEBUG_VALUE, 0, winreg.REG_SZ,
            f"--remote-debugging-port={DEBUG_PORT} --remote-debugging-address=127.0.0.1",
        )
        yield
    finally:
        if existed:
            winreg.SetValueEx(key, DEBUG_VALUE, 0, winreg.REG_SZ, previous)
        else:
            try:
                winreg.DeleteValue(key, DEBUG_VALUE)
            except FileNotFoundError:
                pass
        key.Close()


def _wait_debug_port(timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{DEBUG_PORT}/json/version"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.25)
    raise InstallError("O WebView2 não abriu a porta temporária de automação.")


def _start_integrator_verified(progress: Progress, diagnostics: InstallationDiagnostics) -> None:
    if not TARGET_EXE.is_file():
        raise InstallError("O Integrador desapareceu antes da inicialização final.")
    progress("Abrindo e validando o processo do Integrador")
    try:
        process = subprocess.Popen(
            [str(TARGET_EXE)], cwd=str(TARGET_DIR),
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        time.sleep(2)
    except OSError as exc:
        raise InstallError(
            "O Windows bloqueou a abertura do Integrador. Consulte o diagnóstico para a TI."
        ) from exc
    if process.poll() is not None:
        raise InstallError(
            f"O Integrador encerrou logo após abrir (código {process.returncode}). "
            "Consulte o diagnóstico para a TI."
        )
    diagnostics.event("processo", "ok", "Integrador iniciado e permaneceu em execução")


def _persist_native_id(page, machine_id: str) -> None:
    result = page.evaluate(
        f"""(async () => {{
            const id = {json.dumps(machine_id)};
            const settings = await window.go.app.App.GetLocalSettings();
            await window.go.app.App.SaveLocalSettings({{...settings, machine_id: id}});
            return await window.go.app.App.LoadSavedMachineID();
        }})()""",
    )
    if result != machine_id:
        raise InstallError("O Integrador não confirmou o Machine ID no disco.")


def _open_settings_with_login(page, username: str, password: str, progress: Progress) -> None:
    """Abre Configurações pelo menu e conclui a confirmação de acesso."""
    # A busca inicial pode encaminhar diretamente para Configurações. Voltamos ao
    # Dashboard para que o clique no menu execute a confirmação de acesso prevista pelo app.
    if page.visible_text("Configurações", "h1,h2,h3"):
        if not page.visible_text("Dashboard", "a,button"):
            raise InstallError("Não foi possível retornar ao Dashboard para confirmar o acesso.")
        page.click_text("Dashboard", "a,button")
        page.wait_text_hidden("Configurações")

    if not page.visible_text("Configurações", "h1,h2,h3"):
        progress("Abrindo Configurações do Integrador")
        page.wait_text("Configurações", 20, "a,button")
        page.click_text("Configurações", "a,button")
        page.wait(
            """(() => {
                const confirm = [...document.querySelectorAll('button')]
                    .some(e => e.innerText.trim() === 'Confirmar');
                const title = [...document.querySelectorAll('h1,h2,h3')]
                    .some(e => e.innerText.trim() === 'Configurações');
                return confirm || title;
            })()""",
            20, "A tela de Configurações não apareceu.",
        )

    if page.visible_text("Confirmar", "button"):
        progress("Confirmando o login em Configurações")
        page.fill_placeholder("Email ou CPF/CNPJ", username)
        page.fill_placeholder("Senha", password)
        page.click_text("Confirmar", "button")

    page.wait_text("Configurações", 25, "h1,h2,h3")


def _install_from_settings(page, progress: Progress) -> None:
    progress("Instalando a inicialização automática")
    status = page.evaluate("window.go.app.App.GetWindowsServiceStatus()")
    if status == "not_installed":
        page.wait_text("Instalar", 15, "button")
        progress("Clicando em Instalar")
        page.click_text("Instalar", "button")

    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        status = page.evaluate("window.go.app.App.GetWindowsServiceStatus()")
        if status == "running":
            return
        if status == "stopped":
            if page.visible_text("Iniciar", "button"):
                page.click_text("Iniciar", "button")
        time.sleep(0.5)
    raise InstallError(f"A inicialização não ficou ativa; estado atual: {status!r}.")


def _automate_ui(cnpj: str, username: str, password: str,
                 expected_id: str, progress: Progress) -> str:
    page = CdpPage(DEBUG_PORT)
    try:
        if page.url == "about:blank":
            page.navigate("http://wails.localhost/")

        if page.visible_placeholder("Email ou CPF/CNPJ"):
            progress("Autenticando no Integrador")
            page.fill_placeholder("Email ou CPF/CNPJ", username)
            page.fill_password(password)
            page.click_text("Entrar", "button")
            page.wait_placeholder_hidden("Email ou CPF/CNPJ", 25)

        progress("Aproveitando a identidade gerada pelo Integrador")
        saved_id = page.evaluate("window.go.app.App.LoadSavedMachineID()")
        if expected_id:
            machine_id = expected_id
            if saved_id and saved_id != expected_id:
                raise InstallError(
                    "O Integrador apresentou um Machine ID diferente do arquivo local. "
                    "Nenhum cadastro foi alterado."
                )
        elif saved_id:
            machine_id = saved_id
        elif page.visible_text("iniciar nova configuracao", "button", normalize=True):
            # Este clique chama EnsureMachineIDForNewClient dentro da própria tela.
            # Lemos o valor exibido; não chamamos o gerador uma segunda vez.
            page.click_text("iniciar nova configuracao", "button", normalize=True)
            page.wait_css("input.machine-generated-id-input", 15)
            machine_id = page.input_value("input.machine-generated-id-input")
        else:
            # Retomada defensiva caso uma versão futura não mostre o modal inicial.
            machine_id = page.evaluate("window.go.app.App.EnsureMachineIDForNewClient()")
        machine_id = validate_machine_id(machine_id)

        # O ID é salvo antes de qualquer clique posterior. Se houver falha, a nova
        # execução retoma exatamente a mesma identidade.
        _persist_native_id(page, machine_id)

        if page.visible_placeholder("Informe o machine_id legado"):
            page.fill_placeholder("Informe o machine_id legado", machine_id)
            page.click_text("buscar e configurar aplicacao", "button", normalize=True)
            page.wait(
                """(() => {
                    const config = [...document.querySelectorAll('h1,h2,h3')]
                        .some(e => e.innerText.trim() === 'Configurações');
                    const dashboard = [...document.querySelectorAll('a,button')]
                        .some(e => e.innerText.trim() === 'Dashboard');
                    return config || dashboard;
                })()""",
                25, "O Integrador não abriu a configuração do Machine ID.",
            )

        _open_settings_with_login(page, username, password, progress)

        progress("Vinculando o CNPJ ao serviço Mix Fiscal")
        page.wait_placeholder("00.000.000/0001-00", 20)
        page.fill_placeholder("00.000.000/0001-00", cnpj)
        has_service = page.evaluate(
            """(() => { try {
                const config = JSON.parse(localStorage.getItem('mxf_config') || '{}');
                return (config.tag_service || []).includes('mixfiscal');
            } catch { return false; } })()"""
        )
        if not has_service:
            page.add_select_option("mixfiscal", "Adicionar")
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        progress("Salvando CNPJ e serviço Mix Fiscal")
        page.click_text("Salvar Configurações", "button")
        page.wait(
            f"""(() => {{ try {{
                const config = JSON.parse(localStorage.getItem('mxf_config') || '{{}}');
                return config.cnpj_cpf === {json.dumps(cnpj)} &&
                    (config.tag_service || []).includes('mixfiscal');
            }} catch {{ return false; }} }})()""",
            30, "O CNPJ e o serviço Mix Fiscal não foram confirmados após salvar.",
        )

        _persist_native_id(page, machine_id)

        _install_from_settings(page, progress)
        progress("Instalação ativa; preparando a abertura da interface")
        return machine_id
    finally:
        page.close()


def install(cnpj: str, username: str, password: str, *, progress: Progress = print) -> dict:
    diagnostics = InstallationDiagnostics(TARGET_DIR)
    machine_id = ""
    completed = False
    try:
        require_admin()
        diagnostics.event("administrador", "ok", "Instalador executando elevado")
        cnpj = normalize_cnpj(cnpj)
        if not username.strip() or not password:
            raise InstallError("Informe usuário e senha do Integrador.")

        ensure_webview2(progress, diagnostics)
        progress("Validando o acesso à API")
        api = MixApi()
        api.login(username, password)
        diagnostics.event("api", "ok", "Autenticação confirmada")
        local_machine_id = find_local_machine_id()
        prepare_files(progress, diagnostics)
        with temporary_webview_debug():
            _stop_integrator()
            subprocess.Popen(
                [str(TARGET_EXE)], cwd=str(TARGET_DIR),
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            _wait_debug_port()
            machine_id = _automate_ui(
                cnpj, username, password, local_machine_id, progress
            )

        # A interface nativa já instalou suas tarefas. Ativamos o monitor antes
        # das consultas finais para que uma demora da API não deixe o cliente sem proteção.
        install_monitor(progress)
        diagnostics.event("monitor", "ok", "Tarefa de monitoramento instalada e verificada")
        progress("Confirmando cadastro na API")
        api.verify_registration(cnpj, machine_id)
        local_id = read_json(TARGET_DIR / "config" / "machine_id.json").get("machine_id")
        app_id = read_json(APP_SETTINGS).get("machine_id")
        if local_id != machine_id or app_id != machine_id:
            raise InstallError("O Machine ID não ficou igual nos dois arquivos locais.")
        progress("Aguardando o Machine ID ficar online no App Mix")
        api.wait_until_online(cnpj, machine_id)
        diagnostics.event("cadastro", "ok", "CNPJ, serviço Mix Fiscal e Machine ID confirmados")
        _stop_integrator()
        _start_integrator_verified(progress, diagnostics)
        report = diagnostics.finish("concluído", monitor=MONITOR_TASK, result="online")
        completed = True
        return {
            "cnpj": cnpj, "machine_id": machine_id, "monitor": MONITOR_TASK,
            "diagnostic": str(report),
        }
    except Exception as exc:
        diagnostics.event("instalação", "erro", str(exc), exception=type(exc).__name__)
        findings = security_protection_findings(TARGET_DIR)
        if findings:
            diagnostics.event(
                "proteção", "atenção",
                "O Microsoft Defender registrou ocorrência relacionada ao Integrador",
                occurrences=len(findings),
                findings=json.dumps(findings, ensure_ascii=False, default=str),
            )
        report = diagnostics.finish("falhou", error=exc)
        message = str(exc) if isinstance(exc, InstallError) else f"Falha inesperada: {exc}"
        raise InstallError(f"{message}\n\nDiagnóstico salvo em:\n{report}") from exc
    finally:
        # Fecha o processo com CDP e reabre visível, como "Abrir Interface" no ícone da bandeja.
        if not completed:
            _stop_integrator()
            if machine_id and TARGET_EXE.exists():
                try:
                    subprocess.Popen(
                        [str(TARGET_EXE)], cwd=str(TARGET_DIR),
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                except OSError:
                    pass
