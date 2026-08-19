"""API HTTP para integrar sistemas externos com a fila do APP-MIX."""

import hashlib
import json
import re
import secrets
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field, field_validator

from database import DatabaseService


APP_DIR = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
API_CONFIG_FILE = APP_DIR / "config_api.json"
STATUS_VALIDOS = {"pendente", "processando", "concluido", "erro", "cancelado"}


def _somente_digitos(valor):
    return re.sub(r"\D", "", str(valor or ""))


def _cnpj_valido(cnpj):
    cnpj = _somente_digitos(cnpj)
    if len(cnpj) != 14 or cnpj == cnpj[0] * 14:
        return False
    for tamanho, pesos in (
        (12, (5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)),
        (13, (6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)),
    ):
        soma = sum(int(cnpj[i]) * pesos[i] for i in range(tamanho))
        digito = 11 - soma % 11
        digito = 0 if digito >= 10 else digito
        if int(cnpj[tamanho]) != digito:
            return False
    return True


def carregar_config_api():
    if API_CONFIG_FILE.exists():
        dados = json.loads(API_CONFIG_FILE.read_text(encoding="utf-8"))
    else:
        dados = {
            "api_key": secrets.token_urlsafe(32),
            "host": "0.0.0.0",
            "port": 8080,
            "cors_origins": [],
        }
        API_CONFIG_FILE.write_text(
            json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Chave da API criada em: {API_CONFIG_FILE}")
    chave = str(dados.get("api_key") or "").strip()
    if len(chave) < 24:
        raise RuntimeError("config_api.json precisa de api_key com pelo menos 24 caracteres")
    return dados


def inicializar_tabelas_api():
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS public.api_lotes (
                    id UUID PRIMARY KEY,
                    template_id INTEGER NOT NULL REFERENCES public.templates(id),
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    origem VARCHAR(120),
                    solicitado_por VARCHAR(120)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS public.api_lote_jobs (
                    lote_id UUID NOT NULL REFERENCES public.api_lotes(id) ON DELETE CASCADE,
                    job_id INTEGER NOT NULL REFERENCES public.fila_execucao(id),
                    PRIMARY KEY (lote_id, job_id)
                )
            """)
            connection.commit()


class CriarLote(BaseModel):
    cnpjs: list[str] = Field(min_length=1, max_length=1000)
    template_id: int | None = Field(default=None, gt=0)
    template_nome: str | None = Field(default=None, min_length=1, max_length=100)
    origem: str | None = Field(default=None, max_length=120)
    solicitado_por: str | None = Field(default=None, max_length=120)
    permitir_duplicados: bool = False

    @field_validator("cnpjs")
    @classmethod
    def validar_cnpjs(cls, valores):
        normalizados = []
        vistos = set()
        for valor in valores:
            cnpj = _somente_digitos(valor)
            if not _cnpj_valido(cnpj):
                raise ValueError(f"CNPJ inválido: {valor}")
            if cnpj not in vistos:
                vistos.add(cnpj)
                normalizados.append(cnpj)
        return normalizados

    def model_post_init(self, __context):
        if (self.template_id is None) == (self.template_nome is None):
            raise ValueError("Informe exatamente um: template_id ou template_nome")


class Cancelamento(BaseModel):
    motivo: str | None = Field(default=None, max_length=500)


CONFIG_API = carregar_config_api()
API_KEY_HEADER = APIKeyHeader(name="X-API-Key", auto_error=False)


async def autenticar(x_api_key: str | None = Depends(API_KEY_HEADER)):
    esperada = str(CONFIG_API["api_key"])
    if not x_api_key or not secrets.compare_digest(x_api_key, esperada):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Chave da API inválida")


@asynccontextmanager
async def lifespan(app):
    inicializar_tabelas_api()
    yield


app = FastAPI(
    title="APP-MIX API",
    version="1.0.0",
    description="Controle autenticado da fila de processamento Mix Fiscal.",
    lifespan=lifespan,
)

origens = CONFIG_API.get("cors_origins") or []
if origens:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origens,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["X-API-Key", "Content-Type"],
    )


@app.get("/health", tags=["Sistema"])
def health():
    try:
        with DatabaseService()._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        return {"status": "ok", "database": "ok", "version": app.version}
    except Exception:
        raise HTTPException(status_code=503, detail="Banco de dados indisponível")


@app.get("/v1/templates", dependencies=[Depends(autenticar)], tags=["Templates"])
def listar_templates():
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT id, nome, criado_em, atualizado_em
                FROM public.templates ORDER BY nome
            """)
            return {"items": [dict(row) for row in cursor.fetchall()]}


def _resolver_template(cursor, pedido):
    if pedido.template_id is not None:
        cursor.execute(
            "SELECT id, nome FROM public.templates WHERE id = %s",
            (pedido.template_id,),
        )
    else:
        cursor.execute(
            "SELECT id, nome FROM public.templates WHERE LOWER(nome) = LOWER(%s)",
            (pedido.template_nome.strip(),),
        )
    template = cursor.fetchone()
    if not template:
        raise HTTPException(status_code=404, detail="Template não encontrado")
    return template


@app.post("/v1/lotes", status_code=201, dependencies=[Depends(autenticar)], tags=["Lotes"])
def criar_lote(pedido: CriarLote):
    lote_id = uuid.uuid4()
    jobs = []
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            template = _resolver_template(cursor, pedido)
            cursor.execute("""
                INSERT INTO public.api_lotes
                    (id, template_id, origem, solicitado_por)
                VALUES (%s, %s, %s, %s)
            """, (str(lote_id), template["id"], pedido.origem, pedido.solicitado_por))

            for cnpj in pedido.cnpjs:
                job = None
                reutilizado = False
                if not pedido.permitir_duplicados:
                    cursor.execute("""
                        SELECT id, status FROM public.fila_execucao
                        WHERE cnpj = %s AND template_id = %s
                          AND status IN ('pendente', 'processando')
                        ORDER BY id DESC LIMIT 1
                    """, (cnpj, template["id"]))
                    job = cursor.fetchone()
                    reutilizado = job is not None
                if job is None:
                    cursor.execute("""
                        INSERT INTO public.fila_execucao (cnpj, template_id)
                        VALUES (%s, %s) RETURNING id, status
                    """, (cnpj, template["id"]))
                    job = cursor.fetchone()
                cursor.execute("""
                    INSERT INTO public.api_lote_jobs (lote_id, job_id)
                    VALUES (%s, %s) ON CONFLICT DO NOTHING
                """, (str(lote_id), job["id"]))
                jobs.append({
                    "id": job["id"], "cnpj": cnpj,
                    "status": job["status"], "reutilizado": reutilizado,
                })
            connection.commit()
    return {
        "lote_id": str(lote_id),
        "template": dict(template),
        "quantidade": len(jobs),
        "jobs": jobs,
    }


def _buscar_lote(lote_id):
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT l.id, l.criado_em, l.origem, l.solicitado_por,
                       t.id AS template_id, t.nome AS template_nome
                FROM public.api_lotes l
                JOIN public.templates t ON t.id = l.template_id
                WHERE l.id = %s
            """, (str(lote_id),))
            lote = cursor.fetchone()
            if not lote:
                raise HTTPException(status_code=404, detail="Lote não encontrado")
            cursor.execute("""
                SELECT f.id, f.cnpj, f.status, f.tentativas,
                       f.mensagem_erro, f.criado_em, f.processado_em
                FROM public.api_lote_jobs lj
                JOIN public.fila_execucao f ON f.id = lj.job_id
                WHERE lj.lote_id = %s ORDER BY f.id
            """, (str(lote_id),))
            jobs = [dict(row) for row in cursor.fetchall()]
    totais = {chave: 0 for chave in STATUS_VALIDOS}
    for job in jobs:
        totais[job["status"]] = totais.get(job["status"], 0) + 1
    finalizados = totais.get("concluido", 0) + totais.get("erro", 0) + totais.get("cancelado", 0)
    return {
        **dict(lote), "quantidade": len(jobs), "finalizados": finalizados,
        "percentual": round(finalizados * 100 / len(jobs), 2) if jobs else 0,
        "totais": totais, "jobs": jobs,
    }


@app.get("/v1/lotes/{lote_id}", dependencies=[Depends(autenticar)], tags=["Lotes"])
def consultar_lote(lote_id: uuid.UUID):
    return _buscar_lote(lote_id)


@app.post("/v1/lotes/{lote_id}/cancelar", dependencies=[Depends(autenticar)], tags=["Lotes"])
def cancelar_lote(lote_id: uuid.UUID, pedido: Cancelamento | None = None):
    mensagem = "Cancelado pela API"
    if pedido and pedido.motivo:
        mensagem += ": " + pedido.motivo
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM public.api_lotes WHERE id = %s", (str(lote_id),))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Lote não encontrado")
            cursor.execute("""
                UPDATE public.fila_execucao f
                SET status = 'cancelado', mensagem_erro = %s, processado_em = NOW()
                FROM public.api_lote_jobs lj
                WHERE lj.lote_id = %s AND lj.job_id = f.id
                  AND f.status = 'pendente'
            """, (mensagem, str(lote_id)))
            cancelados = cursor.rowcount
            connection.commit()
    return {"lote_id": str(lote_id), "cancelados": cancelados}


@app.get("/v1/jobs", dependencies=[Depends(autenticar)], tags=["Jobs"])
def listar_jobs(
    status_job: Literal["pendente", "processando", "concluido", "erro", "cancelado"] | None = Query(default=None, alias="status"),
    cnpj: str | None = None,
    limite: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    filtros, parametros = [], []
    if status_job:
        filtros.append("f.status = %s")
        parametros.append(status_job)
    if cnpj:
        cnpj_normalizado = _somente_digitos(cnpj)
        if len(cnpj_normalizado) != 14:
            raise HTTPException(status_code=422, detail="CNPJ deve possuir 14 dígitos")
        filtros.append("f.cnpj = %s")
        parametros.append(cnpj_normalizado)
    where = "WHERE " + " AND ".join(filtros) if filtros else ""
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(f"""
                SELECT f.id, f.cnpj, f.status, f.tentativas, f.mensagem_erro,
                       f.criado_em, f.processado_em,
                       t.id AS template_id, t.nome AS template_nome
                FROM public.fila_execucao f
                JOIN public.templates t ON t.id = f.template_id
                {where} ORDER BY f.id DESC LIMIT %s OFFSET %s
            """, (*parametros, limite, offset))
            return {"items": [dict(row) for row in cursor.fetchall()], "limite": limite, "offset": offset}


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(autenticar)], tags=["Jobs"])
def consultar_job(job_id: int):
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT f.id, f.cnpj, f.status, f.tentativas, f.mensagem_erro,
                       f.criado_em, f.processado_em,
                       t.id AS template_id, t.nome AS template_nome
                FROM public.fila_execucao f
                JOIN public.templates t ON t.id = f.template_id
                WHERE f.id = %s
            """, (job_id,))
            job = cursor.fetchone()
    if not job:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    return dict(job)


