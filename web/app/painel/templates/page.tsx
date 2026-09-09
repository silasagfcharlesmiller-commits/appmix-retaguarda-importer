"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  CircleHelp,
  Copy,
  History,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  MapPinned,
} from "lucide-react";

type Meta = { id: number; nome: string };
type Fields = {
  view_nome: string;
  view_sql: string;
  tmp_nome: string;
  tmp_delete: string;
  flag1: boolean;
  flag2: boolean;
  flag3: boolean;
  tmp_insert: string;
  tmp_values: string;
  tmp_selectwhere: string;
};
type XmlPath =
  | { path: string; type: "auto"; recursive: boolean }
  | {
      sql: string;
      dynamic?: boolean;
      mesFormat?: string;
      anoFormat?: string;
      caixa?: string;
    };
type XmlConfig = {
  enabled: boolean;
  processXmlRealtime: boolean;
  paths: XmlPath[];
  scheduler?: {
    command: string;
    schedule_time: string;
    recurrence_tag: string;
  };
};
type RetaguardaConnection = {
  nome: string; cnpj: string; banco_tipo: string; host: string; porta: string;
  banco_nome: string; usuario: string; senha: string; machine_id: string;
  servico: string; servico_mixfiscal: string; tamanho_max_mensagem: string;
  senha_cadastrada: boolean;
};
const blankConnection = (): RetaguardaConnection => ({
  nome: "Conexao do template", cnpj: "", banco_tipo: "Firebird",
  host: "localhost", porta: "3050", banco_nome: "", usuario: "", senha: "",
  machine_id: "", servico: "", servico_mixfiscal: "", tamanho_max_mensagem: "4", senha_cadastrada: false,
});
type Data = {
  configuracao: {
    regimes_tributarios: string[]; descricao: string;
    modo_regras_fiscais: "desativado" | "automatico";
    excecoes_regras_fiscais: Record<string, FiscalBehavior>;
  };
  tabelas: Record<string, Fields>;
  comparar_divergencia: Record<string, unknown>;
  excecoes_produtos: Record<string, unknown>;
  configuracao_xml: XmlConfig;
};
type Audit = {
  id: number;
  template_nome: string;
  acao: string;
  actor_login: string;
  actor_nome: string;
  actor_role: string;
  detalhes: Record<string, unknown>;
  criado_em: string;
};
type FiscalBehavior = "aplicar" | "desativar" | "herdar";
type FiscalRules = Record<string, Record<string, FiscalBehavior>>;
const managedFiscalFields: Record<string, string> = {
  "icms_saida.snc.cbenef":"cbenef", "icms_saida.snc.cbenef_alq":"cbenef_alq",
  "icms_saida.svc.fecp":"fecp", "icms_saida.snc.fecp_st":"fecp_st", "icms_saida.sas.re29560":"re29560",
};
const fiscalFieldLabels: Record<string, string> = {
  cbenef: "cBenef (SNC)", cbenef_alq: "Alíquota cBenef (SNC)",
  fecp: "FECP", fecp_st: "FECP-ST", re29560: "RE 29.560",
};
const schedulerTimeValue = (value = "") =>
  value.match(/(?:T|^)(\d{2}:\d{2})/)?.[1] || "";
