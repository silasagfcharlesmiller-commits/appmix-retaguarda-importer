import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { COOKIE_NAME, verifySession } from "@/lib/session";
import { getUser } from "@/lib/users";
import { requireCredential } from "@/lib/credentials";
import { ensureRetaguardaConnections, getRetaguardaConnection, saveRetaguardaConnection } from "@/lib/retaguarda-connections";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
const validStatus = new Set([
  "pendente",
  "pausado",
  "processando",
  "concluido",
  "erro",
  "cancelado",
]);
const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const machineIdPattern = /^[a-f0-9]{64}$/i;
const onlineMachineStatuses = new Set(["active", "online", "connected", "conectado", "ativo"]);
const disabledMachineStatuses = new Set(["inactive", "disabled", "inativo", "desativado"]);

function machineEnabled(item: Record<string, unknown>) {
  const status = String(item.status || "").trim().toLowerCase();
  const active = String(item.active ?? "true").trim().toLowerCase();
  return !["false", "0", "off", "no", "nao", "não"].includes(active) && !disabledMachineStatuses.has(status);
}
let templateAuditReady: Promise<void> | null = null;
let regimeAuditReady: Promise<void> | null = null;
let clientMachinesReady: Promise<void> | null = null;
let fiscalRulesReady: Promise<void> | null = null;

const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
const FISCAL_FIELDS = ["cbenef", "cbenef_alq", "fecp", "fecp_st", "re29560"];
const CBENEF_UFS = new Set(["DF", "ES", "GO", "PR", "RJ", "RS", "SC", "SP"]);
const FECP_UFS = new Set(UFS.filter((uf) => uf !== "GO"));

function defaultFiscalRules(uf: string) {
  return {
    cbenef: CBENEF_UFS.has(uf) ? "aplicar" : "desativar",
    cbenef_alq: CBENEF_UFS.has(uf) ? "aplicar" : "desativar",
    fecp: FECP_UFS.has(uf) ? "aplicar" : "desativar",
    fecp_st: FECP_UFS.has(uf) ? "aplicar" : "desativar",
    re29560: uf === "CE" ? "aplicar" : "desativar",
  };
}

