import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from automacao_primeiro_acesso import (
    _copy_verified, find_local_machine_id, install_monitor, installer_directory,
)
from diagnostico_instalador import InstallationDiagnostics, probe_directory, sha256_file
from instalador_core import (InstallError, MixApi, atomic_json, generate_machine_id,
                            normalize_cnpj, read_json, registration_payload, validate_machine_id)


class InstallerTests(unittest.TestCase):
    def test_panel_batch_has_real_lines_and_monitor_actions(self):
        panel = (Path(__file__).parent / "Painel_Mix.bat").read_bytes()
        self.assertGreater(panel.count(b"\n"), 150)
        self.assertNotIn(b"\\n", panel)
        self.assertIn(b"MONITOR AUTOMATICO INVISIVEL", panel)
        self.assertIn(b"DESINSTALAR / DESATIVAR", panel)
        self.assertIn(b"atualizador_mix.ps1", panel)
        self.assertIn(b"--install-monitor", panel)
        self.assertIn(b"--stop-monitor", panel)
        self.assertIn(b"RESULTADO_TAREFA", panel)
        self.assertIn(b"VERSAO_INSTALADA", panel)
        self.assertIn(b"wscript.exe", panel)
        self.assertIn(b"-ArgumentList '%~1'", panel)
        self.assertIn(b"-Wait -PassThru", panel)

    def test_updater_covers_all_installed_components(self):
        root = Path(__file__).parent
        updater = (root / "atualizador_mix.ps1").read_text(encoding="utf-8-sig")
        publisher = (root / "PUBLICAR_ATUALIZACAO.ps1").read_text(encoding="utf-8-sig")
        for name in (
            "desktop-integrador.exe", "Painel_Mix.bat", "monitor_mix.ps1",
            "run_silent.vbs", "atualizador_mix.ps1",
        ):
            self.assertIn(name, updater)
            self.assertIn(name, publisher)
        self.assertIn("$allowedFiles", updater)
        self.assertIn("[System.IO.File]::Replace", updater)
        self.assertIn("schema = 2", publisher)
        self.assertIn("files = $components", publisher)
        self.assertIn("integrador-updates/${name}?v=$Versao", publisher)
        self.assertIn("$manifest['installer']", publisher)
        self.assertIn("Instalador-Mix-Fiscal.exe?v=$Versao", publisher)
        self.assertIn("$remoteVersion -lt $localVersion", updater)
        self.assertIn("Set-IntegratorRunAsAdmin", updater)

    def test_packaged_installer_uses_its_own_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            installer = Path(temp) / "pasta cliente" / "Instalador-Mix-Fiscal.exe"
            with patch.object(sys, "frozen", True, create=True), \
                 patch.object(sys, "executable", str(installer)):
                self.assertEqual(installer_directory(), installer.parent.resolve())

    def test_updated_installer_can_preserve_original_target_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "Mix Fiscal" / "integrador"
            with patch.object(sys, "argv", ["setup.exe", "--install-dir", str(destination)]):
                self.assertEqual(installer_directory(), destination.resolve())

    def test_component_copy_is_atomic_and_hash_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.bin"
            destination = root / "destination.bin"
            source.write_bytes(b"componente mix fiscal")
            expected = sha256_file(source)
            self.assertEqual(_copy_verified(source, destination), expected)
            self.assertEqual(sha256_file(destination), expected)
            self.assertEqual(list(root.glob("*.installing")), [])

    def test_install_directory_permission_probe_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "integrador"
            probe_directory(target)
            self.assertEqual(list(target.glob(".mix-write-*.tmp")), [])
            self.assertEqual(list(target.glob(".mix-write-*.renamed")), [])

    def test_diagnostic_writes_text_and_json_without_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "integrador"
            with patch.dict("os.environ", {"PROGRAMDATA": ""}):
                diagnostics = InstallationDiagnostics(target)
            diagnostics.event("teste", "ok", "Permissão confirmada")
            report = diagnostics.finish("verificado", result="ok")
            data = read_json(report)
            self.assertEqual(data["status"], "verificado")
            self.assertEqual(data["summary"]["result"], "ok")
            self.assertTrue((report.parent / "instalacao.log").is_file())
            content = report.read_text(encoding="utf-8")
            self.assertNotIn("password", content.casefold())
            self.assertNotIn("senha", content.casefold())

    def test_cnpj_check_digits(self):
        self.assertEqual(normalize_cnpj("52.703.958/0001-42"), "52703958000142")
        for value in ("52703958000143", "00000000000000", "123"):
            with self.assertRaises(InstallError):
                normalize_cnpj(value)

    def test_native_generation_formula(self):
        with patch("instalador_core.host_id", return_value="host-guid"), \
             patch("instalador_core.socket.gethostname", return_value="CLIENT-PC"), \
             patch("instalador_core.secrets.token_hex", return_value="ab" * 16):
            expected = hashlib.sha256(("host-guid|CLIENT-PC|" + "ab" * 16).encode()).hexdigest()
            self.assertEqual(generate_machine_id(), expected)

    def test_machine_id_cannot_escape_config_directory(self):
        for value in ("../other", r"C:\other", "a" * 64 + "/file", ""):
            with self.assertRaises(InstallError):
                validate_machine_id(value)
        self.assertEqual(validate_machine_id("a" * 66), "a" * 66)

    def test_verify_registration_never_posts(self):
        api = MixApi()
        current = registration_payload("52703958000142", "a" * 64)
        with patch.object(api, "settings", return_value=current), patch.object(api, "request") as request:
            self.assertEqual(api.verify_registration("52703958000142", "a" * 64), current)
            request.assert_not_called()

    def test_other_client_is_preserved(self):
        api = MixApi()
        current = {"cnpj_cpf": "11111111111111", "metadata": {"tag_service": ["mixfiscal"]}}
        with patch.object(api, "settings", return_value=current), patch.object(api, "request") as request:
            with self.assertRaises(InstallError):
                api.verify_registration("52703958000142", "a" * 64)
            request.assert_not_called()

    def test_client_machines_keeps_distinct_xml_and_robot_ids(self):
        api = MixApi()
        response = {"clients": [
            {"cnpj_cpf": "52.703.958/0001-42", "machine_id": "a" * 64},
            {"cnpj_cpf": "52703958000142", "machine_id": "a" * 64},
            {"cnpj_cpf": "52703958000142", "machine_id": "b" * 64},
            {"cnpj_cpf": "00000000000000", "machine_id": "b" * 64},
        ]}
        with patch.object(api, "request", return_value=response):
            machines = api.client_machines("52703958000142")
        self.assertEqual([item["machine_id"] for item in machines], ["a" * 64, "b" * 64])

    def test_files_are_valid_and_existing_settings_can_be_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config" / "machine_id.json"
            atomic_json(path, {"machine_id": "a" * 64})
            self.assertEqual(read_json(path), {"machine_id": "a" * 64})
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_local_machine_id_is_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "target" / "config" / "machine_id.json"
            app_settings = root / "appdata" / "local_settings.json"
            atomic_json(config, {"machine_id": "a" * 64})
            atomic_json(app_settings, {"machine_id": "a" * 64})
            with patch("automacao_primeiro_acesso.TARGET_DIR", root / "target"), \
                 patch("automacao_primeiro_acesso.APP_SETTINGS", app_settings):
                self.assertEqual(find_local_machine_id(), "a" * 64)

    def test_conflicting_local_ids_are_preserved_and_blocked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "target" / "config" / "machine_id.json"
            app_settings = root / "appdata" / "local_settings.json"
            atomic_json(config, {"machine_id": "a" * 64})
            atomic_json(app_settings, {"machine_id": "b" * 64})
            with patch("automacao_primeiro_acesso.TARGET_DIR", root / "target"), \
                 patch("automacao_primeiro_acesso.APP_SETTINGS", app_settings):
                with self.assertRaises(InstallError):
                    find_local_machine_id()

    def test_monitor_script_and_task_are_installed_and_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "Painel_Mix.bat").write_bytes(
                (Path(__file__).parent / "Painel_Mix.bat").read_bytes()
            )
            completed = SimpleNamespace(returncode=0, stdout="", stderr="")
            with patch("automacao_primeiro_acesso.TARGET_DIR", target), \
                 patch("automacao_primeiro_acesso.subprocess.run", return_value=completed) as run:
                install_monitor(lambda _message: None)
            self.assertTrue((target / "monitor_mix.ps1").is_file())
            monitor = (target / "monitor_mix.ps1").read_text(encoding="utf-8-sig")
            self.assertIn("$PSScriptRoot", monitor)
            self.assertIn("atualizador_mix.ps1", monitor)
            self.assertIn("*integrador*.exe", monitor)
            self.assertIn("-Filter '*.exe'", monitor)
            self.assertNotIn(r"C:\mix fiscal\integracao", monitor)
            self.assertEqual(run.call_count, 2)
            self.assertIn("cmd.exe", run.call_args_list[0].args[0])
            self.assertIn("--install-monitor", run.call_args_list[0].args[0])
            self.assertEqual(
                run.call_args_list[0].kwargs["creationflags"],
                __import__("subprocess").CREATE_NO_WINDOW,
            )
            self.assertIn("/Query", run.call_args_list[1].args[0])

    def test_client_machine_selects_exact_cnpj_and_id(self):
        api = MixApi()
        response = {"clients": [
            {"cnpj_cpf": "52.703.958/0001-42", "machine_id": "a" * 64,
             "status": "online"},
            {"cnpj_cpf": "52.703.958/0001-42", "machine_id": "b" * 64,
             "status": "offline"},
        ]}
        with patch.object(api, "request", return_value=response):
            item = api.client_machine("52703958000142", "a" * 64)
        self.assertEqual(item["status"], "online")

    def test_wait_online_does_not_accept_only_active_flag(self):
        api = MixApi()
        offline = {"status": "offline", "active": True}
        online = {"status": "connected", "active": True}
        with patch.object(api, "client_machine", side_effect=[offline, online]), \
             patch("instalador_core.time.sleep"):
            self.assertEqual(
                api.wait_until_online("52703958000142", "a" * 64, timeout=1), online
            )


if __name__ == "__main__":
    unittest.main()