const taxes = [
  ["pis_cofins", "PIS / COFINS"],
  ["icms_saida", "ICMS Saída"],
  ["icms_entrada", "ICMS Entrada"],
  ["ibs_cbs", "IBS / CBS"],
];
const blank = (): Fields => ({
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
});
type TextEditorElement = HTMLInputElement | HTMLTextAreaElement;
type ActiveSqlTarget = {
  element: TextEditorElement;
  getValue: () => string;
  change: (value: string) => void;
  selection: { start: number; end: number };
};
const activeSqlTarget: { current: ActiveSqlTarget | null } = { current: null };
const variableShortcuts = [
  { value: "{estado}", label: "estado minúsculo" },
  { value: "{ESTADO}", label: "ESTADO MAIÚSCULO" },
  { value: "{00000000000000}", label: "CNPJ (máscara)" },
  { value: "{regime_tributario}", label: "Regime Tributário" },
  { value: "{nome_empresa}", label: "Nome Empresa" },
];
function insertIntoActiveSql(text: string) {
  const target = activeSqlTarget.current;
  if (!target) return false;
  const current = target.getValue(),
    start = Math.min(target.selection.start, current.length),
    end = Math.min(target.selection.end, current.length);
  target.change(current.slice(0, start) + text + current.slice(end));
  const cursor = start + text.length;
  target.selection = { start: cursor, end: cursor };
  requestAnimationFrame(() => {
    target.element.focus();
    target.element.setSelectionRange(cursor, cursor);
  });
  return true;
}
const divergence: Record<string, Record<string, string[]>> = {
  pis_cofins: {
    "PIS / COFINS": [
      "ncm",
      "ncmex",
      "cod_natureza_receita",
      "credito_presumido",
      "pis_cst_e",
      "pis_cst_s",
      "pis_alq_e",
      "pis_alq_s",
      "cofins_cst_e",
      "cofins_cst_s",
      "cofins_alq_e",
      "cofins_alq_s",
    ],
  },
  ibs_cbs: {
    "IBS / CBS": [
      "classe_tributaria",
      "cbs_alq",
      "ibs_uf_alq",
      "ibs_mun_alq",
      "is_classe_tributaria",
      "is_alq_especifica",
      "ibs_cbs_cst",
      "cbs_alq_rbc",
      "ibs_uf_alq_rbc",
      "ibs_mun_alq_rbc",
      "is_alq",
    ],
  },
  ibs_cbs_rural: {
    "IBS / CBS Rural": [
      "classe_tributaria",
      "cbs_alq",
      "ibs_uf_alq",
      "ibs_mun_alq",
      "is_classe_tributaria",
      "is_alq_especifica",
      "ibs_cbs_cst",
      "cbs_alq_rbc",
      "ibs_uf_alq_rbc",
      "ibs_mun_alq_rbc",
      "is_alq",
    ],
  },
  ibs_cbs_gov: {
    "IBS / CBS Governo": [
      "classe_tributaria",
      "cbs_alq",
      "ibs_uf_alq",
      "ibs_mun_alq",
      "is_classe_tributaria",
      "is_alq_especifica",
      "ibs_cbs_cst",
      "cbs_alq_rbc",
      "ibs_uf_alq_rbc",
      "ibs_mun_alq_rbc",
      "is_alq",
    ],
  },
  icms_entrada: {
    EI: ["ei.cst", "ei.alq", "ei.alqst", "ei.rbc", "ei.rbcst"],
    ED: ["ed.cst", "ed.alq", "ed.alqst", "ed.rbc", "ed.rbcst"],
    ES: ["es.cst", "es.alq", "es.alqst", "es.rbc", "es.rbcst"],
    NF: ["nf.nfi_cst", "nf.nfd_cst", "nf.nfs_csosn", "nf.alq"],
    "Outros ICMS": [
      "outros_icms.mva",
      "outros_icms.tipo_mva",
      "outros_icms.mva_data_ini",
      "outros_icms.mva_data_fim",
      "outros_icms.cred_outorgado",
      "outros_icms.gera_debito",
      "outros_icms.sub_rbc_alq",
    ],
  },
  icms_saida: {
    SAC: [
      "sac.cst",
      "sac.alq",
      "sac.alqst",
      "sac.rbc",
      "sac.rbcst",
      "sac.cbenef",
      "sac.cbenef_alq",
      "sac.cest",
    ],
    SAS: [
      "sas.cst",
      "sas.alq",
      "sas.alqst",
      "sas.rbc",
      "sas.rbcst",
      "sas.cbenef",
      "sas.cbenef_alq",
      "sas.re29560",
    ],
    SVC: [
      "svc.cst",
      "svc.alq",
      "svc.alqst",
      "svc.rbc",
      "svc.rbcst",
      "svc.cbenef",
      "svc.cbenef_alq",
      "svc.fecp",
    ],
    SNC: [
      "snc.cst",
      "snc.alq",
      "snc.alqst",
      "snc.rbc",
      "snc.rbcst",
      "snc.cbenef",
      "snc.cbenef_alq",
      "snc.fecp_st",
    ],
    "Simples Nacional": [
      "simples_nacional.sss_csosn",
      "simples_nacional.svc_csosn",
      "simples_nacional.snc_csosn",
    ],
  },
};
const divergenceMasters = [
  { key: "pis", title: "PIS / COFINS", sections: ["pis_cofins"] },
  {
    key: "ibs",
    title: "IBS / CBS",
    sections: ["ibs_cbs", "ibs_cbs_rural", "ibs_cbs_gov"],
  },
  { key: "entrada", title: "ICMS de Entrada", sections: ["icms_entrada"] },
  { key: "saida", title: "ICMS de Saída", sections: ["icms_saida"] },
];
function getDeep(obj: Record<string, unknown>, path: string) {
  return (
    path
      .split(".")
      .reduce((o, k) => (o as Record<string, unknown>)?.[k], obj as unknown) ===
    true
  );
}
function setDeep(obj: Record<string, unknown>, path: string, value: boolean) {
  const keys = path.split(".");
  let cur = obj;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else
      cur =
        (cur[k] as Record<string, unknown>) ||
        ((cur[k] = {}) as Record<string, unknown>);
  });
}