@app.post("/v1/jobs/{job_id}/cancelar", dependencies=[Depends(autenticar)], tags=["Jobs"])
def cancelar_job(job_id: int, pedido: Cancelamento | None = None):
    mensagem = "Cancelado pela API"
    if pedido and pedido.motivo:
        mensagem += ": " + pedido.motivo
    with DatabaseService()._connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                UPDATE public.fila_execucao
                SET status = 'cancelado', mensagem_erro = %s, processado_em = NOW()
                WHERE id = %s AND status = 'pendente'
                RETURNING id
            """, (mensagem, job_id))
            cancelado = cursor.fetchone()
            if not cancelado:
                cursor.execute("SELECT status FROM public.fila_execucao WHERE id = %s", (job_id,))
                atual = cursor.fetchone()
                if not atual:
                    raise HTTPException(status_code=404, detail="Job não encontrado")
                raise HTTPException(status_code=409, detail=f"Job não pode ser cancelado no status {atual['status']}")
            connection.commit()
    return {"job_id": job_id, "status": "cancelado"}


@app.get("/v1/info", dependencies=[Depends(autenticar)], tags=["Sistema"])
def info():
    return {
        "nome": app.title,
        "versao": app.version,
        "autenticacao": "X-API-Key",
        "documentacao": "/docs",
        "api_key_fingerprint": hashlib.sha256(CONFIG_API["api_key"].encode()).hexdigest()[:12],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=str(CONFIG_API.get("host", "0.0.0.0")),
        port=int(CONFIG_API.get("port", 8080)),
        log_level="info",
    )
