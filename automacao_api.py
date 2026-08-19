"""Executor da automacao Mix Fiscal usando as APIs consumidas pelo portal."""

import asyncio
import copy
import re
import unicodedata

import requests


API_AUTH = "https://dev.authentication.mixfiscal.com.br/v1/login"
API_CLIENTE = "https://api.mixfiscal.com.br/cmf/v1/panel/costumer"

TABELAS = {
    "pis_cofins": {
        "nome": "PIS E COFINS",
        "view_nome": "cli_vw_piscofins",
        "view_sql": "cli_select_piscofins",
        "tmp_nome": "cli_piscofins_tmp",
        "tmp_delete": "cli_piscofins_delete",
        "tmp_insert": "cli_piscofins_insert",
        "tmp_values": "cli_piscofins_insert_values",
        "tmp_selectwhere": "cli_piscofins_where_gravar",
        "flag1": "cli_piscofins_zerar_tmp",
        "flag2": "cli_piscofins_gravar_aprovados",
        "flag3": "cli_piscofins_gravar_todoscla",
    },
    "icms_saida": {
        "nome": "ICMS SAIDA",
        "view_nome": "cli_vw_icms_s",
        "view_sql": "cli_select_icms_s",
        "tmp_nome": "cli_icms_s_tmp",
        "tmp_delete": "cli_icms_s_delete",
        "tmp_insert": "cli_icms_s_insert",
        "tmp_values": "cli_icms_s_insert_values",
        "tmp_selectwhere": "cli_icms_s_where_gravar",
        "flag1": "cli_icms_s_zerar_tmp",
        "flag2": "cli_icms_s_gravar_aprovados",
        "flag3": "cli_icms_s_gravar_todos_cla",
    },
    "icms_entrada": {
        "nome": "ICMS ENTRADA",
        "view_nome": "cli_vw_icms_e",
        "view_sql": "cli_select_icms_e",
        "tmp_nome": "cli_icms_e_tmp",
        "tmp_delete": "cli_icms_e_delete",
        "tmp_insert": "cli_icms_e_insert",
        "tmp_values": "cli_icms_e_insert_values",
        "tmp_selectwhere": "cli_icms_e_where_gravar",
        "flag1": "cli_icms_e_zerar_tmp",
        "flag2": "cli_icms_e_gravar_aprovados",
        "flag3": "cli_icms_e_gravar_todos_cla",
    },
    "ibs_cbs": {
        "nome": "IBS E CBS",
        "view_nome": "cli_vw_ibs_cbs",
        "view_sql": "cli_select_ibs_cbs",
        "tmp_nome": "ibs_cbs_tmp",
        "tmp_delete": "ibs_cbs_delete",
        "tmp_insert": "ibs_cbs_insert",
        "tmp_values": "ibs_cbs_insert_values",
        "tmp_selectwhere": "ibs_cbs_where_gravar",
        "flag1": "ibs_cbs_zerar_tmp",
        "flag2": "ibs_cbs_gravar_aprovados",
        "flag3": "ibs_cbs_gravar_todos_cla",
    },
}

TMP_SQL_CAMPOS = (
    ("tmp_insert", "Insert"),
    ("tmp_values", "Values"),
    ("tmp_delete", "Delete"),
    ("tmp_selectwhere", "Where"),
)

REGIMES = {
    "LR": "lucro_real",
    "LUCRO REAL": "lucro_real",
    "LP": "lucro_presumido",
    "LUCRO PRESUMIDO": "lucro_presumido",
    "SN": "simples_nacional",
    "SIMPLES NACIONAL": "simples_nacional",
}

PIS_COFINS = {
    "ncm": "cdiv_ncm", "ncmex": "cdiv_ncm_ex",
    "cod_natureza_receita": "cdiv_cod_nat_rec",
    "credito_presumido": "cdiv_credito_presumido",
    "pis_cst_e": "cdiv_pis_cst_e", "pis_cst_s": "cdiv_pis_cst_s",
    "pis_alq_e": "cdiv_pis_alq_e", "pis_alq_s": "cdiv_pis_alq_s",
    "cofins_cst_e": "cdiv_cofins_cst_e", "cofins_cst_s": "cdiv_cofins_cst_s",
    "cofins_alq_e": "cdiv_cofins_alq_e", "cofins_alq_s": "cdiv_cofins_alq_s",
}

