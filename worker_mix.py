import asyncio
import json
import logging
import sys
from pathlib import Path

from database import DatabaseService
from automacao_api import MixFiscalAPIAutomation


PASTA_APLICACAO = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
CONFIG_FILE = PASTA_APLICACAO / "config_mix.json"
LOG_FILE = PASTA_APLICACAO / "worker_mix.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - [%(levelname)s] - %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)


async def processar_fila():
    """Consome continuamente os jobs pendentes da fila do PostgreSQL."""
    db = DatabaseService()

    try:
        recuperados = db.recuperar_jobs_presos()
        if recuperados:
            logging.warning("♻️ %s job(s) preso(s) retornaram para a fila.", recuperados)
    except Exception as erro:
        logging.warning("Não foi possível verificar jobs presos: %s", erro)

    while True:
        try:
            job = db.buscar_e_marcar_job_fila()

            if not job:
                await asyncio.sleep(5)
                continue

            job_id = job["id"]
            cnpj = job["cnpj"]
            template_id = job["template_id"]
            logging.info(
                "🚀 Iniciando Job ID %s | CNPJ: %s | Template ID: %s",
                job_id,
                cnpj,
                template_id,
            )

            automation = None
            try:
                with CONFIG_FILE.open("r", encoding="utf-8") as arquivo:
                    config = json.load(arquivo)

                logging.info("🌐 Executor do worker: API Mix Fiscal")

                template_dados = db.load_template_by_id(template_id)
                if not template_dados:
                    raise ValueError(f"Template ID {template_id} não encontrado no banco.")

                automation = MixFiscalAPIAutomation(
                    config, log_callback=logging.info
                )
                await automation.setup()
                await automation.login()

                sucesso = await automation.processar_cliente(cnpj, template_dados)
                if not sucesso:
                    raise RuntimeError("Falha no preenchimento do cliente.")

                db.atualizar_status_job(job_id, "concluido")
                logging.info("✅ Job ID %s (CNPJ %s) CONCLUÍDO!", job_id, cnpj)

            except Exception as erro_job:
                msg_erro = str(erro_job)[:5000]
                logging.exception("❌ Erro no Job ID %s: %s", job_id, msg_erro)
                try:
                    db.atualizar_status_job(job_id, "erro", msg_erro)
                except Exception:
                    # Mantém o worker vivo mesmo se o banco cair ao registrar o erro.
                    logging.exception("Não foi possível marcar o Job ID %s como erro.", job_id)
            finally:
                if automation is not None:
                    try:
                        await automation.teardown()
                    except Exception:
                        logging.exception("Falha ao encerrar o navegador do Job ID %s.", job_id)

        except asyncio.CancelledError:
            raise
        except Exception as erro_loop:
            logging.exception("⚠️ Erro crítico no loop principal do worker: %s", erro_loop)
            await asyncio.sleep(10)


async def main():
    logging.info("==================================================")
    logging.info("🤖 Worker App Mix iniciado 24/7 (Executor via API)")
    logging.info("🏢 Suporte à variável {nome_empresa}: ativo")
    logging.info("==================================================")

    await processar_fila()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Worker parado pelo usuário.")
