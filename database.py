"""Camada centralizada de acesso ao banco de dados da aplicação.

Enquanto ``DATABASE_ENGINE`` for ``sqlite``, a aplicação usa o arquivo local.
Na migração para PostgreSQL, mantenha a interface desta classe e altere somente
``_connect`` para retornar a conexão do novo driver. Nenhuma tela deve abrir
conexões diretamente.
"""

import json
import sqlite3
import os
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import DictCursor
except ImportError:
    psycopg2 = None
    DictCursor = None


DATABASE_ENGINE = "postgresql"
APP_DIR = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
CONFIG_FILE = APP_DIR / "config_mix.json"


class DatabaseService:
    """Fornece conexão e operações de persistência de templates."""

    def _connect(self):
        """Estabelece a conexão com o banco de dados configurado."""
        if DATABASE_ENGINE == "postgresql":
            if not psycopg2:
                raise ImportError(
                    "A biblioteca 'psycopg2-binary' não está instalada. Execute: pip install psycopg2-binary"
                )

            config = {}
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f).get("database", {})

            return psycopg2.connect(
                host=config.get("host", "localhost"),
                port=config.get("port", "5432"),
                dbname=config.get("name"),
                user=config.get("user"),
                password=config.get("password"),
                cursor_factory=DictCursor,
            )
        raise RuntimeError(f"Banco de dados não suportado: {DATABASE_ENGINE}")

    def test_connection(self):
        """Abre, valida e fecha a conexão configurada atualmente."""
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()

    def initialize_templates(self, templates_file):
        """Cria o esquema inicial caso as tabelas ainda não existam."""
        if DATABASE_ENGINE != "postgresql":
            SQLITE_DATABASE_FILE = Path(__file__).with_name("templates_retaguarda.db")
            with sqlite3.connect(SQLITE_DATABASE_FILE) as connection:
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS templates (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
                        criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS template_secoes (
                        template_id INTEGER NOT NULL,
                        chave TEXT NOT NULL,
                        dados_json TEXT NOT NULL,
                        PRIMARY KEY (template_id, chave),
                        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
                    );
                """)
            return

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS templates (
                        id SERIAL PRIMARY KEY,
                        nome VARCHAR(100) NOT NULL UNIQUE,
                        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS template_secoes (
                        template_id INTEGER NOT NULL,
                        chave VARCHAR(50) NOT NULL,
                        dados_json JSONB NOT NULL,
                        PRIMARY KEY (template_id, chave),
                        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
                    );
                """)
                connection.commit()

    def load_templates(self):
        """Carrega todos os templates do banco mapeando formatos novos e antigos."""
        templates = {}
        chaves_antigas_tabelas = {'pis_cofins', 'icms_saida', 'icms_entrada', 'ibs_cbs'}

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    SELECT
                        t.nome,
                        ts.chave,
                        ts.dados_json
                    FROM templates t
                    LEFT JOIN template_secoes ts ON t.id = ts.template_id
                    ORDER BY t.nome, ts.chave;
                """)
                rows = cursor.fetchall()

                for row in rows:
                    nome_template = row['nome']
                    chave_secao = row['chave']
                    dados_secao = row['dados_json']

                    if nome_template not in templates:
                        templates[nome_template] = {"tabelas": {}, "comparar_divergencia": {}}

                    if chave_secao and dados_secao is not None:
                        if isinstance(dados_secao, str):
                            dados_secao = json.loads(dados_secao)

                        if chave_secao in chaves_antigas_tabelas:
                            # Formato antigo: agrupa dentro do dicionário 'tabelas'
                            templates[nome_template]["tabelas"][chave_secao] = dados_secao
                        elif chave_secao in ["tabelas", "comparar_divergencia"]:
                            # Formato novo: atribui diretamente o objeto completo
                            templates[nome_template][chave_secao] = dados_secao
                        else:
                            templates[nome_template][chave_secao] = dados_secao

        return templates

    def load_template_by_id(self, template_id):
        """Carrega um template específico pelo seu ID."""
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT nome FROM templates WHERE id = %s", (template_id,))
                row = cursor.fetchone()
                if not row:
                    return None
                # Reutiliza a função de carregamento principal
                all_templates = self.load_templates()
                return all_templates.get(row['nome'])

    def buscar_e_marcar_job_fila(self):
        """Busca o job mais antigo pendente e o atualiza para 'processando'."""
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    UPDATE public.fila_execucao SET status = 'processando', processado_em = NOW(), tentativas = tentativas + 1
                    WHERE id = (SELECT id FROM public.fila_execucao WHERE status = 'pendente' ORDER BY criado_em ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
                    RETURNING id, cnpj, template_id;
                """)
                return cursor.fetchone()

    def recuperar_jobs_presos(self):
        """Recoloca na fila jobs em processamento há mais de 30 minutos."""
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    UPDATE public.fila_execucao
                    SET status = 'pendente'
                    WHERE status = 'processando'
                      AND processado_em < NOW() - INTERVAL '30 minutes';
                """)
                recuperados = cursor.rowcount
                connection.commit()
                return recuperados

    def save_template(self, name, data):
        """Salva ou atualiza as seções de um template via UPSERT sem apagar dados por engano."""
        if not data or not isinstance(data, dict):
            return

        with self._connect() as connection:
            with connection.cursor() as cursor:
                # 1. Garante a existência do template pai
                cursor.execute(
                    """
                    INSERT INTO templates (nome) VALUES (%s)
                    ON CONFLICT(nome) DO UPDATE SET atualizado_em = NOW()
                    RETURNING id
                    """,
                    (name,),
                )
                template_id = cursor.fetchone()['id']

                # 2. Atualiza ou insere cada seção sem deletar as demais
                for secao_chave, dados_secao in data.items():
                    if dados_secao is None:
                        continue

                    if isinstance(dados_secao, (dict, list)):
                        json_str = json.dumps(dados_secao, ensure_ascii=False)
                    else:
                        json_str = str(dados_secao)

                    cursor.execute(
                        """
                        INSERT INTO template_secoes (template_id, chave, dados_json)
                        VALUES (%s, %s, %s::jsonb)
                        ON CONFLICT (template_id, chave) 
                        DO UPDATE SET dados_json = EXCLUDED.dados_json;
                        """,
                        (template_id, secao_chave, json_str),
                    )

                connection.commit()

    def atualizar_status_job(self, job_id, status, mensagem_erro=None):
        """Atualiza o status final de um job na fila."""
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE public.fila_execucao SET status = %s, mensagem_erro = %s, processado_em = NOW() WHERE id = %s",
                    (status, mensagem_erro, job_id)
                )
                connection.commit()

    def delete_template(self, name):
        """Exclui um template e todas as suas seções associadas em cascata."""
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM templates WHERE nome = %s", (name,))
                connection.commit()