IBS_CBS = {
    "classe_tributaria": "cclass_trib", "ibs_cbs_cst": "ibs_cbs_cst",
    "cbs_alq": "cbs_alq", "cbs_alq_rbc": "cbs_alq_rbc",
    "ibs_uf_alq": "ibs_uf_alq", "ibs_uf_alq_rbc": "ibs_uf_alq_rbc",
    "ibs_mun_alq": "ibs_mun_alq", "ibs_mun_alq_rbc": "ibs_mun_alq_rbc",
    "is_classe_tributaria": "is_cclass_trib", "is_alq": "is_alq",
    "is_alq_especifica": "is_alq_espec",
}

OUTROS_ICMS = {
    "mva": "cdiv_mva", "tipo_mva": "cdiv_tipo_mva",
    "mva_data_ini": "cdiv_mva_data_ini", "mva_data_fim": "cdiv_mva_data_fim",
    "cred_outorgado": "cdiv_credito_outorgado",
    "gera_debito": "cdiv_gera_debito", "sub_rbc_alq": "cdiv_sub_rbc_alq",
}


def _cnpj(valor):
    return re.sub(r"\D", "", str(valor or ""))


def _snake(valor):
    texto = unicodedata.normalize("NFKD", str(valor or "").strip())
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    return re.sub(r"[^a-zA-Z0-9]+", "_", texto).strip("_").lower()


def _bool(valor):
    if isinstance(valor, str):
        return valor.strip().lower() in {"1", "true", "yes", "sim", "on"}
    return bool(valor)


def _aplicar_excecoes(sql_base, codigos):
    sql_original = str(sql_base or "")
    if not sql_original:
        return sql_original
    encontrados = re.findall(
        r"\bcodigo_produto\s+NOT\s+IN\s*\(([^)]*)\)", sql_original,
        flags=re.IGNORECASE | re.DOTALL,
    )
    legados = sorted({int(n) for bloco in encontrados for n in re.findall(r"\d+", bloco)})
    sql = re.sub(r"\s+\b(?:AND|OR)\s+codigo_produto\s+NOT\s+IN\s*\([^)]*\)", "", sql_original, flags=re.IGNORECASE)
    sql = re.sub(r"\s+\bWHERE\s+codigo_produto\s+NOT\s+IN\s*\([^)]*\)", "", sql, flags=re.IGNORECASE)
    finais = legados if codigos is None else sorted(set(legados) | set(codigos))
    if not finais:
        return sql
    sql = re.sub(r";\s*$", "", sql).rstrip()
    operador = "AND" if re.search(r"\bWHERE\b", sql, re.IGNORECASE) else "WHERE"
    return f"{sql}\n{operador} codigo_produto NOT IN ({', '.join(map(str, finais))})"


def _extrair_codigos_not_in(sql):
    """Le somente os codigos NOT IN existentes no SQL deste cliente."""
    blocos = re.findall(
        r"\bcodigo_produto\s+NOT\s+IN\s*\(([^)]*)\)",
        str(sql or ""), flags=re.IGNORECASE | re.DOTALL,
    )
    return sorted({
        int(numero)
        for bloco in blocos
        for numero in re.findall(r"\d+", bloco)
    })


def _tem_trava_1_2(sql):
    return re.search(r"(?<!\d)1\s*=\s*2(?!\d)", str(sql or "")) is not None