async function ensureFiscalRules() {
  fiscalRulesReady ??= (async () => {
    await query(`CREATE TABLE IF NOT EXISTS public.regras_fiscais_uf (
      uf CHAR(2) PRIMARY KEY, regras_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      atualizado_por VARCHAR(180), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS public.regras_fiscais_uf_audit (
      id BIGSERIAL PRIMARY KEY, uf CHAR(2) NOT NULL, antes JSONB, depois JSONB NOT NULL,
      actor_id INTEGER NOT NULL, actor_login VARCHAR(180) NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const uf of UFS) await query(
      `INSERT INTO public.regras_fiscais_uf(uf,regras_json,atualizado_por)
       VALUES($1,$2::jsonb,'configuracao inicial') ON CONFLICT(uf) DO NOTHING`,
      [uf, JSON.stringify(defaultFiscalRules(uf))],
    );
    await query(`UPDATE public.regras_fiscais_uf
      SET regras_json=jsonb_set(regras_json,'{re29560}',to_jsonb(CASE WHEN BTRIM(uf)='CE' THEN 'aplicar' ELSE 'desativar' END::text),true),
          atualizado_em=NOW(), atualizado_por='regra inicial RE 29.560'
      WHERE COALESCE(regras_json->>'re29560','herdar')='herdar'`);
  })().catch((error) => { fiscalRulesReady = null; throw error; });
  return fiscalRulesReady;
}

async function ensureClientMachines() {
  clientMachinesReady ??= query(`CREATE TABLE IF NOT EXISTS public.client_machine_ids (
    owner_id INTEGER NOT NULL REFERENCES public.web_users(id) ON DELETE CASCADE,
    cnpj CHAR(14) NOT NULL,
    machine_id VARCHAR(180) NOT NULL,
    verificado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_por VARCHAR(180) NOT NULL,
    PRIMARY KEY(owner_id,cnpj)
  )`).then(() => undefined).catch((error) => {
    clientMachinesReady = null;
    throw error;
  });
  return clientMachinesReady;
}

async function ensureTemplateAudit() {
  templateAuditReady ??= (async () => {
  await query(
    `ALTER TABLE public.templates ADD COLUMN IF NOT EXISTS arquivado BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await query(`CREATE TABLE IF NOT EXISTS public.template_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    template_id INTEGER,
    template_nome VARCHAR(100) NOT NULL,
    acao VARCHAR(20) NOT NULL,
    actor_id INTEGER NOT NULL,
    actor_login VARCHAR(180) NOT NULL,
    actor_nome VARCHAR(100) NOT NULL,
    actor_role VARCHAR(20) NOT NULL,
    detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  })().catch((error) => {
    templateAuditReady = null;
    throw error;
  });
  return templateAuditReady;
}

async function ensureRegimeAudit() {
  regimeAuditReady ??= query(`ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS regime_bloqueado BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS regime_esperado VARCHAR(30);
    ALTER TABLE public.fila_execucao ALTER COLUMN regime_esperado TYPE VARCHAR(120);
    ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS regime_encontrado VARCHAR(30);
    ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS regime_divergente_autorizado BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS regime_divergente_autorizado_por VARCHAR(180);
    ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS regime_divergente_autorizado_em TIMESTAMPTZ;
    ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS oculto BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS public.job_audit_logs (
      id BIGSERIAL PRIMARY KEY, job_id INTEGER NOT NULL, acao VARCHAR(50) NOT NULL,
      actor_id INTEGER, actor_login VARCHAR(180), detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS public.job_progress_logs (
      id BIGSERIAL PRIMARY KEY, job_id INTEGER NOT NULL, progresso SMALLINT NOT NULL,
      etapa VARCHAR(180) NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS job_progress_logs_job_idx
      ON public.job_progress_logs(job_id,id DESC)`).then(() => undefined).catch((error) => {
      regimeAuditReady = null;
      throw error;
    });
  return regimeAuditReady;
}

function validCnpj(value: string) {
  const cnpj = digits(value);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  for (const size of [12, 13]) {
    const weights =
      size === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce(
      (total, weight, index) => total + Number(cnpj[index]) * weight,
      0,
    );
    const candidate = 11 - (sum % 11);
    if (Number(cnpj[size]) !== (candidate >= 10 ? 0 : candidate)) return false;
  }
  return true;
}

async function forward(request: NextRequest, path: string[]) {
  const baseUrl = process.env.APP_MIX_API_URL?.replace(/\/$/, "");
  const apiKey = process.env.APP_MIX_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const body = request.method === "GET" ? undefined : await request.text();
  const upstream = await fetch(
    `${baseUrl}/${path.join("/")}${request.nextUrl.search}`,
    {
      method: request.method,
      headers: {
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    },
  );
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") || "application/json",
    },
  });
}

async function integradorQueryBearer() {
  const configured = process.env.INTEGRADOR_QUERY_BEARER?.replace(/^Bearer\s+/i, "").trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return "";
  try {
    const executable = process.env.INTEGRADOR_DESKTOP_EXE || "C:\\mix fiscal\\integracao\\desktop-integrador.exe";
    const contents = (await readFile(executable)).toString("utf8");
    return contents.match(/VITE_INTEGRADOR_QUERY_BEARER\)[^\x00]{0,80}?:"([^"]+)"/)?.[1] || "";
  } catch {
    return "";
  }
}

function connectionQuery(dialect: string) {
  const normalized = dialect.toLowerCase();
  if (normalized.includes("firebird") || normalized.includes("interbase"))
    return "SELECT 1 AS connection_ok FROM RDB$DATABASE";
  if (normalized.includes("oracle")) return "SELECT 1 AS connection_ok FROM DUAL";
  if (normalized.includes("db2")) return "VALUES 1";
  return "SELECT 1 AS connection_ok";
}

type ClientMachineOption = { machine_id: string; status: string; active: boolean; online: boolean; label: string; dialect: string };

async function activeMachine(bearer: string, cnpj: string, requested = "") {
  let machines: ClientMachineOption[] = [];
  try {
    const response = await fetch(
      `https://api.mixfiscal.com.br/integrador/api/v1/clients/list?search=${cnpj}&page_size=100`,
      { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(30000) },
    );
    if (response.ok) {
      const body = await response.json();
      const candidates = (Array.isArray(body?.clients) ? body.clients : [])
        .filter((item: Record<string, unknown>) => digits(item.cnpj_cpf) === cnpj && machineIdPattern.test(String(item.machine_id || "")))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => Date.parse(String(b.last_ping || b.connected_at || 0)) - Date.parse(String(a.last_ping || a.connected_at || 0)));
      machines = candidates.map((item: Record<string, unknown>) => {
        const status = String(item.status || "").trim().toLowerCase();
        const active = machineEnabled(item);
        return { machine_id: String(item.machine_id), status: status || "sem status", active, online: active && onlineMachineStatuses.has(status), label: String(item.name || item.company_name || item.razao_social || item.client_name || "Robo Integrador"), dialect: String(item.dialect || "") };
      });
      const selected = requested ? machines.find((item) => item.machine_id === requested && item.online) : machines.find((item) => item.online);
      if (selected) return { machineId: selected.machine_id, dialect: selected.dialect, source: "api_integrador", machines };
    }
  } catch {}
  return { machineId: "", dialect: "", source: "nao_encontrado", machines };
}

function templateTables(data: unknown) {
  const labels: Record<string, string> = { pis_cofins: "PIS / COFINS", icms_saida: "ICMS Saida", icms_entrada: "ICMS Entrada", ibs_cbs: "IBS / CBS" };
  const tables = data && typeof data === "object" ? data as Record<string, Record<string, unknown>> : {};
  return Object.entries(labels).flatMap(([key, label]) => {
    const item = tables[key] || {};
    return [
      { key: `${key}_view`, group: label, type: "VIEW", name: String(item.view_nome || "").trim() },
      { key: `${key}_tmp`, group: label, type: "TMP", name: String(item.tmp_nome || "").trim() },
    ];
  }).filter((item) => /^[A-Za-z0-9_$.[\]"]{1,180}$/.test(item.name));
}

function catalogQuery(dialect: string) {
  const value = dialect.toLowerCase();
  if (value.includes("firebird") || value.includes("interbase"))
    return `SELECT FIRST 500 TRIM(RDB$RELATION_NAME) AS TABLE_NAME, CASE WHEN RDB$VIEW_BLR IS NULL THEN 'TABLE' ELSE 'VIEW' END AS TABLE_TYPE FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0 AND UPPER(RDB$RELATION_NAME) CONTAINING 'MXF' ORDER BY RDB$RELATION_ID DESC`;
  if (value.includes("oracle"))
    return `SELECT * FROM (SELECT CASE WHEN OBJECT_TYPE='SYNONYM' THEN OBJECT_NAME ELSE OWNER || '.' || OBJECT_NAME END AS TABLE_NAME, OBJECT_TYPE AS TABLE_TYPE, LAST_DDL_TIME AS LAST_ACTIVITY FROM ALL_OBJECTS WHERE OBJECT_TYPE IN ('TABLE','VIEW','SYNONYM') AND OWNER NOT IN ('SYS','SYSTEM') AND UPPER(OBJECT_NAME) LIKE '%MXF%' ORDER BY CASE WHEN OBJECT_TYPE='SYNONYM' THEN 0 ELSE 1 END,LAST_DDL_TIME DESC NULLS LAST,OWNER,OBJECT_NAME) WHERE ROWNUM <= 500`;
  if (value.includes("db2"))
    return `SELECT TRIM(TABSCHEMA) || '.' || TRIM(TABNAME) AS TABLE_NAME, CASE TYPE WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END AS TABLE_TYPE, ALTER_TIME AS LAST_ACTIVITY FROM SYSCAT.TABLES WHERE TABSCHEMA NOT LIKE 'SYS%' AND UPPER(TABNAME) LIKE '%MXF%' ORDER BY ALTER_TIME DESC FETCH FIRST 500 ROWS ONLY`;
  if (value.includes("mysql") || value.includes("maria"))
    return `SELECT TABLE_NAME, TABLE_TYPE, COALESCE(UPDATE_TIME,CREATE_TIME) AS LAST_ACTIVITY FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND UPPER(TABLE_NAME) LIKE '%MXF%' ORDER BY COALESCE(UPDATE_TIME,CREATE_TIME) DESC LIMIT 500`;
  return `SELECT c.relname AS TABLE_NAME, CASE WHEN c.relkind IN ('v','m') THEN 'VIEW' ELSE 'TABLE' END AS TABLE_TYPE FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','v','m') AND LOWER(c.relname) LIKE '%mxf%' ORDER BY c.oid DESC LIMIT 500`;
}

function limitReadQuery(dialect: string, originalSql: string) {
  const normalized = dialect.toLowerCase();
  let sql = originalSql.trim()
    .replace(/\s+limit\s+\d+\s*$/i, "")
    .replace(/\s+fetch\s+first\s+\d+\s+rows\s+only\s*$/i, "");
  if (normalized.includes("oracle") || normalized.includes("db2")) return `${sql} FETCH FIRST 10 ROWS ONLY`;
  if (normalized.includes("postgres") || normalized.includes("mysql") || normalized.includes("maria")) return `${sql} LIMIT 10`;
  if (normalized.includes("firebird") || normalized.includes("interbase")) {
    if (/^select\s+first\s+\d+/i.test(sql)) return sql.replace(/^select\s+first\s+\d+/i, "SELECT FIRST 10");
    if (/^select\b/i.test(sql)) return sql.replace(/^select\b/i, "SELECT FIRST 10");
    return `SELECT FIRST 10 * FROM (${sql}) appmix_consulta`;
  }
  return `${sql} FETCH FIRST 10 ROWS ONLY`;
}

async function robotQuery(bearer: string, machineId: string, sql: string, timeout = 60000) {
  const response = await fetch("https://api.mixfiscal.com.br/integrador/api/v1/query", {
    method: "POST", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: machineId, task: "read-grpc", query: sql, has_limit: false }),
    cache: "no-store", signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  let decoded: unknown = raw; try { decoded = JSON.parse(raw); } catch {}
  const text = typeof decoded === "string" ? decoded : JSON.stringify(decoded);
  const rows: Record<string, unknown>[] = [];
  let error = "";
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try { const part = JSON.parse(line); if (Array.isArray(part.rows)) rows.push(...part.rows); if (part.error) error = String(part.error); } catch {}
  }
  return { ok: response.ok && !error, rows, error };
}

async function robotConfiguredTables(bearer: string, machineId: string) {
  try {
    const response = await fetch(`https://api.mixfiscal.com.br/integrador/api/v1/settings/details/${machineId}`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const mappings = [
      ["pis_cofins", "PIS / COFINS", "vw_pis_cofins", "tmp_pis_cofins"],
      ["icms_saida", "ICMS Saida", "vw_icms_saida", "tmp_icms_saida"],
      ["icms_entrada", "ICMS Entrada", "vw_icms_entrada", "tmp_icms_entrada"],
      ["ibs_cbs", "IBS / CBS", "vw_ibs_cbs", "tmp_ibs_cbs"],
    ];
    return mappings.flatMap(([key, group, viewKey, tmpKey]) => [
      { key: `${key}_view`, group, type: "VIEW", name: String(data[viewKey] || "").trim() },
      { key: `${key}_tmp`, group, type: "TMP", name: String(data[tmpKey] || "").trim() },
    ]).filter((item) => /^[A-Za-z0-9_$.[\]"]{1,180}$/.test(item.name));
  } catch { return []; }
}

async function handler(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  try {
    const session = await verifySession(
      request.cookies.get(COOKIE_NAME)?.value,
    );
    if (!session)
      return NextResponse.json({ detail: "Sessao expirada." }, { status: 401 });
    const user = await getUser(session.email);
    if (!user)
      return NextResponse.json(
        { detail: "Usuario nao encontrado." },
        { status: 401 },
      );
    const needsLocalHandling =
      path[0] === "v1" &&
      [
        "jobs",
        "lotes",
        "importacoes",
        "configuracoes-xml",
        "execucoes",
        "templates",
        "template-audit",
        "regras-fiscais-uf",
      ].includes(path[1]);
    const proxied = needsLocalHandling ? null : await forward(request, path);
    if (proxied) return proxied;
    if (path[0] !== "v1")
      return NextResponse.json(
        { detail: "Rota nao encontrada." },
        { status: 404 },
      );
    if (request.method === "GET" && path[1] === "service-status") {
      await query(`CREATE TABLE IF NOT EXISTS public.service_heartbeats (
        service_name VARCHAR(60) PRIMARY KEY, host_name VARCHAR(180) NOT NULL,
        process_id INTEGER, version VARCHAR(40), details JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const result = await query(`WITH expected(service_name,label) AS (VALUES
          ('worker_templates','Worker de templates'),
          ('worker_conexao','Worker de conexao'),
          ('worker_importacoes','Worker de importacao'),
          ('worker_xml','Worker de configuracao XML'),
          ('worker_scheduler','Worker Scheduler'),
          ('api_automacao','API de automacao'))
        SELECT e.service_name,e.label,h.host_name,h.version,h.last_seen,
          COALESCE(h.last_seen > NOW() - INTERVAL '35 seconds',FALSE) AS active
        FROM expected e LEFT JOIN public.service_heartbeats h USING(service_name)
        ORDER BY e.service_name`);
      return NextResponse.json({
        items: result.rows,
        checked_at: new Date().toISOString(),
      });
    }

    if (path[1] === "consulta-sql" && ["opcoes", "executar"].includes(path[2] || "")) {
      if (user.role !== "admin" || user.id !== user.owner_id)
        return NextResponse.json({ detail: "Somente a credencial master pode consultar bancos de clientes." }, { status: 403 });
      await query(`CREATE TABLE IF NOT EXISTS public.client_sql_profiles (
        owner_id INTEGER NOT NULL REFERENCES public.web_users(id) ON DELETE CASCADE,
        cnpj CHAR(14) NOT NULL, machine_id VARCHAR(180) NOT NULL, dialect VARCHAR(40),
        atualizado_por VARCHAR(180) NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(owner_id,cnpj)
      ); CREATE TABLE IF NOT EXISTS public.sql_query_audit_logs (
        id BIGSERIAL PRIMARY KEY, owner_id INTEGER NOT NULL, cnpj CHAR(14) NOT NULL,
        machine_id VARCHAR(180) NOT NULL, actor_id INTEGER NOT NULL, actor_login VARCHAR(180) NOT NULL,
        sql_sha256 CHAR(64) NOT NULL, sql_length INTEGER NOT NULL, rows INTEGER NOT NULL DEFAULT 0,
        success BOOLEAN NOT NULL, elapsed_ms INTEGER NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      ); CREATE TABLE IF NOT EXISTS public.client_portal_tables_cache (
        owner_id INTEGER NOT NULL, cnpj CHAR(14) NOT NULL, tables_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(owner_id,cnpj)
      )`);
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
      const cnpj = digits(request.method === "GET" ? request.nextUrl.searchParams.get("cnpj") : body.cnpj);
      if (!validCnpj(cnpj)) return NextResponse.json({ detail: "CNPJ invalido." }, { status: 422 });
      const portalCache = await query("SELECT tables_json,atualizado_em,atualizado_em > NOW()-INTERVAL '5 minutes' AS fresh FROM public.client_portal_tables_cache WHERE owner_id=$1 AND cnpj=$2", [user.owner_id, cnpj]);
      if (request.method === "GET" && (!portalCache.rowCount || !portalCache.rows[0]?.fresh)) {
        await query(`INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por)
          SELECT $1::CHAR(14),NULL,'consultar_tabelas',$2::INTEGER,$3::VARCHAR WHERE NOT EXISTS(
            SELECT 1 FROM public.fila_execucao WHERE cnpj=$1::CHAR(14) AND credential_owner_id=$2::INTEGER AND operacao='consultar_tabelas' AND status IN ('pendente','processando'))`, [cnpj, user.owner_id, user.email]);
        return NextResponse.json({ pending: true, detail: "Consultando os nomes atuais das tabelas no App Mix..." }, { status: 202 });
      }
      const portalTables = (Array.isArray(portalCache.rows[0]?.tables_json) ? portalCache.rows[0].tables_json : [])
        .filter((item: unknown) => item && typeof item === "object" && /^[A-Za-z0-9_$.[\]"]{1,180}$/.test(String((item as Record<string, unknown>).name || "")))
        .map((item: Record<string, unknown>) => ({ key: String(item.key), group: String(item.group), type: String(item.type), name: String(item.name) }));
      const saved = await query("SELECT machine_id,dialect FROM public.client_sql_profiles WHERE owner_id=$1 AND cnpj=$2", [user.owner_id, cnpj]);
      const bearer = await integradorQueryBearer();
      if (!bearer) return NextResponse.json({ detail: "INTEGRADOR_QUERY_BEARER nao configurado." }, { status: 503 });
      const requestedMachine = String(request.method === "GET" ? request.nextUrl.searchParams.get("machine_id") || "" : body.machine_id || "").trim();
      const machine = await activeMachine(bearer, cnpj, requestedMachine);
      if (!requestedMachine && machine.machines.length > 1)
        return NextResponse.json({ detail: "Este CNPJ possui mais de um robo. Selecione o Machine ID que corresponde a filial.", machine_selection_required: true, machines: machine.machines }, { status: 409 });
      if (!requestedMachine && machine.machines.length === 1 && !machine.machines[0].online)
        return NextResponse.json({ detail: "O robo encontrado para este CNPJ esta desconectado.", machine_selection_required: true, machines: machine.machines }, { status: 409 });
      if (!machineIdPattern.test(machine.machineId)) return NextResponse.json({ detail: "Nenhuma maquina ativa foi encontrada para este CNPJ." }, { status: 404 });
      const dialect = machine.dialect || String(saved.rows[0]?.dialect || "");
      const catalog = await robotQuery(bearer, machine.machineId, catalogQuery(dialect));
      if (!catalog.ok) return NextResponse.json({ detail: catalog.error.slice(0, 500) || "Nao foi possivel ler o catalogo do banco pelo robo." }, { status: 502 });
      const catalogTables = catalog.rows.map((row, index) => {
        const name = String(row.TABLE_NAME ?? row.table_name ?? "").trim();
        const rawType = String(row.TABLE_TYPE ?? row.table_type ?? "TABLE").toUpperCase();
        const logicalView = rawType.includes("VIEW") || /(?:^|[.$_])VW(?:[.$_]|$)/i.test(name);
        return { key: `catalog_${index}`, group: "Banco do cliente", type: logicalView ? "VIEW" : "TMP", name };
      }).filter((item) => /^[A-Za-z0-9_$.[\]"]{1,180}$/.test(item.name));
      let recommendedTables: string[] = [];
      if (dialect.toLowerCase().includes("postgres")) {
        const activity = await robotQuery(bearer, machine.machineId, `SELECT relname AS TABLE_NAME,
          COALESCE(last_autovacuum,last_vacuum,last_autoanalyze,last_analyze) AS LAST_ACTIVITY,
          COALESCE(n_tup_ins,0)+COALESCE(n_tup_upd,0)+COALESCE(n_tup_del,0) AS CHANGES
          FROM pg_stat_user_tables WHERE LOWER(relname) LIKE '%mxf%'`);
        if (activity.ok) {
          const ranked = activity.rows.map((row) => ({
            name: String(row.TABLE_NAME ?? row.table_name ?? "").trim(),
            activity: Date.parse(String(row.LAST_ACTIVITY ?? row.last_activity ?? "")) || 0,
            changes: Number(row.CHANGES ?? row.changes ?? 0),
          })).sort((a, b) => b.activity - a.activity || b.changes - a.changes);
          const groups = [
            { match: /^mxf_tmp_pis_cofins(?:_|$)/i, view: (tmp: string) => tmp.replace(/^mxf_tmp_/i, "mxf_vw_") },
            { match: /^mxf_tmp_icms_saida(?:_|$)/i, view: () => "mxf_vw_icms" },
            { match: /^mxf_tmp_icms_entrada(?:_|$)/i, view: () => "mxf_vw_icms_entrada" },
            { match: /^mxf_tmp_(?:ibs_cbs|cbs_ibs)(?:_|$)/i, view: (tmp: string) => tmp.replace(/^mxf_tmp_/i, "mxf_vw_") },
          ];
          const available = new Set(catalogTables.map((table) => table.name.toLowerCase()));
          recommendedTables = groups.flatMap(({ match, view }) => {
            const tmp = ranked.find((item) => match.test(item.name));
            if (!tmp || (!tmp.activity && !tmp.changes)) return [];
            const viewName = view(tmp.name);
            return available.has(viewName.toLowerCase()) ? [viewName, tmp.name] : [];
          }).slice(0, 8);
        }
      }
      await query(`INSERT INTO public.client_sql_profiles(owner_id,cnpj,machine_id,dialect,atualizado_por) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(owner_id,cnpj) DO UPDATE SET machine_id=EXCLUDED.machine_id,dialect=EXCLUDED.dialect,atualizado_por=EXCLUDED.atualizado_por,atualizado_em=NOW()`, [user.owner_id, cnpj, machine.machineId, dialect, user.email]);
      if (request.method === "GET") {
        const latest = await query(`SELECT t.nome AS template_nome,s.dados_json
          FROM public.fila_execucao f
          JOIN public.templates t ON t.id=f.template_id
          LEFT JOIN public.template_secoes s ON s.template_id=f.template_id AND s.chave='tabelas'
          WHERE f.cnpj=$1 AND f.template_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)
          ORDER BY f.id DESC LIMIT 1`, [cnpj, user.owner_id]);
        const currentRobotTables = await robotConfiguredTables(bearer, machine.machineId);
        const catalogMxf = catalogTables.filter((item) => item.name.toLowerCase().includes("mxf"));
        const catalogByBase = new Map<string, string>();
        for (const table of catalogTables) {
          const base = table.name.replace(/^[^.]+\./, "").toLowerCase();
          // Oracle lista primeiro os SYNONYMs lógicos do App Mix. Não deixa a
          // tabela física OWNER.TABELA sobrescrever esse nome consultável.
          if (!catalogByBase.has(base)) catalogByBase.set(base, table.name);
        }
        const confirmedPortalTables = portalTables.map((table: { key: string; group: string; type: string; name: string }) => {
          const confirmed = catalogByBase.get(table.name.replace(/^[^.]+\./, "").toLowerCase());
          return confirmed ? { ...table, name: confirmed } : null;
        }).filter(Boolean) as { key: string; group: string; type: string; name: string }[];
        const shortcuts = confirmedPortalTables.length ? confirmedPortalTables : currentRobotTables.length ? currentRobotTables : catalogMxf.length ? catalogMxf : catalogTables;
        const templateShortcuts = latest.rowCount ? templateTables(latest.rows[0].dados_json) : [];
        if (confirmedPortalTables.length) recommendedTables = confirmedPortalTables.map((table) => table.name);
        if (!recommendedTables.length && templateShortcuts.length) {
          const available = new Set(catalogTables.map((table) => table.name.replace(/^[^.]+\./, "").toLowerCase()));
          recommendedTables = templateShortcuts.map((table) => table.name).filter((name) => available.has(name.replace(/^[^.]+\./, "").toLowerCase())).slice(0, 8);
        }
        const baseName = (name: string) => name.replace(/^[^.]+\./, "");
        const byBase = new Map(catalogTables.map((table) => [baseName(table.name).toLowerCase(), table.name]));
        const groupOf = (name: string) => {
          const value = baseName(name).toLowerCase();
          if (value.includes("pis_cofins")) return "pis";
          if (value.includes("icms_entrada")) return "entrada";
          if (value.includes("icms_saida") || value === "mxf_vw_icms") return "saida";
          if (value.includes("ibs") || value.includes("cbs")) return "ibs";
          return "";
        };
        const catalogType = new Map(catalogTables.map((table) => [baseName(table.name).toLowerCase(), table.type]));
        const initiallyComplete = new Set<string>();
        for (const group of [...new Set(recommendedTables.map(groupOf).filter(Boolean))]) {
          const names = recommendedTables.filter((name) => groupOf(name) === group);
          const types = new Set(names.map((name) => catalogType.get(baseName(name).toLowerCase())));
          if (types.has("VIEW") && types.has("TMP")) initiallyComplete.add(group);
        }
        recommendedTables = recommendedTables.filter((name) => initiallyComplete.has(groupOf(name)));
        const selectedGroups = new Set<string>(initiallyComplete);
        if (dialect.toLowerCase().includes("oracle")) {
          const findName = (pattern: RegExp) => [...byBase.entries()].find(([name]) => pattern.test(name))?.[1];
          const pisTmpEntry = [...byBase.entries()].find(([name]) => /^mxf_(?:tmp|t)_pis_cofins(?:_[a-z]{2})?$/i.test(name));
          const configuredState = templateShortcuts.map((table) => baseName(table.name).match(/_([a-z]{2})$/i)?.[1] || "").find(Boolean);
          const state = configuredState || pisTmpEntry?.[0].match(/_([a-z]{2})$/i)?.[1] || "";
          const addOraclePair = (group: string, viewPatterns: RegExp[], tmpPattern: RegExp) => {
            if (selectedGroups.has(group)) return;
            const view = viewPatterns.map(findName).find(Boolean);
            const tmp = findName(tmpPattern);
            if (view && tmp) { recommendedTables.push(view, tmp); selectedGroups.add(group); }
          };
          addOraclePair("pis", [/^mxf_vw_pis_cofins(?:_|$)/i], state ? new RegExp(`^mxf_(?:tmp|t)_pis_cofins_${state}$`, "i") : /^mxf_(?:tmp|t)_pis_cofins(?:_|$)/i);
          addOraclePair("saida", [/^mxf_vw_icms_saida_estados$/i, /^mxf_vw_icms(?:_saida)?$/i], state ? new RegExp(`^mxf_(?:tmp|t)_icms_saida_${state}$`, "i") : /^mxf_(?:tmp|t)_icms_saida(?:_|$)/i);
          addOraclePair("entrada", [/^mxf_vw_icms_entrada_estados$/i, /^mxf_vw_icms_entrada$/i], state ? new RegExp(`^mxf_(?:tmp|t)_icms_entrada_${state}$`, "i") : /^mxf_(?:tmp|t)_icms_entrada(?:_|$)/i);
        }
        const inferPair = (group: string, tmpPattern: RegExp, fixedView?: string) => {
          if (selectedGroups.has(group)) return;
          const candidates = [...byBase.keys()].filter((name) => tmpPattern.test(name)).sort((a, b) => a.length - b.length || a.localeCompare(b));
          for (const tmpBase of candidates) {
            const viewBase = fixedView || tmpBase.replace(/^mxf_tmp_/, "mxf_vw_");
            const tmpName = byBase.get(tmpBase); const viewName = byBase.get(viewBase);
            if (tmpName && viewName) { recommendedTables.push(viewName, tmpName); selectedGroups.add(group); return; }
          }
        };
        inferPair("pis", /^mxf_(?:tmp|t)_pis_cofins(?:_|$)/);
        inferPair("saida", /^mxf_(?:tmp|t)_icms_saida(?:_|$)/, "mxf_vw_icms");
        inferPair("entrada", /^mxf_(?:tmp|t)_icms_entrada(?:_|$)/, "mxf_vw_icms_entrada");
        inferPair("ibs", /^mxf_(?:tmp|t)_(?:ibs_cbs|cbs_ibs)(?:_|$)/);
        recommendedTables = [...new Set(recommendedTables)].slice(0, 8);
        if (!recommendedTables.length) recommendedTables = catalogMxf.slice(0, 8).map((table) => table.name);
        const reference = confirmedPortalTables.length ? "Configuração atual do App Mix" : currentRobotTables.length ? "Configuração atual do robô" : recommendedTables.length && latest.rowCount ? String(latest.rows[0].template_nome) : "Catálogo atual do banco";
        return NextResponse.json({ cnpj, machine_id: machine.machineId, machines: machine.machines, dialect, tables: shortcuts, catalog_tables: catalogTables, recommended_tables: recommendedTables, template_nome: reference, max_rows: 10 });
      }
      let sql = String(body.sql || "").trim().replace(/;\s*$/, "");
      if (!sql || sql.length > 20000 || !/^(select|with)\b/i.test(sql) || /;|--|\/\*|\*\//.test(sql) || /\b(insert|update|delete|drop|alter|create|truncate|execute|exec|call|merge|grant|revoke|commit|rollback|copy|vacuum|attach|detach|pragma)\b/i.test(sql))
        return NextResponse.json({ detail: "A consulta deve conter um unico SELECT/WITH somente leitura." }, { status: 422 });
      const allowed = new Set<string>();
      const configuredForValidation = await robotConfiguredTables(bearer, machine.machineId);
      for (const table of [...catalogTables, ...configuredForValidation]) {
        const fullName = table.name.replace(/["\[\]]/g, "").toLowerCase();
        allowed.add(fullName); allowed.add(fullName.split(".").pop() || fullName);
      }
      allowed.add("rdb$database");
      allowed.add("dual");
      allowed.add("sysibm.sysdummy1");
      const ctes = new Set([...sql.matchAll(/(?:^|,)\s*([A-Za-z_][\w$]*)\s+as\s*\(/gi)].map((match) => match[1].toLowerCase()));
      const refs = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z0-9_$.[\]"]+)/gi)].map((match) => match[1].replace(/["\[\]]/g, "").toLowerCase());
      if (!refs.length || refs.some((name) => !allowed.has(name) && !ctes.has(name))) return NextResponse.json({ detail: "A consulta pode acessar somente tabelas/views descobertas no banco deste CNPJ." }, { status: 422 });
      const limitedSql = limitReadQuery(dialect, sql);
      const startedAt = Date.now(); const execution = await robotQuery(bearer, machine.machineId, limitedSql);
      await query(`INSERT INTO public.sql_query_audit_logs(owner_id,cnpj,machine_id,actor_id,actor_login,sql_sha256,sql_length,rows,success,elapsed_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [user.owner_id, cnpj, machine.machineId, user.id, user.email, createHash("sha256").update(String(body.sql || "")).digest("hex"), String(body.sql || "").length, Math.min(execution.rows.length,10), execution.ok, Date.now()-startedAt]);
      if (!execution.ok) return NextResponse.json({ detail: execution.error.slice(0,500) || "A consulta remota falhou." }, { status: 502 });
      const rows = execution.rows.slice(0,10);
      return NextResponse.json({ columns: rows.length ? Object.keys(rows[0]) : [], rows, count: rows.length, limited: execution.rows.length > 10, machine_id: machine.machineId, elapsed_ms: Date.now()-startedAt });
    }

    if (request.method === "GET" && path[1] === "template-audit") {
      if (user.role !== "admin" || user.id !== user.owner_id) {
        return NextResponse.json(
          {
            detail:
              "Somente o administrador master pode consultar a auditoria.",
          },
          { status: 403 },
        );
      }
      await ensureTemplateAudit();
      const result = await query(
        "SELECT id,template_id,template_nome,acao,actor_login,actor_nome,actor_role,detalhes,criado_em FROM public.template_audit_logs ORDER BY id DESC LIMIT 200",
      );
      return NextResponse.json({ items: result.rows });
    }

    if (path[1] === "regras-fiscais-uf") {
      await ensureFiscalRules();
      if (request.method === "GET") {
        const result = await query("SELECT uf,regras_json,atualizado_por,atualizado_em FROM public.regras_fiscais_uf ORDER BY uf");
        return NextResponse.json({ items: result.rows, fields: FISCAL_FIELDS });
      }
      if (request.method === "PUT") {
        if (user.role !== "admin" || user.id !== user.owner_id)
          return NextResponse.json({ detail: "Apenas o administrador master pode alterar as regras fiscais." }, { status: 403 });
        const body = await request.json();
        const uf = String(body.uf || "").trim().toUpperCase();
        const input = body.regras;
        if (!UFS.includes(uf) || !input || typeof input !== "object")
          return NextResponse.json({ detail: "UF ou regras invalidas." }, { status: 422 });
        const regras = Object.fromEntries(FISCAL_FIELDS.map((field) => {
          const value = String(input[field] || "herdar").toLowerCase();
          return [field, ["aplicar", "desativar", "herdar"].includes(value) ? value : "herdar"];
        }));
        const saved = await transaction(async (client) => {
          const before = await client.query("SELECT regras_json FROM public.regras_fiscais_uf WHERE uf=$1 FOR UPDATE", [uf]);
          const result = await client.query(
            `INSERT INTO public.regras_fiscais_uf(uf,regras_json,atualizado_por) VALUES($1,$2::jsonb,$3)
             ON CONFLICT(uf) DO UPDATE SET regras_json=EXCLUDED.regras_json,atualizado_por=EXCLUDED.atualizado_por,atualizado_em=NOW()
             RETURNING uf,regras_json,atualizado_por,atualizado_em`,
            [uf, JSON.stringify(regras), user.email],
          );
          await client.query(
            "INSERT INTO public.regras_fiscais_uf_audit(uf,antes,depois,actor_id,actor_login) VALUES($1,$2::jsonb,$3::jsonb,$4,$5)",
            [uf, JSON.stringify(before.rows[0]?.regras_json || null), JSON.stringify(regras), user.id, user.email],
          );
          return result.rows[0];
        });
        return NextResponse.json({ item: saved });
      }
    }

    if (request.method === "GET" && path[1] === "templates") {
      await ensureTemplateAudit();
      if (path[2] && path[3] === "conexao-retaguarda") {
        const item = await getRetaguardaConnection(user.owner_id, Number(path[2]));
        return NextResponse.json({ item });
      }
      if (path[2]) {
        const template = await query<{
          id: number;
          nome: string;
          criado_em: string;
          atualizado_em: string;
          dados: Record<string, unknown>;
        }>(
          `SELECT t.id,t.nome,t.criado_em,t.atualizado_em,
                  COALESCE(jsonb_object_agg(s.chave,s.dados_json)
                    FILTER (WHERE s.chave IS NOT NULL),'{}'::jsonb) AS dados
             FROM public.templates t
             LEFT JOIN public.template_secoes s ON s.template_id=t.id
            WHERE t.id=$1 AND t.arquivado=FALSE
            GROUP BY t.id,t.nome,t.criado_em,t.atualizado_em`,
          [Number(path[2])],
        );
        if (!template.rowCount)
          return NextResponse.json(
            { detail: "Template nao encontrado." },
            { status: 404 },
          );
        return NextResponse.json(template.rows[0]);
      }
      await ensureRetaguardaConnections();
      const result =
        await query(`SELECT t.id,t.nome,t.criado_em,t.atualizado_em,
        EXISTS(SELECT 1 FROM public.template_secoes x WHERE x.template_id=t.id AND x.chave='configuracao_xml' AND jsonb_array_length(COALESCE(x.dados_json->'paths','[]'::jsonb))>0) AS possui_xml,
        EXISTS(SELECT 1 FROM public.template_secoes x WHERE x.template_id=t.id AND x.chave='configuracao_xml' AND NULLIF(BTRIM(x.dados_json->'scheduler'->>'command'),'') IS NOT NULL) AS possui_scheduler,
        EXISTS(SELECT 1 FROM public.template_retaguarda_connections r WHERE r.template_id=t.id AND r.owner_id=$1 AND NULLIF(BTRIM(r.banco_nome),'') IS NOT NULL AND NULLIF(BTRIM(r.usuario),'') IS NOT NULL AND r.senha_encrypted IS NOT NULL) AS possui_conexao,
        COALESCE(s.dados_json->'regimes_tributarios',jsonb_build_array(COALESCE(s.dados_json->>'regime_tributario','qualquer'))) AS regimes_tributarios
        FROM public.templates t LEFT JOIN public.template_secoes s ON s.template_id=t.id AND s.chave='configuracao' WHERE t.arquivado=FALSE ORDER BY t.nome`, [user.owner_id]);
      return NextResponse.json({ items: result.rows });
    }

    if (request.method === "PUT" && path[1] === "templates" && path[2] && path[3] === "conexao-retaguarda") {
      const body = await request.json();
      const cnpj = digits(body.cnpj);
      const porta = Number(body.porta);
      const required = [body.banco_nome, body.usuario].every((value) => String(value || "").trim());
      const portaValida = String(body.banco_tipo).toLowerCase() === "sqlite" ? porta === 0 : porta >= 1 && porta <= 65535;
      const existing = await getRetaguardaConnection(user.owner_id, Number(path[2]));
      const senhaValida = Boolean(String(body.senha || "").trim()) || Boolean(existing?.senha_cadastrada);
      if (!required || !senhaValida || !Number.isInteger(porta) || !portaValida)
        return NextResponse.json({ detail: "Revise os dados obrigatorios da conexao." }, { status: 422 });
      const template = await query("SELECT 1 FROM public.templates WHERE id=$1 AND arquivado=FALSE", [Number(path[2])]);
      if (!template.rowCount) return NextResponse.json({ detail: "Template nao encontrado." }, { status: 404 });
      const item = await saveRetaguardaConnection(user.owner_id, Number(path[2]), user.email, {
        nome: String(body.nome || "Conexao do template").trim(), cnpj, banco_tipo: String(body.banco_tipo).trim().toLowerCase(),
        host: String(body.host).trim(), porta, banco_nome: String(body.banco_nome).trim(),
        usuario: String(body.usuario).trim(), senha: String(body.senha || ""), machine_id: String(body.machine_id || "").trim(),
        servico: String(body.servico || "").trim(), servico_mixfiscal: String(body.servico_mixfiscal || "").trim(),
        tamanho_max_mensagem: Math.max(1, Math.min(100, Number(body.tamanho_max_mensagem) || 4)),
      });
      return NextResponse.json({ item });
    }

    if (request.method === "POST" && path[1] === "templates" && !path[2]) {
      await ensureTemplateAudit();
      const body = await request.json();
      const nome = String(body.nome || "").trim();
      if (nome.length < 2 || nome.length > 100)
        return NextResponse.json(
          { detail: "Nome deve ter entre 2 e 100 caracteres." },
          { status: 422 },
        );
      const created = await transaction(async (client) => {
        const existing = await client.query(
          "SELECT id,nome,arquivado FROM public.templates WHERE LOWER(nome)=LOWER($1) FOR UPDATE",
          [nome],
        );
        if (existing.rows.some((item) => !item.arquivado))
          throw Object.assign(new Error("Ja existe um template ativo com esse nome."), {
            status: 409,
          });
        const archived = existing.rows.find((item) => item.arquivado);
        const result = archived
          ? await client.query(
              "UPDATE public.templates SET nome=$1,arquivado=FALSE,atualizado_em=NOW() WHERE id=$2 RETURNING id,nome",
              [nome, archived.id],
            )
          : await client.query(
              "INSERT INTO public.templates (nome) VALUES ($1) RETURNING id,nome",
              [nome],
            );
        const id = result.rows[0].id;
        // Recriar um nome arquivado deve produzir um template limpo. As
        // secoes antigas permanecem registradas no log de exclusao, mas nao
        // podem reaparecer silenciosamente no novo cadastro.
        if (archived)
          await client.query(
            "DELETE FROM public.template_secoes WHERE template_id=$1",
            [id],
          );
        if (body.copiar_de)
          await client.query(
            "INSERT INTO public.template_secoes (template_id,chave,dados_json) SELECT $1,chave,dados_json FROM public.template_secoes WHERE template_id=$2",
            [id, Number(body.copiar_de)],
          );
        else {
          const fields = {
            view_nome: "",
            view_sql: "",
            tmp_nome: "",
            tmp_delete: "",
            flag1: false,
            flag2: false,
            flag3: false,
            tmp_insert: "",
            tmp_values: "",
            tmp_selectwhere: "",
          };
          const tables = Object.fromEntries(
            ["pis_cofins", "icms_saida", "icms_entrada", "ibs_cbs"].map(
              (key) => [key, { ...fields }],
            ),
          );
          for (const [key, data] of Object.entries({
            configuracao: {
              regimes_tributarios: ["qualquer"],
              modo_campos_vazios: nome.localeCompare("CONFIG SEPARADA", "pt-BR", { sensitivity: "base" }) === 0 ? "preservar" : "apagar",
              descricao: nome.localeCompare("CONFIG SEPARADA", "pt-BR", { sensitivity: "base" }) === 0
                ? "Usado para executar automacoes separadas. Campos vazios e flags nao marcadas nao alteram o cliente."
                : nome.localeCompare("APAGAR", "pt-BR", { sensitivity: "base" }) === 0
                  ? "Usado quando a intencao for limpar configuracoes existentes do cliente."
                  : "",
            },
            tabelas: tables,
            comparar_divergencia: {},
            excecoes_produtos: {},
            configuracao_xml: {
              enabled: true,
              processXmlRealtime: false,
              paths: [],
            },
          }))
            await client.query(
              "INSERT INTO public.template_secoes (template_id,chave,dados_json) VALUES ($1,$2,$3::jsonb)",
              [id, key, JSON.stringify(data)],
            );
        }
        await client.query(
          "INSERT INTO public.template_audit_logs(template_id,template_nome,acao,actor_id,actor_login,actor_nome,actor_role,detalhes) VALUES($1,$2,'criou',$3,$4,$5,$6,$7::jsonb)",
          [
            id,
            nome,
            user.id,
            user.email,
            user.nome,
            user.role,
            JSON.stringify({
              copiado_de: body.copiar_de ? Number(body.copiar_de) : null,
              reativado_de_arquivado: Boolean(archived),
            }),
          ],
        );
        return result.rows[0];
      });
      return NextResponse.json(created, { status: 201 });
    }

    if (request.method === "PUT" && path[1] === "templates" && path[2]) {
      await ensureTemplateAudit();
      const body = await request.json();
      if (["automatico", "simulacao"].includes(body?.dados?.configuracao?.modo_regras_fiscais))
        await ensureFiscalRules();
      const allowed = [
        "configuracao",
        "tabelas",
        "comparar_divergencia",
        "excecoes_produtos",
        "configuracao_xml",
      ];
      if (!body.dados || typeof body.dados !== "object")
        return NextResponse.json(
          { detail: "Dados invalidos." },
          { status: 422 },
        );
      await transaction(async (client) => {
        const exists = await client.query(
          "SELECT id,nome FROM public.templates WHERE id=$1 AND arquivado=FALSE",
          [Number(path[2])],
        );
        if (!exists.rowCount) throw new Error("Template nao encontrado.");
        const before = await client.query(
          "SELECT chave,dados_json FROM public.template_secoes WHERE template_id=$1",
          [Number(path[2])],
        );
        for (const key of allowed)
          if (body.dados[key] !== undefined)
            await client.query(
              "INSERT INTO public.template_secoes (template_id,chave,dados_json) VALUES ($1,$2,$3::jsonb) ON CONFLICT(template_id,chave) DO UPDATE SET dados_json=EXCLUDED.dados_json",
              [Number(path[2]), key, JSON.stringify(body.dados[key])],
            );
        await client.query(
          "UPDATE public.templates SET atualizado_em=NOW() WHERE id=$1",
          [Number(path[2])],
        );
        const estadoAnterior = Object.fromEntries(
          before.rows.map((item) => [item.chave, item.dados_json]),
        );
        await client.query(
          "INSERT INTO public.template_audit_logs(template_id,template_nome,acao,actor_id,actor_login,actor_nome,actor_role,detalhes) VALUES($1,$2,'alterou',$3,$4,$5,$6,$7::jsonb)",
          [
            Number(path[2]),
            exists.rows[0].nome,
            user.id,
            user.email,
            user.nome,
            user.role,
            JSON.stringify({ antes: estadoAnterior, depois: body.dados }),
          ],
        );
      });
      return NextResponse.json({ ok: true });
    }

    if (request.method === "DELETE" && path[1] === "templates" && path[2]) {
      await ensureTemplateAudit();
      const used = await query(
        "SELECT 1 FROM public.fila_execucao WHERE template_id=$1 AND status IN ('pendente','processando') LIMIT 1",
        [Number(path[2])],
      );
      if (used.rowCount)
        return NextResponse.json(
          {
            detail: "Template possui trabalhos pendentes ou em processamento.",
          },
          { status: 409 },
        );
      const removed = await transaction(async (client) => {
        const template = await client.query(
          "SELECT id,nome FROM public.templates WHERE id=$1 AND arquivado=FALSE",
          [Number(path[2])],
        );
        if (!template.rowCount) return null;
        const sections = await client.query(
          "SELECT chave,dados_json FROM public.template_secoes WHERE template_id=$1",
          [Number(path[2])],
        );
        const estadoAnterior = Object.fromEntries(
          sections.rows.map((item) => [item.chave, item.dados_json]),
        );
        await client.query(
          "INSERT INTO public.template_audit_logs(template_id,template_nome,acao,actor_id,actor_login,actor_nome,actor_role,detalhes) VALUES($1,$2,'excluiu',$3,$4,$5,$6,$7::jsonb)",
          [
            Number(path[2]),
            template.rows[0].nome,
            user.id,
            user.email,
            user.nome,
            user.role,
            JSON.stringify({ antes: estadoAnterior }),
          ],
        );
        await client.query(
          "UPDATE public.templates SET arquivado=TRUE,atualizado_em=NOW() WHERE id=$1",
          [Number(path[2])],
        );
        return template.rows[0];
      });
      return removed
        ? NextResponse.json({ ok: true })
        : NextResponse.json(
            { detail: "Template nao encontrado." },
            { status: 404 },
          );
    }

    if (request.method === "GET" && path[1] === "jobs" && !path[2]) {
      await ensureRegimeAudit();
      await ensureRetaguardaConnections();
      await ensureClientMachines();
      const status = request.nextUrl.searchParams.get("status");
      const cnpj = digits(request.nextUrl.searchParams.get("cnpj"));
      const limit = Math.min(
        Math.max(Number(request.nextUrl.searchParams.get("limite")) || 100, 1),
        1000,
      );
      await query(
        "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS credential_owner_id INTEGER",
      );
      await query(
        "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS solicitado_por VARCHAR(180)",
      );
      await query(
        "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS progresso SMALLINT NOT NULL DEFAULT 0",
      );
      await query(
        "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS etapa VARCHAR(180) NOT NULL DEFAULT 'Aguardando worker'",
      );
      await query(
        "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS progresso_atualizado_em TIMESTAMPTZ",
      );
      const values: unknown[] = [user.owner_id];
      const filters: string[] = [
        user.role === "admin"
          ? "EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$1)"
          : "f.credential_owner_id = $1",
        "COALESCE(f.oculto,FALSE)=FALSE",
      ];
      if (user.role !== "admin") values[0] = user.id;
      if (status && validStatus.has(status)) {
        values.push(status);
        filters.push(`f.status = $${values.length}`);
      }
      if (cnpj) {
        values.push(cnpj);
        filters.push(`f.cnpj = $${values.length}`);
      }
      values.push(limit);
      const result = await query(
        `SELECT f.id, f.cnpj, f.operacao, f.status, f.tentativas, f.mensagem_erro, f.criado_em, f.processado_em, f.solicitado_por, f.progresso, f.etapa, f.progresso_atualizado_em, f.regime_bloqueado, f.regime_esperado, f.regime_encontrado, f.regime_divergente_autorizado, f.regime_divergente_autorizado_por, f.regime_divergente_autorizado_em, t.id AS template_id, t.nome AS template_nome, COALESCE(cm.machine_id,r.machine_id) AS machine_id FROM public.fila_execucao f LEFT JOIN public.templates t ON t.id=f.template_id LEFT JOIN public.template_retaguarda_connections r ON r.template_id=f.template_id AND r.owner_id=f.credential_owner_id LEFT JOIN public.client_machine_ids cm ON cm.owner_id=f.credential_owner_id AND cm.cnpj=f.cnpj ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY f.id DESC LIMIT $${values.length}`,
        values,
      );
      return NextResponse.json({ items: result.rows, limite: limit });
    }

    if (
      request.method === "POST" &&
      path[1] === "jobs" &&
      path[2] &&
      path[3] === "testar-banco"
    ) {
      if (user.role !== "admin" || user.id !== user.owner_id)
        return NextResponse.json(
          { detail: "Somente a credencial master pode testar o banco do cliente." },
          { status: 403 },
        );
      await ensureRegimeAudit();
      await ensureRetaguardaConnections();
      await ensureClientMachines();
      const body = await request.json().catch(() => ({}));
      const scopeId = user.owner_id;
      const job = await query(
        `SELECT f.id,f.cnpj,f.template_id,f.credential_owner_id,
                COALESCE(cm.machine_id,r.machine_id) AS machine_id,r.banco_tipo
           FROM public.fila_execucao f
           LEFT JOIN public.template_retaguarda_connections r
             ON r.template_id=f.template_id AND r.owner_id=f.credential_owner_id
           LEFT JOIN public.client_machine_ids cm
             ON cm.owner_id=f.credential_owner_id AND cm.cnpj=f.cnpj
          WHERE f.id=$1 AND EXISTS (
            SELECT 1 FROM public.web_users wu
             WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2
          )`,
        [Number(path[2]), scopeId],
      );
      if (!job.rowCount)
        return NextResponse.json({ detail: "Job nao encontrado." }, { status: 404 });
      const bearer = await integradorQueryBearer();
      if (!bearer)
        return NextResponse.json(
          { detail: "INTEGRADOR_QUERY_BEARER nao configurado no servidor." },
          { status: 503 },
        );
      const requestedMachineId = String(body.machine_id || job.rows[0].machine_id || "").trim();
      const machine = await activeMachine(bearer, job.rows[0].cnpj, requestedMachineId);
      const machineId = machine.machineId;
      const machineSource = "api_integrador";
      if (!machineIdPattern.test(machineId))
        return NextResponse.json(
          { detail: "O Machine ID esta desativado, offline ou nao pertence a este CNPJ." },
          { status: 422 },
        );
      const dialect = String(machine.dialect || body.dialect || job.rows[0].banco_tipo || "");
      await query(
        `INSERT INTO public.client_machine_ids(owner_id,cnpj,machine_id,verificado_em,atualizado_por)
         VALUES($1,$2,$3,NOW(),$4)
         ON CONFLICT(owner_id,cnpj) DO UPDATE SET
           machine_id=EXCLUDED.machine_id,
           verificado_em=NOW(),
           atualizado_por=EXCLUDED.atualizado_por`,
        [job.rows[0].credential_owner_id || scopeId, job.rows[0].cnpj, machineId, user.email],
      );
      const startedAt = Date.now();
      let connected = false;
      let detail = "Banco local sem conexao.";
      let upstreamStatus = 0;
      try {
        const upstream = await fetch("https://api.mixfiscal.com.br/integrador/api/v1/query", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: machineId,
            task: "read-grpc",
            query: connectionQuery(dialect),
            has_limit: false,
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(45000),
        });
        upstreamStatus = upstream.status;
        const raw = await upstream.text();
        let decoded: unknown = raw;
        try { decoded = JSON.parse(raw); } catch {}
        const responseText = typeof decoded === "string" ? decoded : JSON.stringify(decoded);
        connected = upstream.ok && !/"error"\s*:|query error|connection error/i.test(responseText) &&
          (/"connection_ok"\s*:\s*1/i.test(responseText) || /"done"\s*:\s*true/i.test(responseText));
        detail = connected
          ? "Consulta SQL executada com sucesso pelo robo."
          : "O robo respondeu, mas a consulta ao banco falhou.";
      } catch (error) {
        detail = error instanceof Error && error.name === "TimeoutError"
          ? "O robo nao respondeu ao teste dentro de 45 segundos."
          : "Nao foi possivel consultar o banco pelo robo.";
      }
      await query(
        `INSERT INTO public.job_audit_logs(job_id,acao,actor_id,actor_login,detalhes)
         VALUES($1,'teste_banco_remoto',$2,$3,$4::jsonb)`,
        [Number(path[2]), user.id, user.email, JSON.stringify({
          cnpj: job.rows[0].cnpj,
          machine_id: machineId,
          machine_source: machineSource,
          connected,
          upstream_status: upstreamStatus,
          elapsed_ms: Date.now() - startedAt,
        })],
      );
      return NextResponse.json({
        connected,
        robot_connected: upstreamStatus > 0,
        detail,
        machine_id: machineId,
        machine_source: machineSource,
        checked_at: new Date().toISOString(),
        elapsed_ms: Date.now() - startedAt,
      }, { status: connected ? 200 : 502 });
    }

    if (
      ["GET", "POST"].includes(request.method) && path[1] === "jobs" && path[2] &&
      ["consulta-sql-opcoes", "consultar-sql"].includes(path[3] || "")
    ) {
      if (user.role !== "admin" || user.id !== user.owner_id)
        return NextResponse.json({ detail: "Somente a credencial master pode consultar o banco do cliente." }, { status: 403 });
      await ensureRegimeAudit(); await ensureRetaguardaConnections(); await ensureClientMachines();
      const context = await query(
        `SELECT f.id,f.cnpj,f.template_id,f.credential_owner_id,
                COALESCE(cm.machine_id,r.machine_id) AS machine_id,r.banco_tipo,s.dados_json AS tabelas
           FROM public.fila_execucao f
           LEFT JOIN public.template_retaguarda_connections r ON r.template_id=f.template_id AND r.owner_id=f.credential_owner_id
           LEFT JOIN public.client_machine_ids cm ON cm.owner_id=f.credential_owner_id AND cm.cnpj=f.cnpj
           LEFT JOIN public.template_secoes s ON s.template_id=f.template_id AND s.chave='tabelas'
          WHERE f.id=$1 AND EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`,
        [Number(path[2]), user.owner_id],
      );
      if (!context.rowCount) return NextResponse.json({ detail: "Job nao encontrado." }, { status: 404 });
      const item = context.rows[0];
      const tables = templateTables(item.tabelas);
      if (!tables.length) return NextResponse.json({ detail: "O template deste job nao possui nomes de VIEW/TMP cadastrados." }, { status: 422 });
      const bearer = await integradorQueryBearer();
      if (!bearer) return NextResponse.json({ detail: "INTEGRADOR_QUERY_BEARER nao configurado no servidor." }, { status: 503 });
      const machine = await activeMachine(bearer, item.cnpj, String(item.machine_id || ""));
      if (!machineIdPattern.test(machine.machineId)) return NextResponse.json({ detail: "Nenhuma maquina ativa foi encontrada para este CNPJ." }, { status: 422 });
      const dialect = machine.dialect || String(item.banco_tipo || "");
      if (request.method === "GET")
        return NextResponse.json({ cnpj: item.cnpj, machine_id: machine.machineId, dialect, tables, max_rows: 10 });

      const body = await request.json().catch(() => ({}));
      let sql = String(body.sql || "").trim().replace(/;\s*$/, "");
      if (!sql || sql.length > 20000 || !/^(select|with)\b/i.test(sql) || /;|--|\/\*|\*\//.test(sql) || /\b(insert|update|delete|drop|alter|create|truncate|execute|exec|call|merge|grant|revoke|commit|rollback|copy|vacuum|attach|detach|pragma)\b/i.test(sql))
        return NextResponse.json({ detail: "A consulta deve conter um unico SELECT/WITH somente leitura." }, { status: 422 });
      const allowedNames = new Set(tables.map((table) => table.name.replace(/["\[\]]/g, "").toLowerCase()));
      allowedNames.add("rdb$database");
      allowedNames.add("dual");
      allowedNames.add("sysibm.sysdummy1");
      const cteNames = new Set([...sql.matchAll(/(?:^|,)\s*([A-Za-z_][\w$]*)\s+as\s*\(/gi)].map((match) => match[1].toLowerCase()));
      const references = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z0-9_$.[\]"]+)/gi)].map((match) => match[1].replace(/["\[\]]/g, "").toLowerCase());
      if (!references.length || references.some((name) => !allowedNames.has(name) && !cteNames.has(name)))
        return NextResponse.json({ detail: "A consulta pode acessar somente as oito VIEW/TMP exibidas nos atalhos." }, { status: 422 });
      sql = limitReadQuery(dialect, sql);
      const startedAt = Date.now();
      const upstream = await fetch("https://api.mixfiscal.com.br/integrador/api/v1/query", {
        method: "POST", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: machine.machineId, task: "read-grpc", query: sql, has_limit: false }),
        cache: "no-store", signal: AbortSignal.timeout(60000),
      });
      const raw = await upstream.text();
      let decoded: unknown = raw; try { decoded = JSON.parse(raw); } catch {}
      const text = typeof decoded === "string" ? decoded : JSON.stringify(decoded);
      const rows: Record<string, unknown>[] = [];
      let remoteError = "";
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const part = JSON.parse(line);
          if (Array.isArray(part.rows)) rows.push(...part.rows.slice(0, 10 - rows.length));
          if (part.error) remoteError = String(part.error);
        } catch {}
      }
      await query(`INSERT INTO public.job_audit_logs(job_id,acao,actor_id,actor_login,detalhes) VALUES($1,'consulta_sql_remota',$2,$3,$4::jsonb)`, [item.id, user.id, user.email, JSON.stringify({ cnpj: item.cnpj, machine_id: machine.machineId, sql_sha256: createHash("sha256").update(String(body.sql || "")).digest("hex"), sql_length: String(body.sql || "").length, rows: rows.length, elapsed_ms: Date.now() - startedAt, success: upstream.ok && !remoteError })]);
      if (!upstream.ok || remoteError) return NextResponse.json({ detail: remoteError ? remoteError.slice(0, 500) : "A consulta remota falhou." }, { status: 502 });
      return NextResponse.json({ columns: rows.length ? Object.keys(rows[0]) : [], rows, count: rows.length, limited: rows.length >= 10, machine_id: machine.machineId, elapsed_ms: Date.now() - startedAt });
    }

    if (
      request.method === "GET" &&
      path[1] === "jobs" &&
      path[2] &&
      path[3] === "logs"
    ) {
      await ensureRegimeAudit();
      const scopeId = user.role === "admin" ? user.owner_id : user.id;
      const scope = user.role === "admin"
        ? `EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`
        : `f.credential_owner_id=$2`;
      const allowed = await query(
        `SELECT 1 FROM public.fila_execucao f WHERE f.id=$1 AND ${scope}`,
        [Number(path[2]), scopeId],
      );
      if (!allowed.rowCount)
        return NextResponse.json({ detail: "Job nao encontrado." }, { status: 404 });
      const result = await query(
        `SELECT id,progresso,etapa,criado_em
           FROM public.job_progress_logs
          WHERE job_id=$1 ORDER BY id DESC LIMIT 80`,
        [Number(path[2])],
      );
      return NextResponse.json({ items: result.rows.reverse() });
    }

    if (
      request.method === "POST" &&
      path[1] === "jobs" &&
      path[2] === "arquivar-lote"
    ) {
      await ensureRegimeAudit();
      const body = await request.json().catch(() => ({}));
      const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : [];
      const ids: number[] = [...new Set(
        rawIds
          .map(Number)
          .filter((id: number) => Number.isInteger(id) && id > 0),
      )].slice(0, 1000);
      if (!ids.length)
        return NextResponse.json(
          { detail: "Selecione pelo menos um trabalho." },
          { status: 422 },
        );
      const scopeId = user.role === "admin" ? user.owner_id : user.id;
      const outcome = await transaction(async (client) => {
        const scope = user.role === "admin"
          ? `EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`
          : `f.credential_owner_id=$2`;
        const found = await client.query(
          `SELECT f.id,f.status FROM public.fila_execucao f
            WHERE f.id=ANY($1::int[]) AND ${scope} FOR UPDATE OF f`,
          [ids, scopeId],
        );
        const eligible = found.rows
          .filter((item) => item.status !== "processando")
          .map((item) => Number(item.id));
        const processing = found.rows
          .filter((item) => item.status === "processando")
          .map((item) => Number(item.id));
        let removed: number[] = [];
        if (eligible.length) {
          const updated = await client.query(
            `UPDATE public.fila_execucao
                SET oculto=TRUE,
                    status=CASE WHEN status IN ('pendente','pausado') THEN 'cancelado' ELSE status END,
                    etapa='Removido da lista pelo operador',
                    mensagem_erro=CASE WHEN status IN ('pendente','pausado') THEN 'Cancelado durante exclusao segura' ELSE mensagem_erro END,
                    proxima_tentativa=NULL,
                    processado_em=COALESCE(processado_em,NOW()),
                    progresso_atualizado_em=NOW()
              WHERE id=ANY($1::int[]) RETURNING id`,
            [eligible],
          );
          removed = updated.rows.map((item) => Number(item.id));
          await client.query(
            `INSERT INTO public.job_audit_logs(job_id,acao,actor_id,actor_login,detalhes)
             SELECT unnest($1::int[]),'removeu_da_lista_em_lote',$2,$3,$4::jsonb`,
            [removed, user.id, user.email, JSON.stringify({ quantidade: removed.length })],
          );
        }
        const foundIds = new Set(found.rows.map((item) => Number(item.id)));
        return {
          removidos: removed,
          ignorados_processando: processing,
          nao_encontrados: ids.filter((id) => !foundIds.has(id)),
        };
      });
      return NextResponse.json(outcome);
    }

    if (
      request.method === "POST" &&
      path[1] === "jobs" &&
      path[2] &&
      path[3] === "cancelar-importacao"
    ) {
      await ensureRegimeAudit();
      const outcome = await transaction(async (client) => {
        const scope =
          user.role === "admin"
            ? `EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`
            : `f.credential_owner_id=$2`;
        const scopeId = user.role === "admin" ? user.owner_id : user.id;
        const result = await client.query(
          `UPDATE public.fila_execucao f SET status='cancelado',etapa='Importacao cancelada antes do inicio',mensagem_erro='Cancelado pelo operador antes do envio a Mix',processado_em=NOW(),proxima_tentativa=NULL,progresso_atualizado_em=NOW() WHERE f.id=$1 AND f.status='pendente' AND f.operacao='importar_e_gravar' AND ${scope} RETURNING f.id`,
          [Number(path[2]), scopeId],
        );
        if (!result.rowCount) return null;
        await client.query(
          `INSERT INTO public.job_audit_logs(job_id,acao,actor_id,actor_login,detalhes) VALUES($1,'cancelou_importacao_pendente',$2,$3,'{}'::jsonb)`,
          [Number(path[2]), user.id, user.email],
        );
        return result.rows[0];
      });
      return outcome
        ? NextResponse.json({ ok: true, id: outcome.id })
        : NextResponse.json(
            {
              detail:
                "A gravacao ja iniciou, foi cancelada ou nao pertence a sua equipe.",
            },
            { status: 409 },
          );
    }
    if (
      request.method === "POST" &&
      path[1] === "jobs" &&
      path[2] &&
      ["pausar", "continuar", "cancelar"].includes(path[3])
    ) {
      await ensureRegimeAudit();
      const acao = path[3];
      const resultado = await transaction(async (client) => {
        const scope =
          user.role === "admin"
            ? `EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`
            : `f.credential_owner_id=$2`;
        const scopeId = user.role === "admin" ? user.owner_id : user.id;
        if (acao === "pausar") {
          const r = await client.query(
            `UPDATE public.fila_execucao f SET status='pausado',etapa='Pausado pelo operador',proxima_tentativa=NULL,progresso_atualizado_em=NOW() WHERE f.id=$1 AND f.status='pendente' AND ${scope} RETURNING f.id`,
            [Number(path[2]), scopeId],
          );
          return r.rows[0];
        }
        if (acao === "continuar") {
          const r = await client.query(
            `UPDATE public.fila_execucao f SET status='pendente',etapa='Retomado; aguardando worker',proxima_tentativa=NOW(),progresso_atualizado_em=NOW() WHERE f.id=$1 AND f.status='pausado' AND ${scope} RETURNING f.id`,
            [Number(path[2]), scopeId],
          );
          return r.rows[0];
        }
        const atual = await client.query(
          `SELECT f.id,f.cnpj,f.execution_group_id,f.execution_order FROM public.fila_execucao f WHERE f.id=$1 AND f.status IN ('pendente','pausado') AND ${scope} FOR UPDATE OF f`,
          [Number(path[2]), scopeId],
        );
        if (!atual.rowCount) return null;
        const job = atual.rows[0];
        await client.query(
          "UPDATE public.fila_execucao SET status='cancelado',etapa='Cancelado pelo operador',mensagem_erro='Cancelado antes do inicio',processado_em=NOW(),proxima_tentativa=NULL,progresso_atualizado_em=NOW() WHERE id=$1",
          [job.id],
        );
        if (job.execution_group_id)
          await client.query(
            "UPDATE public.fila_execucao SET status='cancelado',etapa='Cancelado com o fluxo anterior',mensagem_erro='Uma etapa anterior foi cancelada',processado_em=NOW(),proxima_tentativa=NULL,progresso_atualizado_em=NOW() WHERE execution_group_id=$1 AND cnpj=$2 AND execution_order>$3 AND status IN ('pendente','pausado')",
            [job.execution_group_id, job.cnpj, job.execution_order],
          );
        return { id: job.id };
      });
      return resultado
        ? NextResponse.json({ ok: true, id: resultado.id })
        : NextResponse.json(
            { detail: "A ação não é permitida no estado atual do trabalho." },
            { status: 409 },
          );
    }

    if (
      request.method === "POST" &&
      path[1] === "jobs" &&
      path[2] &&
      path[3] === "reprocessar"
    ) {
      await requireCredential(user);
      await ensureRegimeAudit();
      const body = await request.json().catch(() => ({}));
      const outcome = await transaction(async (client) => {
        const scope =
          user.role === "admin"
            ? `EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`
            : `f.credential_owner_id=$2`;
        const scopeId = user.role === "admin" ? user.owner_id : user.id;
        const current = await client.query(
          `SELECT f.id,f.template_id,f.regime_bloqueado,f.regime_esperado,f.regime_encontrado,t.nome AS template_anterior FROM public.fila_execucao f LEFT JOIN public.templates t ON t.id=f.template_id WHERE f.id=$1 AND f.status IN ('erro','cancelado') AND ${scope} FOR UPDATE OF f`,
          [Number(path[2]), scopeId],
        );
        if (!current.rowCount)
          return { error: "Job nao encontrado ou nao pode ser reprocessado." };
        const job = current.rows[0];
        let templateId = job.template_id;
        let templateNovo = null;
        if (job.regime_bloqueado) {
          templateId = Number(body.template_id_novo);
          if (!templateId)
            return {
              error:
                "Selecione um template adequado ao regime tributario da empresa.",
            };
          const escolhido = await client.query(
            `SELECT t.id,t.nome,COALESCE(s.dados_json->'regimes_tributarios',jsonb_build_array(COALESCE(s.dados_json->>'regime_tributario','qualquer'))) AS regimes FROM public.templates t LEFT JOIN public.template_secoes s ON s.template_id=t.id AND s.chave='configuracao' WHERE t.id=$1 AND t.arquivado=FALSE`,
            [templateId],
          );
          if (!escolhido.rowCount)
            return { error: "Template selecionado nao existe mais." };
          const regimes = Array.isArray(escolhido.rows[0].regimes)
            ? escolhido.rows[0].regimes.map(String)
            : ["qualquer"];
          if (
            !regimes.includes("qualquer") &&
            !regimes.includes(job.regime_encontrado)
          )
            return {
              error:
                "O template selecionado nao permite o regime tributario identificado pela Mix Fiscal.",
            };
          templateNovo = escolhido.rows[0].nome;
        }
        const trocouTemplate = Boolean(
          job.regime_bloqueado && templateId !== job.template_id,
        );
        const result = await client.query(
          `UPDATE public.fila_execucao SET template_id=$1,status='pendente',tentativas=0,mensagem_erro=NULL,processado_em=NULL,proxima_tentativa=NOW(),credential_owner_id=$2,solicitado_por=$3,progresso=0,etapa='Aguardando worker',progresso_atualizado_em=NOW(),regime_bloqueado=FALSE,regime_divergente_autorizado=FALSE,regime_divergente_autorizado_por=NULL,regime_divergente_autorizado_em=NULL WHERE id=$4 RETURNING id,status`,
          [templateId, user.id, user.email, Number(path[2])],
        );
        await client.query(
          `INSERT INTO public.job_audit_logs(job_id,acao,actor_id,actor_login,detalhes) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [
            Number(path[2]),
            trocouTemplate ? "trocou_template_regime" : "reprocessou",
            user.id,
            user.email,
            JSON.stringify({
              template_id_anterior: job.template_id,
              template_anterior: job.template_anterior,
              template_id_novo: templateId,
              template_novo: templateNovo,
              regime_encontrado: job.regime_encontrado,
            }),
          ],
        );
        return { result: result.rows[0], trocouTemplate };
      });
      if ("error" in outcome)
        return NextResponse.json({ detail: outcome.error }, { status: 409 });
      return NextResponse.json({
        ok: true,
        id: outcome.result.id,
        template_trocado: outcome.trocouTemplate,
      });
    }

    if (
      request.method === "POST" &&
      path[1] === "jobs" &&
      path[2] &&
      path[3] === "arquivar"
    ) {
      await ensureRegimeAudit();
      const outcome = await transaction(async (client) => {
        const scope =
          user.role === "admin"
            ? `EXISTS (SELECT 1 FROM public.web_users wu WHERE wu.id=f.credential_owner_id AND COALESCE(wu.owner_id,wu.id)=$2)`
            : `f.credential_owner_id=$2`;
        const scopeId = user.role === "admin" ? user.owner_id : user.id;
        const current = await client.query(
          `SELECT f.id,f.status,f.cnpj,f.operacao FROM public.fila_execucao f WHERE f.id=$1 AND f.status<>'processando' AND ${scope} FOR UPDATE OF f`,
          [Number(path[2]), scopeId],
        );
        if (!current.rowCount) return null;
        const job = current.rows[0];
        const result = await client.query(
          `UPDATE public.fila_execucao SET oculto=TRUE,status=CASE WHEN status IN ('pendente','pausado') THEN 'cancelado' ELSE status END,etapa='Removido da lista pelo operador',mensagem_erro=CASE WHEN status IN ('pendente','pausado') THEN 'Cancelado durante exclusao segura' ELSE mensagem_erro END,proxima_tentativa=NULL,processado_em=COALESCE(processado_em,NOW()),progresso_atualizado_em=NOW() WHERE id=$1 RETURNING id`,
          [Number(path[2])],
        );
        await client.query(
          `INSERT INTO public.job_audit_logs(job_id,acao,actor_id,actor_login,detalhes) VALUES($1,'removeu_da_lista',$2,$3,$4::jsonb)`,
          [
            Number(path[2]),
            user.id,
            user.email,
            JSON.stringify({
              status_anterior: job.status,
              cnpj: job.cnpj,
              operacao: job.operacao,
            }),
          ],
        );
        return result.rows[0];
      });
      return outcome
        ? NextResponse.json({ ok: true, id: outcome.id })
        : NextResponse.json(
            { detail: "Job nao encontrado ou nao pode ser removido." },
            { status: 409 },
          );
    }

    if (request.method === "POST" && path[1] === "lotes" && !path[2]) {
      await requireCredential(user);
      const body = await request.json();
      const rawCnpjs: unknown[] = Array.isArray(body.cnpjs) ? body.cnpjs : [];
      const cnpjs: string[] = [
        ...new Set(rawCnpjs.map((item) => digits(item))),
      ];
      if (
        !body.template_id ||
        cnpjs.length < 1 ||
        cnpjs.length > 1000 ||
        cnpjs.some((item) => !validCnpj(item))
      )
        return NextResponse.json(
          { detail: "Confira o template e os CNPJs informados." },
          { status: 422 },
        );
      const result = await transaction(async (client) => {
        const templateResult = await client.query(
          "SELECT id, nome FROM public.templates WHERE id=$1 AND arquivado=FALSE",
          [Number(body.template_id)],
        );
        if (!templateResult.rowCount)
          throw new Error("Template nao encontrado.");
        const batchId = crypto.randomUUID();
        await client.query(
          "INSERT INTO public.api_lotes (id,template_id,origem,solicitado_por) VALUES ($1,$2,$3,$4)",
          [
            batchId,
            body.template_id,
            String(body.origem || "Painel web").slice(0, 120),
            session.email.slice(0, 120),
          ],
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS credential_owner_id INTEGER",
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS solicitado_por VARCHAR(180)",
        );
        const jobs = (
          await client.query(
            `
          WITH entrada AS (
            SELECT cnpj, ordem FROM unnest($1::text[]) WITH ORDINALITY AS item(cnpj, ordem)
          ), escolhidos AS (
            SELECT e.cnpj,e.ordem,ativo.id AS ativo_id
            FROM entrada e
            LEFT JOIN LATERAL (
              SELECT f.id FROM public.fila_execucao f
              WHERE f.cnpj=e.cnpj AND f.template_id=$2 AND f.credential_owner_id=$3
                AND COALESCE(f.operacao,'cadastro_template')='cadastro_template'
                AND f.status IN ('pendente','processando')
              ORDER BY f.id DESC LIMIT 1
            ) ativo ON TRUE
          ), inseridos AS (
            INSERT INTO public.fila_execucao (cnpj,template_id,operacao,credential_owner_id,solicitado_por)
            SELECT cnpj,$2,'cadastro_template',$3,$4 FROM escolhidos WHERE ativo_id IS NULL
            RETURNING id,cnpj,status
          ), consolidados AS (
            SELECT COALESCE(i.id,f.id) AS id,e.cnpj,COALESCE(i.status,f.status) AS status,(e.ativo_id IS NOT NULL) AS reutilizado,e.ordem
            FROM escolhidos e
            LEFT JOIN public.fila_execucao f ON f.id=e.ativo_id
            LEFT JOIN inseridos i ON i.cnpj=e.cnpj
          ), vinculos AS (
            INSERT INTO public.api_lote_jobs (lote_id,job_id)
            SELECT $5,id FROM consolidados ON CONFLICT DO NOTHING
          )
          SELECT id,cnpj,status,reutilizado FROM consolidados ORDER BY ordem
        `,
            [cnpjs, Number(body.template_id), user.id, user.email, batchId],
          )
        ).rows;
        return {
          lote_id: batchId,
          template: templateResult.rows[0],
          quantidade: jobs.length,
          jobs,
        };
      });
      return NextResponse.json(result, { status: 201 });
    }

    if (request.method === "POST" && path[1] === "importacoes" && !path[2]) {
      await requireCredential(user);
      const body = await request.json();
      const rawCnpjs: unknown[] = Array.isArray(body.cnpjs) ? body.cnpjs : [];
      const cnpjs = [...new Set(rawCnpjs.map((item) => digits(item)))];
      if (
        cnpjs.length < 1 ||
        cnpjs.length > 1000 ||
        cnpjs.some((item) => !validCnpj(item))
      ) {
        return NextResponse.json(
          { detail: "Confira os CNPJs informados." },
          { status: 422 },
        );
      }
      const jobs = await transaction(async (client) => {
        await client.query(
          "ALTER TABLE public.fila_execucao ALTER COLUMN template_id DROP NOT NULL",
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS operacao VARCHAR(40) NOT NULL DEFAULT 'cadastro_template'",
        );
        const created = [];
        for (const cnpj of cnpjs) {
          await client.query(
            "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS credential_owner_id INTEGER",
          );
          await client.query(
            "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS solicitado_por VARCHAR(180)",
          );
          let job = (
            await client.query(
              "SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND operacao='importar_e_gravar' AND credential_owner_id=$2 AND status IN ('pendente','processando') ORDER BY id DESC LIMIT 1",
              [cnpj, user.id],
            )
          ).rows[0];
          const reused = Boolean(job);
          if (!job)
            job = (
              await client.query(
                "INSERT INTO public.fila_execucao (cnpj,template_id,operacao,credential_owner_id,solicitado_por) VALUES ($1,NULL,'importar_e_gravar',$2,$3) RETURNING id,status",
                [cnpj, user.id, user.email],
              )
            ).rows[0];
          created.push({
            id: job.id,
            cnpj,
            status: job.status,
            reutilizado: reused,
          });
        }
        return created;
      });
      return NextResponse.json(
        { quantidade: jobs.length, operacao: "importar_e_gravar", jobs },
        { status: 201 },
      );
    }
    if (
      request.method === "POST" &&
      path[1] === "configuracoes-xml" &&
      !path[2]
    ) {
      await requireCredential(user);
      const body = await request.json();
      const rawCnpjs: unknown[] = Array.isArray(body.cnpjs) ? body.cnpjs : [];
      const cnpjs = [...new Set(rawCnpjs.map((item) => digits(item)))];
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (
        cnpjs.length < 1 ||
        cnpjs.length > 1000 ||
        cnpjs.some((item) => !validCnpj(item))
      )
        return NextResponse.json(
          { detail: "Confira os CNPJs informados." },
          { status: 422 },
        );
      if (paths.length > 30)
        return NextResponse.json(
          { detail: "O limite e de 30 caminhos por lote." },
          { status: 422 },
        );
      const normalizedPaths = paths.map((item: Record<string, unknown>) => {
        if (typeof item !== "object" || item === null)
          throw new Error("Caminho XML invalido.");
        if ("sql" in item) {
          const sql = String(item.sql || "").trim();
          if (!sql || sql.length > 10000)
            throw new Error("Confira a consulta SQL informada.");
          return item.dynamic
            ? {
                sql,
                dynamic: true,
                mesFormat: ["numerico", "extenso", "abreviado"].includes(
                  String(item.mesFormat),
                )
                  ? item.mesFormat
                  : "numerico",
                anoFormat: String(item.anoFormat) === "2" ? "2" : "4",
                caixa: ["minuscula", "capitalizada", "maiuscula"].includes(
                  String(item.caixa),
                )
                  ? item.caixa
                  : "minuscula",
              }
            : { sql };
        }
        const caminho = String(item.path || "").trim();
        if (!caminho || caminho.length > 1000)
          throw new Error("Confira o caminho XML informado.");
        return {
          path: caminho,
          type: "auto",
          recursive: Boolean(item.recursive),
        };
      });
      const payload = {
        enabled: Boolean(body.enabled),
        processXmlRealtime: Boolean(body.processXmlRealtime),
        paths: normalizedPaths,
      };
      const jobs = await transaction(async (client) => {
        await client.query(
          "ALTER TABLE public.fila_execucao ALTER COLUMN template_id DROP NOT NULL",
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb",
        );
        const created = [];
        for (const cnpj of cnpjs) {
          let job = (
            await client.query(
              "SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND operacao='configuracao_xml' AND credential_owner_id=$2 AND status IN ('pendente','processando') ORDER BY id DESC LIMIT 1",
              [cnpj, user.id],
            )
          ).rows[0];
          const reutilizado = Boolean(job);
          if (!job)
            job = (
              await client.query(
                "INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por,payload) VALUES($1,NULL,'configuracao_xml',$2,$3,$4::jsonb) RETURNING id,status",
                [cnpj, user.id, user.email, JSON.stringify(payload)],
              )
            ).rows[0];
          created.push({ id: job.id, cnpj, status: job.status, reutilizado });
        }
        return created;
      });
      return NextResponse.json(
        { quantidade: jobs.length, operacao: "configuracao_xml", jobs },
        { status: 201 },
      );
    }
    if (request.method === "POST" && path[1] === "execucoes" && !path[2]) {
      await requireCredential(user);
      const body = await request.json();
      const cnpjs: string[] = [
        ...new Set<string>(
          (Array.isArray(body.cnpjs) ? body.cnpjs : []).map((item: unknown) =>
            digits(item),
          ),
        ),
      ];
      const servicos: string[] = [
        ...new Set<string>(
          (Array.isArray(body.servicos) ? body.servicos : []).map(String),
        ),
      ];
      const somenteDivergencias = body.somente_divergencias === true;
      const permitidos = new Set<string>([
        "configuracao_conexao",
        "cadastro_template",
        "comparar_divergencias",
        "importar_e_gravar",
        "configuracao_xml",
        "scheduler",
      ]);
      if (
        cnpjs.length < 1 ||
        cnpjs.length > 1000 ||
        cnpjs.some((item) => !validCnpj(item))
      )
        return NextResponse.json(
          { detail: "Confira os CNPJs informados." },
          { status: 422 },
        );
      if (!servicos.length || servicos.some((item) => !permitidos.has(item)))
        return NextResponse.json(
          { detail: "Selecione pelo menos um servico valido." },
          { status: 422 },
        );
      const precisaTemplate =
        servicos.includes("configuracao_conexao") ||
        servicos.includes("cadastro_template") ||
        servicos.includes("comparar_divergencias") ||
        servicos.includes("configuracao_xml") ||
        servicos.includes("scheduler");
      const templateId = Number(body.template_id);
      if (precisaTemplate && !templateId)
        return NextResponse.json(
          { detail: "Selecione o template dos servicos." },
          { status: 422 },
        );
      const resultado = await transaction(async (client) => {
        const ativos = await client.query(
          "SELECT cnpj,id,operacao FROM public.fila_execucao WHERE cnpj=ANY($1::text[]) AND operacao=ANY($2::text[]) AND status IN ('pendente','processando') LIMIT 1",
          [cnpjs, servicos],
        );
        if (ativos.rowCount)
          throw new Error(
            `O CNPJ ${ativos.rows[0].cnpj} ja possui ${ativos.rows[0].operacao} no trabalho #${ativos.rows[0].id}.`,
          );
        let xml: Record<string, unknown> | null = null;
        if (precisaTemplate) {
          const template = await client.query(
            "SELECT id FROM public.templates WHERE id=$1",
            [templateId],
          );
          if (!template.rowCount) throw new Error("Template nao encontrado.");
          const section = await client.query(
            "SELECT dados_json FROM public.template_secoes WHERE template_id=$1 AND chave='configuracao_xml'",
            [templateId],
          );
          xml = section.rows[0]?.dados_json || null;
          if (servicos.includes("configuracao_conexao")) {
            const conexao = await client.query(
              `SELECT 1 FROM public.template_retaguarda_connections r
               JOIN public.web_users u ON u.id=$2
               WHERE r.template_id=$1 AND r.owner_id=COALESCE(u.owner_id,u.id)
                 AND r.senha_encrypted IS NOT NULL`,
              [templateId, user.id],
            );
            if (!conexao.rowCount)
              throw new Error("Não é possível rodar a automação pois esse template não possui dados de conexão cadastrados.");
          }
        }
        await client.query(
          "ALTER TABLE public.fila_execucao ALTER COLUMN template_id DROP NOT NULL",
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb",
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS execution_group_id UUID",
        );
        await client.query(
          "ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS execution_order SMALLINT",
        );
        const grupo = crypto.randomUUID();
        const ordemServicos = [
          "cadastro_template",
          "comparar_divergencias",
          "configuracao_xml",
          "scheduler",
          "configuracao_conexao",
          "importar_e_gravar",
        ].filter((item) => servicos.includes(item));
        const jobs = [];
        const ignorados = [];
        const schedulerConfig = xml && typeof xml.scheduler === "object" && xml.scheduler !== null
          ? (xml.scheduler as Record<string, unknown>)
          : null;
        for (const cnpj of cnpjs)
          for (const operacao of ordemServicos) {
            if (
              operacao === "configuracao_xml" &&
              (!xml || !Array.isArray(xml.paths) || xml.paths.length === 0)
            ) {
              ignorados.push({
                cnpj,
                operacao,
                motivo: "Template sem Configuracao XML",
              });
              continue;
            }
            if (operacao === "scheduler" && !schedulerConfig?.command) {
              ignorados.push({ cnpj, operacao, motivo: "Template sem Scheduler configurado" });
              continue;
            }
            const operacaoFila = operacao === "cadastro_template" && somenteDivergencias
              ? "comparar_divergencias"
              : operacao;
            const jobTemplate =
              ["configuracao_conexao", "cadastro_template", "comparar_divergencias", "configuracao_xml", "scheduler"].includes(operacao) ? templateId : null;
            const payload = operacao === "configuracao_xml"
              ? xml
              : operacao === "scheduler"
                ? schedulerConfig
                : (operacao === "cadastro_template" && somenteDivergencias) || operacao === "comparar_divergencias"
                  ? { somente_divergencias: true }
                  : {};
            const ordem = { cadastro_template: 1, comparar_divergencias: 2, configuracao_xml: 3, scheduler: 4, configuracao_conexao: 5, importar_e_gravar: 6 }[operacao] || 6;
            const job = (
              await client.query(
                "INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por,payload,execution_group_id,execution_order) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id,status",
                [
                  cnpj,
                  jobTemplate,
                  operacaoFila,
                  user.id,
                  user.email,
                  JSON.stringify(payload),
                  grupo,
                  ordem,
                ],
              )
            ).rows[0];
            jobs.push({
              id: job.id,
              cnpj,
              operacao: operacaoFila,
              status: job.status,
              reutilizado: false,
              ordem,
            });
          }
        if (!jobs.length && ignorados.length)
          throw Object.assign(new Error(String(ignorados[0].motivo)), { status: 422 });
        return { jobs, ignorados };
      });
      return NextResponse.json(
        {
          quantidade: resultado.jobs.length,
          jobs: resultado.jobs,
          ignorados: resultado.ignorados,
        },
        { status: 201 },
      );
    }
    return NextResponse.json(
      { detail: "Rota ainda nao disponivel no modo temporario." },
      { status: 404 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha interna.";
    const explicitStatus =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    console.error("Falha na integracao APP MIX:", message);
    const credentialError =
      message.includes("credencial") || message.includes("Credencial");
    return NextResponse.json(
      {
        detail:
          credentialError || explicitStatus !== null || process.env.NODE_ENV === "development"
            ? message
            : "Servico temporariamente indisponivel.",
      },
      { status: explicitStatus || (credentialError ? 422 : 500) },
    );
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
