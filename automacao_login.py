import sys
import asyncio
import threading
from PyQt6.QtCore import QThread, pyqtSignal

from automacao_api import MixFiscalAPIAutomation

# Siglas válidas de UF (sempre em minúsculo para comparação e para o preenchimento na web)
UF_VALIDAS = {
    "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg",
    "pa", "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to"
}

# O portal pode exibir a UF como sigla ("SP") ou por extenso ("São Paulo").
ESTADOS_POR_NOME = {
    "acre": "ac", "alagoas": "al", "amapa": "ap", "amazonas": "am",
    "bahia": "ba", "ceara": "ce", "distrito federal": "df",
    "espirito santo": "es", "goias": "go", "maranhao": "ma",
    "mato grosso": "mt", "mato grosso do sul": "ms", "minas gerais": "mg",
    "para": "pa", "paraiba": "pb", "parana": "pr", "pernambuco": "pe",
    "piaui": "pi", "rio de janeiro": "rj", "rio grande do norte": "rn",
    "rio grande do sul": "rs", "rondonia": "ro", "roraima": "rr",
    "santa catarina": "sc", "sao paulo": "sp", "sergipe": "se", "tocantins": "to",
}

class AutomacaoWorker(QThread):
    log_signal = pyqtSignal(str)
    progress_signal = pyqtSignal(int, int)
    cliente_concluido_signal = pyqtSignal(str)
    download_necessario_signal = pyqtSignal()
    download_concluido_signal = pyqtSignal()
    download_progress_signal = pyqtSignal(int)
    finished_signal = pyqtSignal()

    def __init__(self, *args):
        super().__init__()
        self._pause_event = threading.Event()
        self._pause_event.set()
        self.total_steps = 0
        self.current_step = 0
        self.delay_multiplier = 1.0
        self.automation = None
        # Compatibilidade: aceita tanto (config_dict, clientes, template)
        # quanto (user, password, clientes, template)
        if len(args) == 3 and isinstance(args[0], dict):
            self.config = args[0]
            self.clientes = args[1]
            self.template_dados = args[2]
        else:
            # Espera (user, password, clientes, template_dados)
            user = args[0] if len(args) > 0 else ""
            password = args[1] if len(args) > 1 else ""
            clientes = args[2] if len(args) > 2 else []
            template_dados = args[3] if len(args) > 3 else {}
            self.config = {"user": user, "pass": password}
            self.clientes = clientes
            self.template_dados = template_dados
        self.delay_multiplier = float(self.config.get("delay_multiplier", 1.0))

    def run(self):
        if sys.platform == 'win32':
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self.executar_automacao_lote())
        except Exception as e:
            self.log(f"❌ Erro crítico no loop async: {str(e)}")
            self.finished_signal.emit()
        finally:
            try:
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.close()
            except Exception:
                pass

    async def _wait_if_paused(self):
        if self.automation is not None:
            self.automation.delay_multiplier = self.delay_multiplier
        while not self._pause_event.is_set():
            await asyncio.sleep(0.2)

    def pause(self):
        self._pause_event.clear()

    def resume(self):
        self._pause_event.set()

    async def executar_automacao_lote(self):
        automation = MixFiscalAPIAutomation(
            self.config, log_callback=self.log_signal.emit
        )
        self.automation = automation
        self._pause_event.set()
        self.total_steps = max(1, len(self.clientes) * 8)
        self.current_step = 0
        self.progress_signal.emit(0, self.total_steps)

        try:
            await automation.setup()
            await automation.login()

            total_clientes = len(self.clientes)
            for idx, cliente in enumerate(self.clientes, start=1):
                if self.isInterruptionRequested():
                    self.log_signal.emit("⏹️ Automação interrompida pelo usuário.")
                    break

                cnpj = cliente.get("cnpj", "").strip()
                if not cnpj:
                    self.log_signal.emit(f"⚠️ Cliente na posição {idx} está sem CNPJ. Pulando.")
                    self.current_step += 8
                    self.progress_signal.emit(self.current_step, self.total_steps)
                    continue

                self.log_signal.emit(f"\n==========================================")
                self.log_signal.emit(f"🏢 [{idx}/{total_clientes}] Processando CNPJ: {cnpj}")
                self.log_signal.emit(f"==========================================")

                offset = (idx - 1) * 8
                def emitir_progresso_tabela(passo, total_local=8):
                    self.current_step = offset + passo
                    self.progress_signal.emit(self.current_step, self.total_steps)

                sucesso = await automation.processar_cliente(cnpj, self.template_dados, emitir_progresso_tabela, self._wait_if_paused)

                if sucesso:
                    self.cliente_concluido_signal.emit(cnpj)
                else:
                    # Se falhou, garante que o progresso avance para o próximo cliente
                    self.current_step = min(self.total_steps, offset + 8)
                    self.progress_signal.emit(self.current_step, self.total_steps)

        except Exception as e:
            self.log_signal.emit(f"❌ Erro fatal na automação: {e}")
        finally:
            # Sempre fecha o contexto para liberar o perfil persistente antes
            # que a interface permita iniciar outra automacao.
            await automation.teardown()
            
            self.finished_signal.emit()
            self.automation = None