def _preservar_trava_1_2(sql_template, sql_atual):
    """Mantem a trava do cliente sem copia-la para outros clientes."""
    novo = str(sql_template or "")
    atual = str(sql_atual or "")
    if not _tem_trava_1_2(atual) or _tem_trava_1_2(novo):
        return novo
    if not novo.strip():
        # Um template vazio nao pode apagar uma VIEW de seguranca existente.
        return atual
    novo = re.sub(r";\s*$", "", novo).rstrip()
    operador = "AND" if re.search(r"\bWHERE\b", novo, re.IGNORECASE) else "WHERE"
    return f"{novo}\n{operador} 1=2"


class MixFiscalAPIAutomation:
    """Mantem o contrato do antigo MixAutomation sem abrir navegador."""

    def __init__(self, config, log_callback=print):
        self.config = config
        self.log = log_callback
        self.session = requests.Session()
        self.headers = {"Content-Type": "application/json"}
        self.delay_multiplier = float(config.get("delay_multiplier", 1.0))

    async def setup(self):
        self.log("🚀 Inicializando automação via API (sem navegador)...")

    async def teardown(self):
        self.session.close()
        self.log("✅ Sessão da API encerrada.")

    async def login(self):
        payload = {
            "email": self.config.get("user", ""),
            "password": self.config.get("pass", ""),
            "browser_id": "appmix-api",
        }
        resposta = await self._request(
            "post", API_AUTH, json=payload, timeout=30, etapa="login"
        )
        self._validar(resposta, "login")
        dados = resposta.json()
        token = dados.get("token") or dados.get("access_token")
        if not token:
            raise RuntimeError("Login não retornou token de acesso")
        self.headers["Authorization"] = "Bearer " + token.removeprefix("Bearer ")
        self.log("✅ Login via API realizado com sucesso.")

    def _validar(self, resposta, etapa):
        if resposta.status_code not in range(200, 300):
            detalhe = ""
            try:
                corpo = resposta.json()
                detalhe = corpo.get("message") or corpo.get("error") or ""
            except Exception:
                detalhe = resposta.text[:300]
            raise RuntimeError(f"API recusou {etapa}: HTTP {resposta.status_code} {detalhe}".strip())

    async def _request(self, metodo, url, etapa, **kwargs):
        ultimo_erro = None
        for tentativa in range(1, 4):
            try:
                resposta = await asyncio.to_thread(
                    getattr(self.session, metodo), url, **kwargs
                )
                if resposta.status_code not in {502, 503, 504}:
                    return resposta
                ultimo_erro = RuntimeError(
                    f"HTTP {resposta.status_code} em {etapa}"
                )
            except requests.RequestException as erro:
                ultimo_erro = erro
            if tentativa < 3:
                self.log(
                    f"⚠️ API indisponível em {etapa}; nova tentativa "
                    f"{tentativa + 1}/3..."
                )
                await asyncio.sleep(tentativa)
        raise RuntimeError(f"API indisponível em {etapa} após 3 tentativas: {ultimo_erro}")

    async def _buscar_cliente(self, cnpj):
        resposta = await self._request(
            "get", API_CLIENTE, etapa=f"consulta do CNPJ {cnpj}",
            params={"cli_cnpj": cnpj}, headers=self.headers, timeout=30,
        )
        self._validar(resposta, f"consulta do CNPJ {cnpj}")
        dados = resposta.json().get("data")
        if not isinstance(dados, dict):
            raise RuntimeError(f"CNPJ {cnpj} não retornou cadastro CMF")
        vinculo = dados.get("clientes_mxf_cmf") or {}
        retornado = _cnpj(vinculo.get("cli_cnpj"))
        if retornado != cnpj:
            raise RuntimeError(
                f"Validação de segurança falhou: solicitado {cnpj}, API retornou {retornado or 'sem CNPJ'}"
            )
        cmf_id = dados.get("cmf_cli_id") or vinculo.get("cmf_cli_id")
        if not cmf_id:
            raise RuntimeError(f"CNPJ {cnpj} não possui cmf_id")
        return dados, int(cmf_id)

    async def _patch(self, cmf_id, payload, etapa):
        url = f"{API_CLIENTE}/{cmf_id}"
        resposta = await self._request(
            "patch", url, etapa=etapa,
            headers=self.headers, json=payload, timeout=60,
        )
        self._validar(resposta, etapa)

    def _dados_cliente(self, dados):
        vinculo = dados.get("clientes_mxf_cmf") or {}
        uf = str(dados.get("uf") or "").strip().lower()
        bruto = str(dados.get("cli_tributacao") or "").strip().upper()
        regime = REGIMES.get(bruto, _snake(bruto))
        nome = _snake(vinculo.get("cli_nome") or dados.get("cmf_cli_nome"))
        if len(uf) != 2:
            raise RuntimeError("UF do cliente não foi retornada pela API")
        if not regime:
            raise RuntimeError("Regime tributário do cliente não foi retornado pela API")
        if not nome:
            raise RuntimeError("Nome do cliente não foi retornado pela API")
        return uf, regime, nome

    def _substituir(self, template, cnpj, uf, regime, nome):
        trocas = {
            "{cnpj}": cnpj, "{estado}": uf,
            "{regime_tributario}": regime, "{lucro_real}": regime,
            "{nome_empresa}": nome,
        }
        def aplicar(valor):
            if isinstance(valor, str):
                for chave, novo in trocas.items():
                    valor = valor.replace(chave, novo)
                return valor
            if isinstance(valor, dict):
                return {k: aplicar(v) for k, v in valor.items()}
            if isinstance(valor, list):
                return [aplicar(v) for v in valor]
            return valor
        return aplicar(copy.deepcopy(template))

    def _payload_divergencias(self, config, dados_atuais=None):
        # O formulario do portal envia todos os campos cdiv_ de uma vez. Os
        # quatro CBENEF sem correspondencia no template sao preservados.
        payload = {
            chave: valor for chave, valor in (dados_atuais or {}).items()
            if chave.startswith("cdiv_")
        }
        for chave, valor in (config.get("pis_cofins") or {}).items():
            if chave in PIS_COFINS:
                payload[PIS_COFINS[chave]] = _bool(valor)

        for secao, sufixo in (("ibs_cbs", ""), ("ibs_cbs_gov", "_gov"), ("ibs_cbs_rural", "_rural")):
            for chave, valor in (config.get(secao) or {}).items():
                if chave in IBS_CBS:
                    payload[f"cdiv_{IBS_CBS[chave]}{sufixo}"] = _bool(valor)

        entrada = config.get("icms_entrada") or {}
        for grupo in ("ei", "ed", "es"):
            for chave, valor in (entrada.get(grupo) or {}).items():
                payload[f"cdiv_{grupo}_{chave}"] = _bool(valor)
        for chave, valor in (entrada.get("nf") or {}).items():
            campo = "cdiv_nf_alq" if chave == "alq" else f"cdiv_{chave}"
            payload[campo] = _bool(valor)
        for chave, valor in (entrada.get("outros_icms") or {}).items():
            if chave in OUTROS_ICMS:
                payload[OUTROS_ICMS[chave]] = _bool(valor)

        saida = config.get("icms_saida") or {}
        for grupo in ("sac", "sas", "svc", "snc"):
            for chave, valor in (saida.get(grupo) or {}).items():
                campos_globais = {
                    "cest": "cdiv_cest", "re29560": "cdiv_re_29560",
                    "fecp": "cdiv_fecp", "fecp_st": "cdiv_fecp_st",
                }
                campo = campos_globais.get(chave, f"cdiv_{grupo}_{chave}")
                payload[campo] = _bool(valor)
        for chave, valor in (saida.get("simples_nacional") or {}).items():
            payload[f"cdiv_{chave}"] = _bool(valor)
        return payload

    async def processar_cliente(self, cnpj, template_dados, progress_callback=None, pause_callback=None):
        cnpj = _cnpj(cnpj)
        if len(cnpj) != 14:
            self.log(f"❌ CNPJ inválido: {cnpj}")
            return False
        try:
            dados_atuais, cmf_id = await self._buscar_cliente(cnpj)
            uf, regime, nome = self._dados_cliente(dados_atuais)
            self.log(
                f"🔎 Cliente validado | CNPJ: {cnpj} | CMF ID: {cmf_id} | "
                f"UF: {uf} | Regime: {regime} | Empresa: {nome}"
            )
            template = self._substituir(template_dados, cnpj, uf, regime, nome)
            tabelas = template.get("tabelas") or {}
            ausentes = [chave for chave in TABELAS if chave not in tabelas]
            if ausentes:
                raise RuntimeError("Template sem as tabelas: " + ", ".join(ausentes))

            codigos_cliente = sorted({
                codigo
                for mapa in TABELAS.values()
                for codigo in _extrair_codigos_not_in(
                    dados_atuais.get(mapa["view_sql"], "")
                )
            })
            codigos_aplicar = codigos_cliente or None
            if codigos_cliente:
                self.log(
                    f"🛡️ CNPJ {cnpj}: preservando NOT IN com "
                    f"{len(codigos_cliente)} código(s) nas quatro VIEWs."
                )

            locais_com_trava = [
                f"VIEW {mapa['nome']}" for mapa in TABELAS.values()
                if _tem_trava_1_2(dados_atuais.get(mapa["view_sql"], ""))
            ]
            locais_com_trava.extend(
                f"TMP {mapa['nome']} ({rotulo})"
                for mapa in TABELAS.values()
                for campo, rotulo in TMP_SQL_CAMPOS
                if _tem_trava_1_2(dados_atuais.get(mapa[campo], ""))
            )
            if locais_com_trava:
                self.log(
                    f"⚠️ CNPJ {cnpj} possui trava 1=2 preservada em: "
                    + ", ".join(locais_com_trava)
                )
            passo = 0

            for chave, mapa in TABELAS.items():
                if pause_callback:
                    retorno = pause_callback()
                    if hasattr(retorno, "__await__"):
                        await retorno
                info = tabelas[chave]
                sql_final = _aplicar_excecoes(
                    info.get("view_sql", ""), codigos_aplicar
                )
                sql_final = _preservar_trava_1_2(
                    sql_final, dados_atuais.get(mapa["view_sql"], "")
                )

                payload_view = {
                    mapa["view_sql"]: sql_final,
                    mapa["view_nome"]: info.get("view_nome", ""),
                }
                await self._patch(cmf_id, payload_view, f"VIEW {mapa['nome']}")
                self.log(f"✅ VIEW - {mapa['nome']} salva via API.")
                passo += 1
                if progress_callback:
                    progress_callback(passo)

                payload_tmp = {
                    mapa[campo]: info.get(campo, False if campo.startswith("flag") else "")
                    for campo in ("tmp_insert", "tmp_values", "tmp_nome", "tmp_delete", "flag3", "flag2", "flag1", "tmp_selectwhere")
                }
                for campo, _ in TMP_SQL_CAMPOS:
                    chave_api = mapa[campo]
                    payload_tmp[chave_api] = _preservar_trava_1_2(
                        payload_tmp[chave_api], dados_atuais.get(chave_api, "")
                    )
                for campo in ("flag1", "flag2", "flag3"):
                    payload_tmp[mapa[campo]] = _bool(payload_tmp[mapa[campo]])
                await self._patch(cmf_id, payload_tmp, f"TMP {mapa['nome']}")
                self.log(f"✅ TMP - {mapa['nome']} salva via API.")
                passo += 1
                if progress_callback:
                    progress_callback(passo)

            divergencias = self._payload_divergencias(
                template.get("comparar_divergencia") or {}, dados_atuais
            )
            if divergencias:
                await self._patch(cmf_id, divergencias, "Comparar Divergência")
                self.log(f"✅ Divergências salvas via API: {len(divergencias)} campos.")
            self.log(f"🎉 Cliente {cnpj} processado completamente via API.")
            return True
        except Exception as erro:
            self.log(f"❌ Falha via API no CNPJ {cnpj}: {erro}")
            return False