export default function TemplatesPage() {
  const [items, setItems] = useState<Meta[]>([]),
    [selected, setSelected] = useState<number>(),
    [data, setData] = useState<Data>(),
    [loadingTemplate, setLoadingTemplate] = useState(false),
    [message, setMessage] = useState(""),
    [expandAll, setExpandAll] = useState(false),
    [open, setOpen] = useState(""),
    [divergenceOpen, setDivergenceOpen] = useState(false),
    [xmlOpen, setXmlOpen] = useState(false),
    [schedulerOpen, setSchedulerOpen] = useState(false),
    [connectionOpen, setConnectionOpen] = useState(false),
    [connection, setConnection] = useState<RetaguardaConnection>(blankConnection()),
    [openMasters, setOpenMasters] = useState<string[]>(
      divergenceMasters.map((master) => master.key),
    );
  const [isMaster, setIsMaster] = useState(false),
    [auditOpen, setAuditOpen] = useState(false),
    [fiscalHelpOpen, setFiscalHelpOpen] = useState(false),
    [audits, setAudits] = useState<Audit[]>([]);
  const [fiscalRules, setFiscalRules] = useState<FiscalRules>({}),
    [previewUf, setPreviewUf] = useState("");
  async function list(select?: number) {
    const r = await fetch("/api/mix/v1/templates");
    const j = await r.json();
    setItems(j.items || []);
    if (select) setSelected(select);
  }
  async function loadAudit() {
    const r = await fetch("/api/mix/v1/template-audit", { cache: "no-store" });
    if (r.ok) setAudits((await r.json()).items || []);
  }
  useEffect(() => {
    void list();
    fetch("/api/mix/v1/regras-fiscais-uf", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((body) => body && setFiscalRules(Object.fromEntries((body.items || []).map((item: {uf:string; regras_json:Record<string,FiscalBehavior>}) => [item.uf.trim(), item.regras_json]))));
    fetch("/api/profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((profile) => {
        const master = Boolean(
          profile &&
          profile.role === "admin" &&
          profile.id === profile.owner_id,
        );
        setIsMaster(master);
        if (master) void loadAudit();
      });
  }, []);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let active = true;
    setData(undefined);
    setPreviewUf("");
    setLoadingTemplate(true);
    fetch(`/api/mix/v1/templates/${selected}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Nao foi possivel carregar o template.");
        return r.json();
      })
      .then((j) => {
        const tables = j.dados?.tabelas || {};
        for (const [k] of taxes)
          tables[k] = { ...blank(), ...(tables[k] || {}) };
        const saved = j.dados?.configuracao?.regimes_tributarios;
        const legacy = j.dados?.configuracao?.regime_tributario;
        setData({
          configuracao: {
            regimes_tributarios:
              Array.isArray(saved) && saved.length
                ? saved
                : [legacy || "qualquer"],
            descricao: String(j.dados?.configuracao?.descricao || ""),
            modo_regras_fiscais: j.dados?.configuracao?.modo_regras_fiscais === "automatico" ? "automatico" : "desativado",
            excecoes_regras_fiscais: j.dados?.configuracao?.excecoes_regras_fiscais || {},
          },
          tabelas: tables,
          comparar_divergencia: j.dados?.comparar_divergencia || {},
          excecoes_produtos: j.dados?.excecoes_produtos || {},
          configuracao_xml: j.dados?.configuracao_xml || {
            enabled: true,
            processXmlRealtime: false,
            paths: [],
            scheduler: { command: "", schedule_time: "", recurrence_tag: "" },
          },
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Falha ao carregar template.");
      })
      .finally(() => {
        if (active) setLoadingTemplate(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    fetch(`/api/mix/v1/templates/${selected}/conexao-retaguarda`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Falha ao carregar a conexao."))))
      .then((j) => setConnection(j.item ? { ...blankConnection(), ...j.item, porta: String(j.item.porta), tamanho_max_mensagem: String(j.item.tamanho_max_mensagem || 4), senha: "" } : blankConnection()))
      .catch((error) => setMessage(error instanceof Error ? error.message : "Falha ao carregar a conexao."));
  }, [selected]);
  function field(tax: string, key: keyof Fields, value: string | boolean) {
    setData((d) =>
      d
        ? {
            ...d,
            tabelas: {
              ...d.tabelas,
              [tax]: { ...d.tabelas[tax], [key]: value },
            },
          }
        : d,
    );
  }
  function append(tax: string, key: keyof Fields, text: string) {
    field(
      tax,
      key,
      String(data?.tabelas[tax][key] || "") +
        (data?.tabelas[tax][key] ? " " : "") +
        text,
    );
  }
  function toggleRegime(regime: string, checked: boolean) {
    setData((current) => {
      if (!current) return current;
      if (regime === "qualquer")
        return {
          ...current,
          configuracao: {
            ...current.configuracao,
            regimes_tributarios: checked ? ["qualquer"] : ["lucro_real"],
          },
        };
      const base = current.configuracao.regimes_tributarios.filter(
        (item) => item !== "qualquer",
      );
      const next = checked
        ? [...new Set([...base, regime])]
        : base.filter((item) => item !== regime);
      return {
        ...current,
        configuracao: {
          ...current.configuracao,
          regimes_tributarios: next.length ? next : ["qualquer"],
        },
      };
    });
  }
  function xmlChange(patch: Partial<XmlConfig>) {
    setData((current) =>
      current
        ? {
            ...current,
            configuracao_xml: { ...current.configuracao_xml, ...patch },
          }
        : current,
    );
  }
  function xmlPath(index: number, patch: Record<string, unknown>) {
    if (!data) return;
    xmlChange({
      paths: data.configuracao_xml.paths.map((item, i) =>
        i === index ? ({ ...item, ...patch } as XmlPath) : item,
      ),
    });
  }
  async function copyName(value: string) {
    if (!value) return setMessage("Esta tabela ainda não possui nome.");
    await navigator.clipboard.writeText(value);
    setMessage(`Nome copiado: ${value}`);
  }
  async function create(copy: boolean) {
    const nome = prompt("Nome do novo template:")?.trim();
    if (!nome) return;
    const r = await fetch("/api/mix/v1/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, copiar_de: copy ? selected : null }),
    });
    const j = await r.json();
    if (!r.ok) return setMessage(j.detail);
    setMessage(copy ? "Template copiado." : "Template criado do zero.");
    await list(j.id);
    if (isMaster) await loadAudit();
  }
  async function save() {
    if (!selected || !data) return;
    const r = await fetch(`/api/mix/v1/templates/${selected}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dados: data }),
    });
    if (!r.ok) return setMessage((await r.json()).detail || "Nao foi possivel salvar o template.");
    const connectionComplete = [connection.banco_nome, connection.usuario].every((value) => String(value ?? "").trim()) &&
      (Boolean(connection.senha_cadastrada) || Boolean(String(connection.senha ?? "").trim()));
    if (connectionComplete) {
      const connectionResponse = await fetch(`/api/mix/v1/templates/${selected}/conexao-retaguarda`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(connection),
      });
      const result = await connectionResponse.json();
      if (!connectionResponse.ok) return setMessage(result.detail || "O template foi salvo, mas a conexao nao.");
      setConnection({ ...connection, ...result.item, porta: String(result.item.porta), tamanho_max_mensagem: String(result.item.tamanho_max_mensagem || 4), senha: "" });
    }
    setMessage(connectionComplete ? "Template e dados de conexao salvos." : "Template salvo. Preencha banco, usuario e senha para salvar a conexao.");
    if (isMaster) await loadAudit();
  }
  async function remove() {
    const current = items.find((i) => i.id === selected);
    if (!current) return;
    const typed = prompt(
      `Para excluir o template "${current.nome}", digite exatamente o nome abaixo:\n\n${current.nome}`,
    );
    if (typed !== current.nome)
      return (
        typed !== null &&
        setMessage("O nome digitado não confere. Template não excluído.")
      );
    const r = await fetch(`/api/mix/v1/templates/${selected}`, {
      method: "DELETE",
    });
    const j = await r.json();
    if (!r.ok) return setMessage(j.detail);
    setSelected(undefined);
    setData(undefined);
    await list();
    if (isMaster) await loadAudit();
    setMessage(`Template "${current.nome}" excluído.`);
  }
  return (
    <main className="editor-page">
      <header className="editor-header">
        <div>
          <a href="/painel" className="back">
            <ArrowLeft size={17} /> Voltar ao painel
          </a>
          <span className="eyebrow dark">CONFIGURAÇÕES</span>
          <h1>Templates fiscais</h1>
          <p>Crie e mantenha as regras utilizadas pelo worker.</p>
        </div>
        <div className="editor-actions">
          <a className="editor-link-button" href="/painel/regras-fiscais"><MapPinned size={17} /> Regras por UF</a>
          {isMaster && (
            <button
              className="master-audit-button"
              onClick={() => setAuditOpen(!auditOpen)}
            >
              <History size={17} /> Auditoria
            </button>
          )}
          <button onClick={() => create(false)}>
            <Plus size={17} /> Novo
          </button>
          <button onClick={() => create(true)} disabled={!selected}>
            <Copy size={17} /> Copiar atual
          </button>
          <button onClick={() => setExpandAll(!expandAll)}>
            {expandAll ? <ChevronUp size={17} /> : <ChevronDown size={17} />}{" "}
            {expandAll ? "Recolher tudo" : "Expandir tudo"}
          </button>
          <button
            className="danger-outline"
            onClick={remove}
            disabled={!selected}
          >
            <Trash2 size={17} />
          </button>
          <button
            className="primary-button compact"
            onClick={save}
            disabled={!data}
          >
            <Save size={17} /> Salvar
          </button>
        </div>
      </header>
      {message && (
        <div
          className="template-message-backdrop"
          role="presentation"
          onMouseDown={() => setMessage("")}
        >
          <section
            className="template-message-box"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="template-message-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="template-message-icon">
              <Check size={24} />
            </div>
            <h2 id="template-message-title">Aviso do template</h2>
            <p>{message}</p>
            <button
              type="button"
              className="primary-button"
              autoFocus
              onClick={() => setMessage("")}
            >
              OK
            </button>
          </section>
        </div>
      )}
      {fiscalHelpOpen && (
        <div className="modal-backdrop" onMouseDown={() => setFiscalHelpOpen(false)}>
          <section className="modal fiscal-help-modal" role="dialog" aria-modal="true" aria-labelledby="fiscal-help-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="fiscal-help-title"><CircleHelp size={28}/><div><span className="eyebrow dark">INSTRUÇÕES</span><h2 id="fiscal-help-title">Regras fiscais por UF</h2></div></div>
            <p>O mesmo template pode atender lojas de vários estados. Em cada job, a API identifica a UF real do CNPJ e o worker combina o template-base, a regra da UF e as exceções específicas da retaguarda.</p>
            <div className="fiscal-mode-options">
              <article><b>1</b><div><strong>Não aplicar — manter o template</strong><p>Todos os clientes recebem exatamente os checkboxes salvos no template, independentemente da UF.</p></div></article>
              <article><b>2</b><div><strong>Aplicar automaticamente</strong><p>Cada CNPJ recebe as cinco flags conforme sua UF. Os demais impostos, VIEWs e TMPs continuam seguindo o template.</p></div></article>
              <article><b>3</b><div><strong>Exceções do template</strong><p>“Sempre marcado” ou “Sempre desmarcado” tem prioridade sobre a UF apenas neste template. Os campos em “Seguir regra da UF” continuam automáticos.</p></div></article>
            </div>
            <p className="fiscal-help-note">Use “Pré-visualizar regras para a UF” para conferir o valor final e a origem de cada campo antes de salvar. Para incluir ou remover estados, abra <a href="/painel/regras-fiscais">Regras por UF</a>.</p>
            <button type="button" className="primary-button" onClick={() => setFiscalHelpOpen(false)}>Entendi</button>
          </section>
        </div>
      )}
      {isMaster && auditOpen && (
        <section className="template-audit">
          <div className="template-audit-title">
            <div>
              <span className="eyebrow dark">ACESSO EXCLUSIVO</span>
              <h2>
                <ShieldCheck size={21} /> Auditoria do administrador master
              </h2>
              <p>
                Registro permanente das criações, alterações e exclusões de
                templates.
              </p>
            </div>
            <button onClick={loadAudit}>
              <History size={16} /> Atualizar
            </button>
          </div>
          <div className="audit-list">
            {audits.length === 0 ? (
              <p>Nenhuma alteração registrada ainda.</p>
            ) : (
              audits.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.actor_nome}</strong>
                    <span>
                      {item.acao} o template <b>{item.template_nome}</b>
                    </span>
                    <small>
                      {item.actor_login} ·{" "}
                      {item.actor_role === "admin"
                        ? "Administrador"
                        : "Colaborador"}{" "}
                      · {new Date(item.criado_em).toLocaleString("pt-BR")}
                    </small>
                  </div>
                  <details>
                    <summary>Ver dados da alteração</summary>
                    <pre>{JSON.stringify(item.detalhes, null, 2)}</pre>
                  </details>
                </article>
              ))
            )}
          </div>
        </section>
      )}
      <section className="template-picker">
        <label>
          Template ativo
          <select
            value={selected || ""}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            <option value="" disabled>
              Selecione
            </option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nome}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <div className="checks flag-panel">
            <label>
              Descrição de uso
              <textarea rows={2} value={data.configuracao.descricao} onChange={(event) => setData((current) => current ? { ...current, configuracao: { ...current.configuracao, descricao: event.target.value } } : current)} placeholder="Explique quando este template deve ser utilizado." />
            </label>
            <strong>REGIMES TRIBUTÁRIOS PERMITIDOS</strong>
            <CheckBox
              text="Todos (sem bloqueio)"
              checked={data.configuracao.regimes_tributarios.includes(
                "qualquer",
              )}
              change={(v) => toggleRegime("qualquer", v)}
            />
            <CheckBox
              text="Lucro Real"
              checked={data.configuracao.regimes_tributarios.includes(
                "lucro_real",
              )}
              change={(v) => toggleRegime("lucro_real", v)}
            />
            <CheckBox
              text="Lucro Presumido"
              checked={data.configuracao.regimes_tributarios.includes(
                "lucro_presumido",
              )}
              change={(v) => toggleRegime("lucro_presumido", v)}
            />
            <CheckBox
              text="Simples Nacional"
              checked={data.configuracao.regimes_tributarios.includes(
                "simples_nacional",
              )}
              change={(v) => toggleRegime("simples_nacional", v)}
            />
            <div className="fiscal-mode-heading"><strong>REGRAS FISCAIS POR UF</strong><button type="button" onClick={() => setFiscalHelpOpen(true)}><CircleHelp size={15}/> Como funciona?</button></div>
            <label>Modo de aplicação
              <select value={data.configuracao.modo_regras_fiscais} onChange={(event) => setData((current) => current ? ({ ...current, configuracao: { ...current.configuracao, modo_regras_fiscais: event.target.value as Data["configuracao"]["modo_regras_fiscais"] } }) : current)}>
                <option value="desativado">Não aplicar — manter o template</option>
                <option value="automatico">Aplicar automaticamente</option>
              </select>
              <small>O worker consulta a UF de cada CNPJ. Templates existentes permanecem desativados até você alterar esta opção.</small>
            </label>
            {data.configuracao.modo_regras_fiscais !== "desativado" && <label className="uf-preview-control"><span>PRÉ-VISUALIZAR REGRAS POR UF</span>
              <select value={previewUf} onChange={(event) => {
                const uf = event.target.value;
                setPreviewUf(uf);
                if (!uf) return;
                setDivergenceOpen(true);
                setOpenMasters(["saida"]);
                setTimeout(() => document.getElementById("divergencia-saida")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
              }}>
                <option value="">Escolha uma UF para visualizar</option>
                {Object.keys(fiscalRules).sort().map((uf) => <option key={uf}>{uf}</option>)}
              </select><small>Somente visual: não salva uma UF no template. No job, o worker usa a UF real consultada pelo CNPJ. <a href="/painel/regras-fiscais">Adicionar ou remover estados em Regras por UF →</a></small>
            </label>}
            {data.configuracao.modo_regras_fiscais !== "desativado" && <section className="template-fiscal-overrides">
              <div><strong>EXCEÇÕES DESTE TEMPLATE</strong><small>Use somente quando esta retaguarda precisar contrariar a regra estadual. “Seguir regra da UF” é o padrão seguro.</small></div>
              <div className="template-fiscal-override-grid">
                {Object.entries(fiscalFieldLabels).map(([field, label]) => <label key={field}><span>{label}</span>
                  <select value={data.configuracao.excecoes_regras_fiscais[field] || "herdar"} onChange={(event) => setData((current) => current ? ({...current, configuracao:{...current.configuracao, excecoes_regras_fiscais:{...current.configuracao.excecoes_regras_fiscais, [field]:event.target.value as FiscalBehavior}}}) : current)}>
                    <option value="herdar">Seguir regra da UF</option>
                    <option value="aplicar">Sempre marcado</option>
                    <option value="desativar">Sempre desmarcado</option>
                  </select>
                </label>)}
              </div>
              <p><strong>Exemplo HSF:</strong> selecione “Sempre desmarcado” em FECP e FECP-ST. Os outros impostos continuarão seguindo normalmente o estado do CNPJ.</p>
            </section>}
          </div>
        )}
        <div className="rule-hint variable-shortcuts">
          <Sparkles size={18} />
          <span>Atalhos de inserção:</span>
          {variableShortcuts.map(({ value, label }) => (
            <button
              type="button"
              key={value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                insertIntoActiveSql(value) ||
                setMessage(
                  "Clique primeiro em qualquer caixa de texto e posicione o cursor onde deseja inserir a variável.",
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      {!data ? (
        <div className="empty-editor">
          {loadingTemplate ? "Carregando template..." : "Selecione ou crie um template."}
        </div>
      ) : (
        <>
          <div className="auto-rule-note">
            <Sparkles size={20} />
            <div>
              <strong>Proteções automáticas por cliente</strong>
              <p>
                As regras <code>codigo_produto IN</code>,{" "}
                <code>codigo_produto NOT IN</code> e a trava <code>1=2</code>{" "}
                são identificadas no momento do processamento e preservadas pelo
                worker. Não precisam ser cadastradas no template.
              </p>
            </div>
          </div>
          <section className="tax-list">
            {taxes.map(([key, label]) => {
              const f = data.tabelas[key];
              const visible = expandAll || open === key;
              return (
                <article className="tax-editor" key={key}>
                  <div className="tax-title">
                    <button
                      className="tax-toggle"
                      type="button"
                      onClick={() => setOpen(open === key ? "" : key)}
                    >
                      <strong>{label}</strong>
                      {visible ? <ChevronUp /> : <ChevronDown />}
                    </button>
                    <div className="tax-summary">
                      <span>
                        <b>VIEW</b>
                        <em>{f.view_nome || "Não informado"}</em>
                        <button
                          type="button"
                          title="Copiar nome da VIEW"
                          onClick={() => copyName(f.view_nome)}
                        >
                          <Copy size={14} />
                        </button>
                      </span>
                      <span>
                        <b>TMP</b>
                        <em>{f.tmp_nome || "Não informado"}</em>
                        <button
                          type="button"
                          title="Copiar nome da TMP"
                          onClick={() => copyName(f.tmp_nome)}
                        >
                          <Copy size={14} />
                        </button>
                      </span>
                    </div>
                  </div>
                  {visible && (
                    <div className="tax-body">
                      <div className="editor-columns">
                        <div className="sql-card view-card">
                          <h3>TABELA VIEW</h3>
                          <Field
                            label="Nome da tabela VIEW"
                            value={f.view_nome}
                            change={(v) => field(key, "view_nome", v)}
                          />
                          <Sql
                            label="SELECT de consulta da VIEW"
                            value={f.view_sql}
                            change={(v) => field(key, "view_sql", v)}
                            insert={(t) => append(key, "view_sql", t)}
                          />
                        </div>
                        <div className="sql-card tmp-card">
                          <h3>TABELA TMP</h3>
                          <Field
                            label="Nome da tabela TMP"
                            value={f.tmp_nome}
                            change={(v) => field(key, "tmp_nome", v)}
                          />
                          <Sql
                            label="DELETE dos itens"
                            value={f.tmp_delete}
                            change={(v) => field(key, "tmp_delete", v)}
                            insert={(t) => append(key, "tmp_delete", t)}
                          />
                          <div className="checks flag-panel">
                            <strong>REGRAS DE GRAVAÇÃO</strong>
                            <CheckBox
                              text="Zerar TMP antes de sincronizar"
                              checked={f.flag1}
                              change={(v) => field(key, "flag1", v)}
                            />
                            <CheckBox
                              text="Gravar apenas aprovados"
                              checked={f.flag2}
                              change={(v) => field(key, "flag2", v)}
                            />
                            <CheckBox
                              text="Gravar todos classificados"
                              checked={f.flag3}
                              change={(v) => field(key, "flag3", v)}
                            />
                          </div>
                          <Sql
                            label="INSERT na tabela temporária"
                            value={f.tmp_insert}
                            change={(v) => field(key, "tmp_insert", v)}
                            insert={(t) => append(key, "tmp_insert", t)}
                          />
                          <Sql
                            label="VALUES do INSERT"
                            value={f.tmp_values}
                            change={(v) => field(key, "tmp_values", v)}
                            insert={(t) => append(key, "tmp_values", t)}
                          />
                          <Sql
                            label="SELECT / WHERE para gravação"
                            value={f.tmp_selectwhere}
                            change={(v) => field(key, "tmp_selectwhere", v)}
                            insert={(t) => append(key, "tmp_selectwhere", t)}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
          <section className="divergence-card" id="comparar-divergencia">
            <button
              className="divergence-title"
              onClick={() => setDivergenceOpen(!divergenceOpen)}
            >
              <div>
                <span className="eyebrow dark">COMPARAR DIVERGÊNCIA</span>
                <h2>Campos monitorados</h2>
                <p>Organizados conforme a hierarquia fiscal do Mix Fiscal.</p>
              </div>
              {divergenceOpen ? <ChevronUp /> : <ChevronDown />}
            </button>
            {divergenceOpen && (
              <>
                {previewUf && <div className="preview-result-banner"><MapPinned size={18}/><span><strong>Resultado previsto para {previewUf}</strong><small>Os destaques mostram o valor final e sua origem: regra da UF ou exceção deste template.</small></span><a href="/painel/regras-fiscais">Editar estados</a></div>}
                <div className="divergence-toolbar">
                  <div className="field-type-legend"><span><i className="standard"/> Imposto padrão do template</span><span><i className="state"/> Imposto que varia por UF</span></div>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenMasters(
                        openMasters.length === divergenceMasters.length
                          ? []
                          : divergenceMasters.map((master) => master.key),
                      )
                    }
                  >
                    {openMasters.length === divergenceMasters.length ? (
                      <>
                        <ChevronUp size={16} /> Recolher tudo
                      </>
                    ) : (
                      <>
                        <ChevronDown size={16} /> Expandir tudo
                      </>
                    )}
                  </button>
                </div>
                <div className="divergence-masters">
                  {divergenceMasters.map((master) => {
                    const masterOpen = openMasters.includes(master.key);
                    return (
                      <article className="divergence-master" key={master.key} id={`divergencia-${master.key}`}>
                        <button
                          className="master-title"
                          type="button"
                          onClick={() =>
                            setOpenMasters((current) =>
                              masterOpen
                                ? current.filter((key) => key !== master.key)
                                : [...current, master.key],
                            )
                          }
                        >
                          <span>{master.title}</span>
                          {masterOpen ? (
                            <ChevronUp size={19} />
                          ) : (
                            <ChevronDown size={19} />
                          )}
                        </button>
                        {masterOpen && (
                          <div className="master-grid">
                            {master.sections.flatMap((section) =>
                              Object.entries(divergence[section]).map(
                                ([group, fields]) => (
                                  <div
                                    className="divergence-subcard"
                                    key={section + group}
                                  >
                                    <h4>{group}</h4>
                                    <div className="compact-checks">
                                      {fields.map((path) => {
                                        const full = `${section}.${path}`;
                                        const fiscalField = managedFiscalFields[full];
                                        const templateOverride = fiscalField ? data.configuracao.excecoes_regras_fiscais[fiscalField] : "herdar";
                                        const stateBehavior = fiscalField ? fiscalRules[previewUf]?.[fiscalField] : "herdar";
                                        const behavior = data.configuracao.modo_regras_fiscais !== "desativado" && fiscalField
                                          ? (templateOverride === "aplicar" || templateOverride === "desativar" ? templateOverride : stateBehavior) : "herdar";
                                        const controlled = behavior === "aplicar" || behavior === "desativar";
                                        const overrideControlled = controlled && (templateOverride === "aplicar" || templateOverride === "desativar");
                                        return (
                                          <CheckBox
                                            key={full}
                                            text={path
                                              .split(".")
                                              .pop()!
                                              .replaceAll("_", " ")
                                              .toUpperCase()}
                                            checked={controlled ? behavior === "aplicar" : getDeep(data.comparar_divergencia, full)}
                                            disabled={controlled}
                                            highlighted={controlled}
                                            exceptionHighlighted={overrideControlled}
                                            stateVariable={Boolean(fiscalField)}
                                            hint={controlled ? `${behavior === "aplicar" ? "Marcado" : "Desmarcado"} · ${overrideControlled ? "Exceção do template" : `Regra de ${previewUf}`}` : fiscalField ? "Varia por UF" : undefined}
                                            change={(v) => {
                                              const next = structuredClone(
                                                data.comparar_divergencia,
                                              );
                                              setDeep(next, full, v);
                                              setData({
                                                ...data,
                                                comparar_divergencia: next,
                                              });
                                            }}
                                          />
                                        );
                                      })}
                                    </div>
                                  </div>
                                ),
                              ),
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </section>
          <XmlEditor
            data={data.configuracao_xml}
            open={xmlOpen}
            setOpen={setXmlOpen}
            change={xmlChange}
            changePath={xmlPath}
          />
          <SchedulerEditor data={data.configuracao_xml} open={schedulerOpen} setOpen={setSchedulerOpen} change={xmlChange} />
          <section className="divergence-card retaguarda-card">
            <button className="divergence-title" type="button" onClick={() => setConnectionOpen(!connectionOpen)}>
              <div>
                <span className="eyebrow dark">DADOS DE CONEXAO</span>
                <h2>Conexao do Integrador</h2>
                <p>Mesmo formato do App Mix; a senha permanece criptografada.</p>
              </div>
              {connectionOpen ? <ChevronUp /> : <ChevronDown />}
            </button>
            {connectionOpen && (
              <div className="retaguarda-body">
                <div className="retaguarda-grid">
                  {([
                    ["Host", "host", "text"], ["Porta", "porta", "number"],
                  ] as const).map(([label, key, type]) => (
                    <label key={key}>
                      {label}
                      <input type={type} value={String(connection[key] ?? "")}
                        onChange={(e) => setConnection({ ...connection, [key]: e.target.value })} />
                    </label>
                  ))}
                  <label>
                    Dialeto
                    <select value={connection.banco_tipo ?? ""} onChange={(e) => {
                      const banco_tipo = e.target.value;
                      const portas: Record<string,string> = { PostgreSQL:"5432", MySQL:"3306", MariaDB:"3306", SQLite:"0", "SQL Server":"1433", Oracle:"1521", Firebird:"3050" };
                      setConnection({ ...connection, banco_tipo, porta: portas[banco_tipo] || connection.porta });
                    }}>
                      {['PostgreSQL','MySQL','MariaDB','SQLite','SQL Server','Oracle','Firebird'].map((dialeto) => <option key={dialeto}>{dialeto}</option>)}
                    </select>
                  </label>
                  {([
                    ["Banco de dados", "banco_nome", "text"],
                    ["Usuario do banco", "usuario", "text"], ["Senha do banco", "senha", "password"],
                    ["Servico", "servico", "text"], ["Servico Mixfiscal", "servico_mixfiscal", "text"],
                    ["Tamanho max. mensagem (MB)", "tamanho_max_mensagem", "number"],
                  ] as const).map(([label, key, type]) => (
                    <label key={key}>
                      {label}
                      <input type={type} value={String(connection[key] ?? "")}
                        placeholder={key === "senha" && connection.senha_cadastrada ? "Senha ja cadastrada; deixe vazio para manter" : ""}
                        onChange={(e) => setConnection({ ...connection, [key]: e.target.value })} />
                    </label>
                  ))}
                </div>
                <div className="retaguarda-actions">
                  <p>O CNPJ vem da automacao; todos os Machine IDs encontrados serao configurados e testados.</p>
                </div>
              </div>
            )}
          </section>
          <button className="primary-button save-bottom" onClick={save}>
            <Check size={18} /> Salvar todas as alterações
          </button>
        </>
      )}
    </main>
  );
}
function XmlEditor({
  data,
  open,
  setOpen,
  change,
  changePath,
}: {
  data: XmlConfig;
  open: boolean;
  setOpen: (v: boolean) => void;
  change: (v: Partial<XmlConfig>) => void;
  changePath: (i: number, v: Record<string, unknown>) => void;
}) {
  return (
    <section className="divergence-card xml-template-card">
      <button
        className="divergence-title"
        type="button"
        onClick={() => setOpen(!open)}
      >
        <div>
          <span className="eyebrow orange">CONFIGURAÇÃO XML</span>
          <h2>Padrão XML do template</h2>
          <p>
            Opcional. Sem caminhos cadastrados, o serviço XML será ignorado.
          </p>
        </div>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && (
        <div className="xml-template-body">
          <div className="xml-switches">
            <CheckBox
              text="Observador habilitado"
              checked={data.enabled}
              change={(v) => change({ enabled: v })}
            />
            <CheckBox
              text="Processar XML em tempo real"
              checked={data.processXmlRealtime}
              change={(v) => change({ processXmlRealtime: v })}
            />
          </div>
          <div className="xml-title">
            <strong>Caminhos e consultas SQL</strong>
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                change({
                  paths: [
                    ...data.paths,
                    { path: "", type: "auto", recursive: true },
                  ],
                })
              }
            >
              <Plus size={16} /> Adicionar
            </button>
          </div>
          {false && <div className="xml-path" style={{ order: 5 }}>
            <div className="section-label"><Clock3 size={16} /><strong>Scheduler do XML (opcional)</strong></div>
            <small className="muted">Ao aplicar esta configuração XML, o comando será replicado para cada Machine ID do cliente. Deixe os campos vazios para não agendar nada.</small>
            <div className="xml-options" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <label>Comando<select value={data.scheduler?.command || ""} onChange={e => change({ scheduler: { ...(data.scheduler || { schedule_time: "", recurrence_tag: "unica_vez" }), command: e.target.value } })}><option value="">Nenhum</option><option>RESTART_NOW</option><option>UPDATE_DESKTOP_CLIENT</option><option>FORCE_RESEND_XML</option><option>PROCESS_XML_CLIENT</option></select></label>
              <label>Horário<input type="time" value={schedulerTimeValue(data.scheduler?.schedule_time)} onChange={e => change({ scheduler: { ...(data.scheduler || { command: "", recurrence_tag: "unica_vez" }), schedule_time: e.target.value } })} /></label>
              <label>Recorrência<select value={data.scheduler?.recurrence_tag || "unica_vez"} onChange={e => change({ scheduler: { ...(data.scheduler || { command: "", schedule_time: "" }), recurrence_tag: e.target.value } })}><option value="unica_vez">Única vez</option><option value="diaria">Diário</option><option value="semanal">Semanal</option><option value="quinzenal">Quinzenal</option></select></label>
            </div>
          </div>}
          {data.paths.length === 0 && (
            <p className="muted">
              Nenhuma configuração XML cadastrada. Esta etapa não será
              executada.
            </p>
          )}
          <div className="xml-paths" style={{ order: 4 }}>
            {data.paths.map((item, index) => {
              const sql = "sql" in item;
              return (
                <article className="xml-path" key={index}>
                  {sql ? (
                    <label>
                      Consulta SQL
                      <textarea
                        rows={4}
                        value={item.sql}
                        onChange={(e) =>
                          changePath(index, { sql: e.target.value })
                        }
                      />
                    </label>
                  ) : (
                    <div className="xml-options">
                      <label>
                        Caminho
                        <input
                          value={item.path}
                          onChange={(e) =>
                            changePath(index, { path: e.target.value })
                          }
                          placeholder="C:\\Caminho\\Dos\\Xmls"
                        />
                      </label>
                      <label>
                        Tipo
                        <input value="auto" readOnly />
                      </label>
                      <CheckBox
                        text="Recursivo"
                        checked={item.recursive}
                        change={(v) => changePath(index, { recursive: v })}
                      />
                    </div>
                  )}
                  <div className="xml-row-actions">
                    <CheckBox
                      text="Via SQL"
                      checked={sql}
                      change={(v) =>
                        change({
                          paths: data.paths.map((current, i) =>
                            i !== index
                              ? current
                              : v
                                ? { sql: "" }
                                : { path: "", type: "auto", recursive: true },
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      title="Remover"
                      onClick={() =>
                        change({
                          paths: data.paths.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
function SchedulerEditor({data, open, setOpen, change}: {data: XmlConfig; open: boolean; setOpen: (v: boolean) => void; change: (v: Partial<XmlConfig>) => void}) {
  const scheduler = data.scheduler || { command: "", schedule_time: "", recurrence_tag: "" };
  const update = (patch: Partial<NonNullable<XmlConfig["scheduler"]>>) => change({ scheduler: { ...scheduler, ...patch } });
  const ativo = Boolean(scheduler.command);
  return <section className="divergence-card xml-template-card scheduler-template-card"><button className="divergence-title" type="button" onClick={() => setOpen(!open)}><div><span className="eyebrow teal">SCHEDULER</span><h2>Agendamento do template</h2><p>Opcional. Permite agendar comandos para cada Machine ID; sem horário usa o próximo minuto.</p></div>{open ? <ChevronUp /> : <ChevronDown />}</button>{open && <div className="xml-template-body"><div className="xml-options" style={{gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))"}}><label>Comando<select value={scheduler.command} onChange={e => e.target.value ? update({command:e.target.value,recurrence_tag:scheduler.recurrence_tag || "unica_vez"}) : change({scheduler:{command:"",schedule_time:"",recurrence_tag:""}})}><option value="">Nenhum</option><option>RESTART_NOW</option><option>UPDATE_DESKTOP_CLIENT</option><option>FORCE_RESEND_XML</option><option>PROCESS_XML_CLIENT</option></select></label><label>Horário (opcional)<input disabled={!ativo} type="time" value={ativo?schedulerTimeValue(scheduler.schedule_time):""} onChange={e => update({schedule_time:e.target.value})}/></label><label>Recorrência<select disabled={!ativo} value={ativo?(scheduler.recurrence_tag || "unica_vez"):""} onChange={e => update({recurrence_tag:e.target.value})}><option value="">—</option><option value="unica_vez">Única vez</option><option value="diaria">Diário</option><option value="semanal">Semanal</option><option value="quinzenal">Quinzenal</option></select></label></div></div>}</section>;
}
function Field({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null),
    valueRef = useRef(value);
  valueRef.current = value;
  function remember() {
    const el = ref.current;
    if (!el) return;
    activeSqlTarget.current = {
      element: el,
      getValue: () => valueRef.current,
      change,
      selection: {
        start: el.selectionStart ?? valueRef.current.length,
        end: el.selectionEnd ?? el.selectionStart ?? valueRef.current.length,
      },
    };
  }
  return (
    <label>
      {label}
      <input
        ref={ref}
        value={value}
        onFocus={remember}
        onPointerUp={remember}
        onClick={remember}
        onSelect={remember}
        onKeyUp={remember}
        onInput={remember}
        onChange={(e) => {
          valueRef.current = e.target.value;
          change(e.target.value);
          activeSqlTarget.current = {
            element: e.target,
            getValue: () => valueRef.current,
            change,
            selection: {
              start: e.target.selectionStart ?? e.target.value.length,
              end: e.target.selectionEnd ?? e.target.value.length,
            },
          };
        }}
      />
    </label>
  );
}
function CheckBox({
  text,
  checked,
  change,
  disabled = false,
  highlighted = false,
  exceptionHighlighted = false,
  stateVariable = false,
  hint,
}: {
  text: string;
  checked: boolean;
  change: (v: boolean) => void;
  disabled?: boolean;
  highlighted?: boolean;
  exceptionHighlighted?: boolean;
  stateVariable?: boolean;
  hint?: string;
}) {
  return (
    <label className={`check ${stateVariable ? "uf-variable-check" : "standard-tax-check"} ${highlighted ? "uf-controlled-check" : ""} ${exceptionHighlighted ? "template-exception-check" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => change(e.target.checked)}
      />
      <span>{text}</span>
      {hint && <em>{hint}</em>}
    </label>
  );
}
function Sql({
  label,
  value,
  change,
  insert: _insert,
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  insert: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null),
    valueRef = useRef(value),
    selectionRef = useRef({ start: value.length, end: value.length });
  valueRef.current = value;
  function remember() {
    const el = ref.current;
    if (!el) return;
    selectionRef.current = {
      start: el.selectionStart ?? valueRef.current.length,
      end: el.selectionEnd ?? el.selectionStart ?? valueRef.current.length,
    };
    activeSqlTarget.current = {
      element: el,
      getValue: () => valueRef.current,
      change,
      selection: selectionRef.current,
    };
  }
  function put(text: string) {
    const el = ref.current;
    if (!el) return;
    const current = valueRef.current,
      start = Math.min(selectionRef.current.start, current.length),
      end = Math.min(selectionRef.current.end, current.length),
      next = current.slice(0, start) + text + current.slice(end),
      cursor = start + text.length;
    valueRef.current = next;
    change(next);
    selectionRef.current = { start: cursor, end: cursor };
    activeSqlTarget.current = {
      element: el,
      getValue: () => next,
      change,
      selection: selectionRef.current,
    };
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }
  return (
    <div className={`sql-field ${value.trim() ? "" : "empty-sql"}`}>
      <label>
        <span>{label}</span>
        <textarea
          ref={ref}
          rows={value.trim() ? Math.max(7, value.split("\n").length + 1) : 2}
          spellCheck={false}
          value={value}
          onFocus={remember}
          onPointerUp={remember}
          onClick={remember}
          onSelect={remember}
          onKeyUp={remember}
          onInput={remember}
          onChange={(e) => {
            valueRef.current = e.target.value;
            change(e.target.value);
            selectionRef.current = {
              start: e.target.selectionStart,
              end: e.target.selectionEnd,
            };
            activeSqlTarget.current = {
              element: e.target,
              getValue: () => valueRef.current,
              change,
              selection: selectionRef.current,
            };
          }}
        />
      </label>
      <div className="sql-tools">
        <small>Inserir variável:</small>
        {variableShortcuts.map(({ value: shortcut, label: shortcutLabel }) => (
          <button
            type="button"
            key={shortcut}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (!insertIntoActiveSql(shortcut)) put(shortcut);
            }}
          >
            {shortcutLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
