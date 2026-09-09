"use client";

import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  FilePlus2,
  LayoutDashboard,
  LogOut,
  Menu,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
  XCircle,
} from "lucide-react";
import { connectionStatus } from "@/lib/connection-status";

type Status =
  "pendente" | "pausado" | "processando" | "concluido" | "erro" | "cancelado";
type Template = {
  id: number;
  nome: string;
  regimes_tributarios?: string[];
  possui_xml?: boolean;
  possui_conexao?: boolean;
  possui_scheduler?: boolean;
};
type AutomationService =
  "configuracao_conexao" | "cadastro_template" | "comparar_divergencias" | "importar_e_gravar" | "configuracao_xml" | "scheduler";
type ServiceStatus = {
  service_name: string;
  label: string;
  host_name?: string;
  version?: string;
  last_seen?: string;
  active: boolean;
};
type Job = {
  id: number;
  cnpj: string;
  status: Status;
  tentativas: number;
  mensagem_erro?: string;
  criado_em: string;
  processado_em?: string;
  template_nome: string;
  operacao?: AutomationService;
  template_id?: number;
  machine_id?: string;
  solicitado_por?: string;
  progresso?: number;
  etapa?: string;
  progresso_atualizado_em?: string;
  regime_bloqueado?: boolean;
  regime_esperado?: string;
  regime_encontrado?: string;
  regime_divergente_autorizado?: boolean;
  regime_divergente_autorizado_por?: string;
  regime_divergente_autorizado_em?: string;
};
type JobLog = { id: number; progresso: number; etapa: string; criado_em: string };
type DatabaseCheck = { connected: boolean; checking?: boolean; detail?: string };
type QueryTable = { key: string; group: string; type: "VIEW" | "TMP"; name: string };
type QueryOptions = { cnpj: string; machine_id: string; dialect: string; tables: QueryTable[]; max_rows: number };
type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; count: number; limited: boolean; elapsed_ms: number };

const statusLabel: Record<Status, string> = {
  pendente: "Pendente",
  pausado: "Pausado",
  processando: "Processando",
  concluido: "Concluido",
  erro: "Erro",
  cancelado: "Cancelado",
};
const formatCnpj = (value: string) =>
  value
    .replace(/\D/g, "")
    .replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const formatDate = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
const parseCnpjs = (value: string) => [
  ...new Set(
    value
      .split(/[\s,;]+/)
      .map((item) => item.replace(/\D/g, ""))
      .filter(Boolean),
  ),
];
const operationLabel = (job: Job) =>
  job.operacao === "scheduler"
    ? "Scheduler"
    : job.operacao === "comparar_divergencias"
    ? "Somente comparar divergências"
    : job.operacao === "configuracao_conexao"
    ? "Instalar dados de conexao do robo"
    : job.operacao === "importar_e_gravar"
    ? "Importar e gravar"
    : job.operacao === "configuracao_xml"
      ? "Configuracao XML"
      : "Cadastrar template";

export default function PainelPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showPartial, setShowPartial] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Status | "">("");
  const [notice, setNotice] = useState("");
  const [automationWarning, setAutomationWarning] = useState("");
  const [cnpjText, setCnpjText] = useState("");
  const [partialCnpjText, setPartialCnpjText] = useState("");
  const [credentialActive, setCredentialActive] = useState(false);
  const [operatorName, setOperatorName] = useState("");
  const [showCredentialPrompt, setShowCredentialPrompt] = useState(false);
  const [credentialChecked, setCredentialChecked] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [regimeJob, setRegimeJob] = useState<Job | null>(null);
  const [templateEscolhido, setTemplateEscolhido] = useState("");
  const [buscarTodosTemplates, setBuscarTodosTemplates] = useState(false);
  const [buscaTemplate, setBuscaTemplate] = useState("");
  const [criandoLote, setCriandoLote] = useState(false);
  const [selectedServices, setSelectedServices] = useState<AutomationService[]>([]);
  const [reprocessando, setReprocessando] = useState(false);
  const [removeJob, setRemoveJob] = useState<Job | null>(null);
  const [removingJob, setRemovingJob] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<number[]>([]);
  const [removingJobs, setRemovingJobs] = useState(false);
  const [openLogJobId, setOpenLogJobId] = useState<number>();
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);
  const [loadingJobLogs, setLoadingJobLogs] = useState(false);
  const [databaseChecks, setDatabaseChecks] = useState<Record<number, DatabaseCheck>>({});
  const [queryJob, setQueryJob] = useState<Job | null>(null);
  const [queryOptions, setQueryOptions] = useState<QueryOptions | null>(null);
  const [querySql, setQuerySql] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [querySuggestionIndex, setQuerySuggestionIndex] = useState(0);
  const [querySuggestionsHidden, setQuerySuggestionsHidden] = useState(false);
  const refreshing = useRef(false);

  const loadJobLogs = useCallback(async (jobId: number, spinner = false) => {
    if (spinner) setLoadingJobLogs(true);
    try {
      const response = await fetch(`/api/mix/v1/jobs/${jobId}/logs`, {
        cache: "no-store",
      });
      if (response.ok) setJobLogs((await response.json()).items || []);
    } finally {
      if (spinner) setLoadingJobLogs(false);
    }
  }, []);

  const load = useCallback(async (showSpinner = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (showSpinner) setLoading(true);
    const controller = new AbortController();
    const requestTimeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const [
        jobsResponse,
        templatesResponse,
        credentialResponse,
        profileResponse,
        servicesResponse,
      ] = await Promise.all([
        fetch("/api/mix/v1/jobs?limite=1000", {
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch("/api/mix/v1/templates", {
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch("/api/credentials", {
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch("/api/profile", { cache: "no-store", signal: controller.signal }),
        fetch("/api/mix/v1/service-status", {
          cache: "no-store",
          signal: controller.signal,
        }),
      ]);
      if (jobsResponse.status === 401)
        return void (window.location.href = "/login");
      if (!jobsResponse.ok || !templatesResponse.ok)
        throw new Error("Nao foi possivel consultar a API.");
      setJobs((await jobsResponse.json()).items || []);
      setTemplates((await templatesResponse.json()).items || []);
      if (servicesResponse.ok)
        setServices((await servicesResponse.json()).items || []);
      if (credentialResponse.ok) {
        const active = Boolean((await credentialResponse.json()).ativa);
        setCredentialActive(active);
        if (
          !active &&
          sessionStorage.getItem("appmix_credential_prompt_dismissed") !== "1"
        )
          setShowCredentialPrompt(true);
        if (active) setShowCredentialPrompt(false);
      }
      setCredentialChecked(true);
      if (profileResponse.ok) {
        const profile = await profileResponse.json();
        setOperatorName(profile.nome || profile.email || "");
      }
    } catch (error) {
      if (showSpinner)
        setNotice(
          error instanceof Error ? error.message : "Falha ao carregar dados.",
        );
    } finally {
      window.clearTimeout(requestTimeout);
      refreshing.current = false;
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), 2000);
    const refreshOnFocus = () => void load(false);
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (!openLogJobId) {
      setJobLogs([]);
      return;
    }
    void loadJobLogs(openLogJobId, true);
    const timer = window.setInterval(
      () => void loadJobLogs(openLogJobId),
      2500,
    );
    return () => window.clearInterval(timer);
  }, [openLogJobId, loadJobLogs]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileMenuOpen]);
  const counts = useMemo(
    () =>
      jobs.reduce(
        (all, job) => ({ ...all, [job.status]: (all[job.status] || 0) + 1 }),
        {} as Record<Status, number>,
      ),
    [jobs],
  );
  const visible = jobs.filter(
    (job) =>
      (!filter || job.status === filter) &&
      (!search ||
        job.cnpj.includes(search.replace(/\D/g, "")) ||
        job.template_nome.toLowerCase().includes(search.toLowerCase()) ||
        operationLabel(job).toLowerCase().includes(search.toLowerCase())),
  );
  const selectableVisible = visible.filter((job) => job.status !== "processando");
  const allVisibleSelected =
    selectableVisible.length > 0 &&
    selectableVisible.every((job) => selectedJobIds.includes(job.id));

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cnpjs = parseCnpjs(cnpjText);
    const tamanhosInvalidos = cnpjs.filter((cnpj) => cnpj.length !== 14);
    if (!cnpjs.length) return setNotice("Informe pelo menos um CNPJ.");
    if (tamanhosInvalidos.length)
      return setNotice(
        `${tamanhosInvalidos.length} CNPJ(s) não possuem exatamente 14 dígitos.`,
      );
    if (!selectedServices.length)
      return setNotice("Selecione pelo menos um servico.");
    const precisaTemplate =
      selectedServices.includes("configuracao_conexao") ||
      selectedServices.includes("cadastro_template") ||
      selectedServices.includes("comparar_divergencias") ||
      selectedServices.includes("configuracao_xml") ||
      selectedServices.includes("scheduler");
    const templateId = Number(form.get("template_id"));
    if (precisaTemplate && !templateId)
      return setNotice("Selecione o template.");
    const template = templates.find((item) => item.id === templateId);
    if (selectedServices.includes("configuracao_conexao") && !template?.possui_conexao)
      return setNotice("Não é possível rodar a automação pois esse template não possui dados de conexão cadastrados.");
    setCriandoLote(true);
    try {
      const response = await fetch("/api/mix/v1/execucoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(templateId ? { template_id: templateId } : {}),
          cnpjs,
          servicos: selectedServices,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(result.detail || "Nao foi possivel criar o lote.");
        return;
      }
      setNotice(
        `${result.quantidade} trabalho(s) criado(s).${result.ignorados?.length ? ` Etapas não criadas: ${result.ignorados.map((item: { motivo?: string }) => item.motivo || "configuração ausente").join("; ")}.` : ""}`,
      );
      setCnpjText("");
      setShowNew(false);
      await load();
    } finally {
      setCriandoLote(false);
    }
  }

  async function createImportBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cnpjs = parseCnpjs(partialCnpjText);
    const invalidos = cnpjs.filter((cnpj) => cnpj.length !== 14);
    if (!cnpjs.length) return setNotice("Informe pelo menos um CNPJ.");
    if (invalidos.length)
      return setNotice(
        `${invalidos.length} CNPJ(s) não possuem exatamente 14 dígitos.`,
      );
    const response = await fetch("/api/mix/v1/importacoes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cnpjs }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      return setNotice(
        result.detail || "Não foi possível enfileirar a importação.",
      );
    setNotice(
      `Importação e gravação enfileiradas para ${result.quantidade} empresa(s).`,
    );
    setPartialCnpjText("");
    setShowPartial(false);
    await load();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
  async function submitReprocess(job: Job, templateId = "") {
    const trocaPorRegime = Boolean(job.regime_bloqueado);
    setReprocessando(true);
    try {
      const response = await fetch(`/api/mix/v1/jobs/${job.id}/reprocessar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template_id_novo: templateId ? Number(templateId) : undefined,
          }),
        }),
        result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(result.detail || "Nao foi possivel reprocessar.");
        return;
      }
      setNotice(
        trocaPorRegime
          ? `Template do job #${job.id} alterado e trabalho enviado novamente.`
          : `Job #${job.id} enviado novamente para a fila.`,
      );
      setRegimeJob(null);
      setTemplateEscolhido("");
      setBuscaTemplate("");
      setBuscarTodosTemplates(false);
      await load();
    } finally {
      setReprocessando(false);
    }
  }
  async function reprocess(job: Job) {
    if (job.regime_bloqueado) {
      setTemplateEscolhido("");
      setBuscaTemplate("");
      setBuscarTodosTemplates(false);
      setRegimeJob(job);
      return;
    }
    if (window.confirm(`Reprocessar o job #${job.id}?`))
      await submitReprocess(job);
  }
  async function archiveJob(job: Job) {
    setRemovingJob(true);
    try {
      const response = await fetch(`/api/mix/v1/jobs/${job.id}/arquivar`, {
        method: "POST",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        return setNotice(
          result.detail || "Não foi possível remover o trabalho da lista.",
        );
      setRegimeJob(null);
      setRemoveJob(null);
      setNotice(
        `Job #${job.id} removido da lista. O histórico foi preservado.`,
      );
      await load();
    } finally {
      setRemovingJob(false);
    }
  }
  function toggleJobSelection(id: number, checked: boolean) {
    setSelectedJobIds((current) =>
      checked ? [...new Set([...current, id])] : current.filter((item) => item !== id),
    );
  }
  function toggleVisibleJobs(checked: boolean) {
    const eligible = visible
      .filter((job) => job.status !== "processando")
      .map((job) => job.id);
    setSelectedJobIds((current) =>
      checked
        ? [...new Set([...current, ...eligible])]
        : current.filter((id) => !eligible.includes(id)),
    );
  }
  async function archiveSelectedJobs() {
    if (!selectedJobIds.length || removingJobs) return;
    if (!window.confirm(
      `Remover ${selectedJobIds.length} trabalho(s) selecionado(s) da lista?\n\nO historico sera preservado e trabalhos em processamento serao ignorados.`,
    )) return;
    setRemovingJobs(true);
    try {
      const response = await fetch("/api/mix/v1/jobs/arquivar-lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedJobIds }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        return setNotice(result.detail || "Nao foi possivel remover os trabalhos.");
      const removed = Array.isArray(result.removidos) ? result.removidos.length : 0;
      const processing = Array.isArray(result.ignorados_processando)
        ? result.ignorados_processando.length
        : 0;
      setSelectedJobIds([]);
      setNotice(
        `${removed} trabalho(s) removido(s).${processing ? ` ${processing} em processamento foram preservados.` : ""}`,
      );
      await load();
    } finally {
      setRemovingJobs(false);
    }
  }
  async function cancelPendingImport(job: Job) {
    if (
      !window.confirm(
        `Cancelar a importação e gravação pendente do CNPJ ${formatCnpj(job.cnpj)}?`,
      )
    )
      return;
    const response = await fetch(
      `/api/mix/v1/jobs/${job.id}/cancelar-importacao`,
      { method: "POST" },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      return setNotice(
        result.detail || "Não foi possível cancelar a gravação.",
      );
    setNotice(
      `Importação e gravação do job #${job.id} cancelada antes do envio à Mix.`,
    );
    await load();
  }
  async function testJobConnection(job: Job) {
    setDatabaseChecks((current) => ({
      ...current,
      [job.id]: { connected: false, checking: true, detail: "Localizando a maquina e consultando o banco pelo robo." },
    }));
    const response = await fetch(`/api/mix/v1/jobs/${job.id}/testar-banco`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const result = await response.json().catch(() => ({}));
    const connected = response.ok && result.connected === true;
    setDatabaseChecks((current) => ({
      ...current,
      [job.id]: { connected, detail: result.detail || "Teste concluido." },
    }));
    if (connected)
      setJobs((current) => current.map((item) =>
        item.cnpj === job.cnpj ? { ...item, machine_id: result.machine_id } : item,
      ));
    setNotice(connected
      ? `Banco conectado e consulta SQL validada para ${formatCnpj(job.cnpj)}.`
      : result.detail || "Nao foi possivel validar o banco pelo robo.");
  }
  async function openDatabaseQuery(job: Job) {
    setQueryJob(job); setQueryOptions(null); setQueryResult(null); setQueryError(""); setQuerySql(""); setQuerySuggestionIndex(0); setQuerySuggestionsHidden(false);
    const response = await fetch(`/api/mix/v1/jobs/${job.id}/consulta-sql-opcoes`, { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return setQueryError(result.detail || "Nao foi possivel preparar a consulta.");
    setQueryOptions(result);
  }
  async function runDatabaseQuery() {
    if (!queryJob || !querySql.trim()) return;
    setQueryLoading(true); setQueryError(""); setQueryResult(null);
    try {
      const response = await fetch(`/api/mix/v1/jobs/${queryJob.id}/consultar-sql`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: querySql }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return setQueryError(result.detail || "A consulta remota falhou.");
      setQueryResult(result);
    } finally { setQueryLoading(false); }
  }
  const queryWords = ["SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AND", "OR", "ORDER BY", "GROUP BY", "HAVING", "DISTINCT", "AS", "WITH", "UNION ALL", "EXCEPT", "IS NULL", "IS NOT NULL"];
  const queryToken = querySql.match(/([A-Za-z_][\w$]*)$/)?.[1] || "";
  const querySuggestions = queryToken.length
    ? [...queryWords, ...(queryOptions?.tables.map((table) => table.name) || [])].filter((item) => item.toLowerCase().startsWith(queryToken.toLowerCase()) && item.toLowerCase() !== queryToken.toLowerCase()).slice(0, 10)
    : [];
  function applyQuerySuggestion(value: string) {
    setQuerySql((current) => current.replace(/([A-Za-z_][\w$]*)$/, `${value} `));
    setQuerySuggestionIndex(0);
    setQuerySuggestionsHidden(false);
  }
  function buildCountQuery(type?: "VIEW" | "TMP") {
    const tables = (queryOptions?.tables || []).filter((table) => !type || table.type === type);
    setQuerySql(tables.map((table) =>
      `SELECT '${table.name.replace(/'/g, "''")}' AS TABELA, COUNT(*) AS TOTAL_LINHAS FROM ${table.name}`,
    ).join("\nUNION ALL\n"));
    setQueryResult(null); setQueryError(""); setQuerySuggestionsHidden(true);
  }
  function buildCompareQuery() {
    const dialect = (queryOptions?.dialect || "").toLowerCase();
    const dummyFrom = dialect.includes("firebird") || dialect.includes("interbase")
      ? "\nFROM RDB$DATABASE"
      : dialect.includes("oracle")
        ? "\nFROM DUAL"
        : dialect.includes("db2")
          ? "\nFROM SYSIBM.SYSDUMMY1"
          : "";
    const groups = [...new Set((queryOptions?.tables || []).map((table) => table.group))];
    const comparisons = groups.flatMap((group) => {
      const view = queryOptions?.tables.find((table) => table.group === group && table.type === "VIEW");
      const tmp = queryOptions?.tables.find((table) => table.group === group && table.type === "TMP");
      if (!view || !tmp) return [];
      const label = group.replace(/'/g, "''");
      return [`SELECT '${label}' AS GRUPO,
  (SELECT COUNT(*) FROM ${view.name}) AS TOTAL_VIEW,
  (SELECT COUNT(*) FROM ${tmp.name}) AS TOTAL_TMP,
  ((SELECT COUNT(*) FROM ${view.name}) - (SELECT COUNT(*) FROM ${tmp.name})) AS DIFERENCA_LINHAS,
  CASE
    WHEN (SELECT COUNT(*) FROM ${view.name}) = (SELECT COUNT(*) FROM ${tmp.name}) THEN 'CONTAGEM IGUAL'
    ELSE 'VOLUMES DIFERENTES'
  END AS STATUS${dummyFrom}`];
    });
    setQuerySql(comparisons.join("\nUNION ALL\n"));
    setQueryResult(null); setQueryError(""); setQuerySuggestionsHidden(true);
  }
  function queryPreviewForDialect(tableName: string) {
    const dialect = (queryOptions?.dialect || "").toLowerCase();
    if (dialect.includes("firebird") || dialect.includes("interbase")) return `SELECT FIRST 10 * FROM ${tableName}`;
    if (dialect.includes("oracle") || dialect.includes("db2")) return `SELECT * FROM ${tableName} FETCH FIRST 10 ROWS ONLY`;
    return `SELECT * FROM ${tableName} LIMIT 10`;
  }
  function handleQueryEditorKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!querySuggestions.length || querySuggestionsHidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setQuerySuggestionIndex((current) => (current + 1) % querySuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setQuerySuggestionIndex((current) => (current - 1 + querySuggestions.length) % querySuggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      applyQuerySuggestion(querySuggestions[Math.min(querySuggestionIndex, querySuggestions.length - 1)]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuerySuggestionsHidden(true);
    }
  }
  async function controlJob(
    job: Job,
    acao: "pausar" | "continuar" | "cancelar",
  ) {
    const verbo =
      acao === "pausar"
        ? "pausar"
        : acao === "continuar"
          ? "continuar"
          : "cancelar";
    if (
      acao !== "continuar" &&
      !window.confirm(
        `${verbo[0].toUpperCase() + verbo.slice(1)} o trabalho #${job.id}?`,
      )
    )
      return;
    const response = await fetch(`/api/mix/v1/jobs/${job.id}/${acao}`, {
      method: "POST",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      return setNotice(
        result.detail || `Não foi possível ${verbo} o trabalho.`,
      );
    setNotice(`Trabalho #${job.id}: ação ${verbo} concluída.`);
    await load();
  }
  function openAutomation(kind: "install" | "template" | "divergencias" | "import" | "xml" | "scheduler") {
    if (!credentialActive) {
      setShowCredentialPrompt(true);
      return;
    }
    setTemplateEscolhido("");
    setAutomationWarning("");
    setSelectedServices([
      kind === "install"
        ? "configuracao_conexao"
        : kind === "template"
        ? "cadastro_template"
        : kind === "divergencias"
        ? "comparar_divergencias"
        : kind === "import"
          ? "importar_e_gravar"
          : kind === "scheduler" ? "scheduler" : "configuracao_xml",
    ]);
    setShowNew(true);
  }
  function toggleService(service: AutomationService) {
    if (service === "configuracao_conexao" && templateEscolhido && !templates.find((item) => String(item.id) === templateEscolhido)?.possui_conexao)
      return setAutomationWarning("Esta automação não está disponível para o template selecionado porque ele não possui dados de conexão do banco cadastrados. Cadastre banco, usuário e senha na tela de Templates para liberar esta opção.");
    if (service === "scheduler" && templateEscolhido && !templates.find((item) => String(item.id) === templateEscolhido)?.possui_scheduler)
      return setAutomationWarning("Esta automação não está disponível porque o template selecionado não possui Scheduler configurado. Abra a tela de Templates, escolha um comando na seção Scheduler e salve para liberar esta opção.");
    setSelectedServices((current) =>
      current.includes(service)
        ? current.filter((item) => item !== service)
        : [...current, service],
    );
  }
  function dismissCredentialPrompt() {
    sessionStorage.setItem("appmix_credential_prompt_dismissed", "1");
    setShowCredentialPrompt(false);
  }

  const precisaTemplateSelecionado = selectedServices.some(
    (service) => service !== "importar_e_gravar",
  );

  return (
    <div className="app-shell">
      <button
        type="button"
        className={`sidebar-backdrop ${mobileMenuOpen ? "open" : ""}`}
        aria-label="Fechar menu"
        aria-hidden={!mobileMenuOpen}
        tabIndex={mobileMenuOpen ? 0 : -1}
        onClick={() => setMobileMenuOpen(false)}
      />
      <aside
        id="mobile-navigation"
        className={`sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}
      >
        <button
          type="button"
          className="sidebar-close"
          aria-label="Fechar menu"
          onClick={() => setMobileMenuOpen(false)}
        >
          <XCircle size={23} />
        </button>
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={20} />
          </span>
          <span>APP MIX</span>
        </div>
        <nav>
          <a className="active" href="/painel">
            <LayoutDashboard size={19} /> Visao geral
          </a>
          <a
            onClick={() => {
              setFilter("pendente");
              setMobileMenuOpen(false);
            }}
          >
            <Clock3 size={19} /> Fila
          </a>
          <a
            onClick={() => {
              setFilter("concluido");
              setMobileMenuOpen(false);
            }}
          >
            <CheckCircle2 size={19} /> Historico
          </a>
          <a href="/painel/templates">
            <Settings2 size={19} /> Templates
          </a>
          <a href="/painel/consulta-sql">
            <Database size={19} /> Consulta SQL
          </a>
          <a href="/painel/integracoes">
            <Bot size={19} /> API Hermes
          </a>
          <a href="/painel/perfil">
            <UsersRound size={19} /> Equipe e credenciais
          </a>
        </nav>
        <a className="worker-card" href="/painel/perfil">
          <span
            className={credentialActive ? "pulse" : "pulse credential-off"}
          />
          <div>
            <strong>
              {credentialActive ? "Credencial ativa" : "Credencial pendente"}
            </strong>
            <small>
              {credentialActive ? "App Mix liberado" : "Cadastre para operar"}
            </small>
          </div>
        </a>
        <button className="logout" onClick={logout}>
          <LogOut size={18} /> Sair
        </button>
      </aside>

      <main className="content">
        <header className="topbar">
          <button
            type="button"
            className="mobile-menu"
            aria-label="Abrir menu"
            aria-controls="mobile-navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu />
          </button>
          <div>
            <span className="eyebrow dark">CENTRAL OPERACIONAL</span>
            <h1>Visao geral</h1>
            {operatorName && (
              <small className="logged-operator">
                <UserRound size={15} /> Operador:{" "}
                <strong>{operatorName}</strong>
              </small>
            )}
          </div>
          <div className="top-actions">
            <button
              className="icon-button"
              onClick={() => void load(true)}
              title="Atualizar"
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </header>
        <section className="service-monitor-shell">
          <button
            type="button"
            className="service-monitor-toggle"
            onClick={() => setServicesOpen(!servicesOpen)}
          >
            <span>
              <Activity size={18} />
              <strong>Serviços da automação</strong>
              <small>
                {services.filter((item) => item.active).length}/
                {services.length} ativos
              </small>
            </span>
            <ChevronDown className={servicesOpen ? "open" : ""} />
          </button>
          {servicesOpen && (
            <div className="service-monitor" aria-label="Status dos servicos">
              {services.map((service) => (
                <article
                  key={service.service_name}
                  className={
                    service.active ? "service-online" : "service-offline"
                  }
                >
                  <span className="service-dot" />
                  <div>
                    <strong>{service.label}</strong>
                    <small>
                      {service.active
                        ? `Ativo em ${service.host_name || "servidor"}`
                        : "Sem sinal recente"}
                    </small>
                  </div>
                  <b>{service.active ? "ATIVO" : "INATIVO"}</b>
                </article>
              ))}
            </div>
          )}
        </section>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")}>
              <XCircle size={17} />
            </button>
          </div>
        )}
        {credentialChecked && !credentialActive && (
          <section className="credential-required">
            <AlertTriangle size={24} />
            <div>
              <strong>Credencial do App Mix não cadastrada</strong>
              <p>
                As automações estão bloqueadas até você validar seu usuário e
                sua senha do portal App Mix.
              </p>
            </div>
            <a
              className="primary-button compact"
              href="/painel/perfil#credencial-app-mix"
            >
              Cadastrar agora
            </a>
          </section>
        )}

        <section
          className={`automation-flow automation-services ${credentialChecked && !credentialActive ? "automation-locked" : ""}`}
        >
          <div className="automation-services-intro">
            <span className="eyebrow dark">AUTOMAÇÕES INDEPENDENTES</span>
            <h2>Escolha apenas a operação necessária</h2>
            <p>
              {credentialActive
                ? "Cadastro, importação/gravação e XML usam filas independentes. Selecione uma ou combine as três para os mesmos CNPJs."
                : "Cadastre sua credencial do App Mix para liberar estas automações."}
            </p>
          </div>
          <div className="flow-steps automation-services-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            <button
              className="automation-install"
              type="button"
              onClick={() => openAutomation("install")}
            >
              <Bot size={21} />
              <span>
                <strong>Instalar dados de conexao do robo</strong>
                <small>Localiza a ponte e aplica a conexao do template.</small>
              </span>
              <ChevronRight size={18} />
            </button>
            <button
              className="automation-template"
              type="button"
              onClick={() => openAutomation("template")}
            >
              <Settings2 size={21} />
              <span>
                <strong>Cadastrar template nos clientes</strong>
                <small>
                  Atualiza VIEW, TMP, flags e divergências nos CNPJs.
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
            <button
              className="automation-import"
              type="button"
              onClick={() => openAutomation("import")}
              title="Executa IMPORTAR e confirma a importação e gravação"
            >
              <FilePlus2 size={21} />
              <span>
                <strong>Importar e gravar</strong>
                <small>
                  Executa IMPORTAR e confirma somente nos clientes escolhidos.
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
            <button
              className="automation-template"
              type="button"
              onClick={() => openAutomation("divergencias")}
            >
              <ShieldCheck size={21} />
              <span>
                <strong>Comparar divergências</strong>
                <small>Aplica somente as flags do template, sem alterar VIEW/TMP.</small>
              </span>
              <ChevronRight size={18} />
            </button>
            <button
              className="automation-xml"
              type="button"
              onClick={() => openAutomation("xml")}
            >
              <FilePlus2 size={21} />
              <span>
                <strong>Configuração XML</strong>
                <small>Aplica caminhos ou consultas SQL do template.</small>
              </span>
              <ChevronRight size={18} />
            </button>
            <button className="automation-scheduler" type="button" onClick={() => openAutomation("scheduler")}>
              <Clock3 size={21} />
              <span><strong>Scheduler</strong><small>Agenda comandos do template.</small></span>
              <ChevronRight size={18} />
            </button>
          </div>
        </section>

        <section className="metric-grid">
          <Metric
            label="Aguardando"
            value={counts.pendente || 0}
            icon={<Clock3 />}
            tone="amber"
            onClick={() => setFilter("pendente")}
          />
          <Metric
            label="Em processamento"
            value={counts.processando || 0}
            icon={<Activity />}
            tone="blue"
            onClick={() => setFilter("processando")}
          />
          <Metric
            label="Concluidos"
            value={counts.concluido || 0}
            icon={<CheckCircle2 />}
            tone="green"
            onClick={() => setFilter("concluido")}
          />
          <Metric
            label="Com erro"
            value={counts.erro || 0}
            icon={<AlertTriangle />}
            tone="red"
            onClick={() => setFilter("erro")}
          />
        </section>

        <section className="table-card">
          <div className="table-head">
            <div>
              <h2>Execucoes recentes</h2>
              <p>Acompanhamento automatico dos ultimos trabalhos</p>
            </div>
            <div className="filters">
              {selectedJobIds.length > 0 && (
                <button
                  type="button"
                  className="bulk-remove-button"
                  disabled={removingJobs}
                  onClick={() => void archiveSelectedJobs()}
                >
                  <Trash2 size={16} />
                  {removingJobs
                    ? "Removendo..."
                    : `Remover selecionados (${selectedJobIds.length})`}
                </button>
              )}
              <label className="search">
                <Search size={17} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar CNPJ ou automação"
                />
              </label>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Status | "")}
              >
                <option value="">Todos os status</option>
                {Object.entries(statusLabel).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="job-select-cell">
                    <input
                      type="checkbox"
                      aria-label="Selecionar trabalhos visiveis"
                      checked={allVisibleSelected}
                      disabled={!selectableVisible.length}
                      onChange={(event) => toggleVisibleJobs(event.target.checked)}
                    />
                  </th>
                  <th>ID</th>
                  <th>Empresa</th>
                  <th>Automação</th>
                  <th>Solicitado por</th>
                  <th>Status</th>
                  <th>Andamento</th>
                  <th>Criado em</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      Atualizando dados...
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      Nenhuma execucao encontrada.
                    </td>
                  </tr>
                ) : (
                  visible.map((job) => (
                    <Fragment key={job.id}>
                    <tr
                      className={
                        job.operacao === "importar_e_gravar"
                          ? "job-row-import"
                          : "job-row-template"
                      }
                    >
                      <td className="job-select-cell">
                        <input
                          type="checkbox"
                          aria-label={`Selecionar job ${job.id}`}
                          checked={selectedJobIds.includes(job.id)}
                          disabled={job.status === "processando"}
                          onChange={(event) =>
                            toggleJobSelection(job.id, event.target.checked)
                          }
                        />
                      </td>
                      <td className="mono">#{job.id}</td>
                      <td>
                        <button className="cnpj-query-button" type="button" title="Abrir consulta SQL segura no cliente" onClick={() => void openDatabaseQuery(job)}>
                          {formatCnpj(job.cnpj)}
                        </button>
                      </td>
                      <td>
                        <span
                          className={`automation-label ${job.operacao === "scheduler" ? "scheduler" : job.operacao === "importar_e_gravar" ? "import" : job.operacao === "configuracao_conexao" ? "connection" : job.operacao === "configuracao_xml" ? "xml" : "template"}`}
                        >
                          {operationLabel(job)}
                        </span>
                        {["configuracao_conexao", "cadastro_template", "comparar_divergencias", "configuracao_xml"].includes(job.operacao || "") && job.template_nome && (
                          <small className="automation-template-name">
                            {job.template_nome}
                          </small>
                        )}
                      </td>
                      <td>{job.solicitado_por || "—"}</td>
                      <td>
                        <span className={`status ${job.status}`}>
                          {statusLabel[job.status]}
                        </span>
                      </td>
                      <td>
                        <div
                          className={`job-progress ${job.status}`}
                          title={job.etapa || statusLabel[job.status]}
                        >
                          <div className="job-progress-row">
                            <span>
                              {job.etapa ||
                                (job.status === "pendente"
                                  ? "Aguardando worker"
                                  : statusLabel[job.status])}
                            </span>
                            <b>
                              {job.status === "concluido"
                                ? 100
                                : Math.max(
                                    0,
                                    Math.min(Number(job.progresso) || 0, 99),
                                  )}
                              %
                            </b>
                          </div>
                          <div className="job-progress-track">
                            <i
                              style={{
                                width: `${job.status === "concluido" ? 100 : Math.max(0, Math.min(Number(job.progresso) || 0, 99))}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>{formatDate(job.criado_em)}</td>
                      <td>
                        <div className="job-row-actions">
                          {job.status === "pendente" ? (
                            <div className="queue-actions">
                              <button
                                className="queue-action pause"
                                title="Pausar"
                                onClick={() => void controlJob(job, "pausar")}
                              >
                                <Pause size={15} />
                              </button>
                              <button
                                className="queue-action cancel"
                                title="Cancelar"
                                onClick={() => void controlJob(job, "cancelar")}
                              >
                                <XCircle size={15} />
                              </button>
                            </div>
                          ) : job.status === "pausado" ? (
                            <div className="queue-actions">
                              <button
                                className="queue-action continue"
                                title="Continuar"
                                onClick={() =>
                                  void controlJob(job, "continuar")
                                }
                              >
                                <Play size={15} />
                              </button>
                              <button
                                className="queue-action cancel"
                                title="Cancelar"
                                onClick={() => void controlJob(job, "cancelar")}
                              >
                                <XCircle size={15} />
                              </button>
                            </div>
                          ) : job.status === "erro" ||
                            job.status === "cancelado" ? (
                            <button
                              className="retry-button"
                              onClick={() => reprocess(job)}
                            >
                              Reprocessar
                            </button>
                          ) : (
                            <ChevronRight size={18} />
                          )}
                          {job.status !== "processando" && (
                            <button
                              className="queue-action remove"
                              title="Remover da lista"
                              aria-label={`Remover job ${job.id}`}
                              onClick={() => setRemoveJob(job)}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                          {job.operacao === "configuracao_conexao" && (() => {
                            const checked = databaseChecks[job.id];
                            const connection = checked?.checking
                              ? { label: "Verificando", className: "checking", title: checked.detail || "Consultando o banco pelo robo." }
                              : checked
                                ? checked.connected
                                  ? { label: "Banco conectado", className: "active", title: checked.detail || "Consulta SQL executada com sucesso." }
                                  : { label: "Banco sem conexao", className: "inactive", title: checked.detail || "A consulta SQL falhou." }
                                : connectionStatus(job.status, job.etapa);
                            const canCheck = !["pendente", "processando", "pausado"].includes(job.status);
                            return canCheck ? (
                              <button
                                className={`connection-state ${connection.className}`}
                                title={connection.title}
                                aria-label={`${connection.label}. Consultar conexao novamente no cliente para o job ${job.id}`}
                                disabled={checked?.checking}
                                onClick={() => void testJobConnection(job)}
                              >
                                {connection.className === "active" ? <CheckCircle2 size={14} /> : <Database size={14} />}
                                {connection.label}
                              </button>
                            ) : (
                              <span className={`connection-state ${connection.className}`} title={connection.title}>
                                <Database size={14} />
                                {connection.label}
                              </span>
                            );
                          })()}
                          <button
                            className="queue-action job-log-button"
                            title="Acompanhar log do robo"
                            aria-label={`Acompanhar log do job ${job.id}`}
                            onClick={() =>
                              setOpenLogJobId((current) =>
                                current === job.id ? undefined : job.id,
                              )
                            }
                          >
                            <Activity size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {openLogJobId === job.id && (
                      <tr className="job-log-row">
                        <td colSpan={9}>
                          <div className="job-log-panel">
                            <div className="job-log-title">
                              <div>
                                <strong>Log do robô · job #{job.id}</strong>
                                <small>Atualização automática durante o processamento</small>
                              </div>
                              <span className={job.status}>{statusLabel[job.status]}</span>
                            </div>
                            {loadingJobLogs ? (
                              <p>Carregando eventos...</p>
                            ) : jobLogs.length ? (
                              <ol>
                                {jobLogs.map((event, index) => (
                                  <li key={event.id}>
                                    <time>{formatDate(event.criado_em)}</time>
                                    <b
                                      className="job-log-step"
                                      title={`Marco interno: ${event.progresso}%`}
                                      aria-label={`Etapa ${index + 1}`}
                                    >
                                      {index + 1}
                                    </b>
                                    <span>{event.etapa}</span>
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p>Este job é anterior ao monitor de logs. Novos trabalhos registrarão todas as etapas.</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {showCredentialPrompt && (
        <div className="modal-backdrop" onMouseDown={dismissCredentialPrompt}>
          <div
            className="modal credential-onboarding"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="onboarding-icon">
              <AlertTriangle />
            </div>
            <span className="eyebrow dark">PRIMEIRO ACESSO</span>
            <h2>Cadastre sua credencial do App Mix</h2>
            <p>
              Sem o usuário e a senha do portal App Mix, o worker não consegue
              autenticar em seu nome e nenhuma automação será executada.
            </p>
            <div className="onboarding-points">
              <span>✓ Credencial individual e criptografada</span>
              <span>✓ Ações registradas no seu operador Mix</span>
              <span>✓ Validação antes de liberar as automações</span>
            </div>
            <a
              className="primary-button"
              href="/painel/perfil#credencial-app-mix"
            >
              Cadastrar credencial agora
            </a>
            <button
              className="dismiss-onboarding"
              type="button"
              onClick={dismissCredentialPrompt}
            >
              Agora não, continuar no painel
            </button>
          </div>
        </div>
      )}
      {regimeJob && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!reprocessando) setRegimeJob(null);
          }}
        >
          <form
            className="modal regime-confirm-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void submitReprocess(regimeJob, templateEscolhido);
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow dark">REGIME TRIBUTÁRIO</span>
            <h2>Trocar o template deste trabalho</h2>
            <p>
              O template atual <strong>{regimeJob.template_nome}</strong>{" "}
              permite <strong>{regimeJob.regime_esperado}</strong>, mas a Mix
              identificou <strong>{regimeJob.regime_encontrado}</strong>.
              Escolha um template compatível para o job #{regimeJob.id}.
            </p>
            <label>
              Buscar template
              <input
                value={buscaTemplate}
                onChange={(event) => setBuscaTemplate(event.target.value)}
                placeholder="Digite parte do nome do template"
                disabled={reprocessando}
              />
            </label>
            <label className="template-search-toggle">
              <input
                type="checkbox"
                checked={buscarTodosTemplates}
                onChange={(event) => {
                  setBuscarTodosTemplates(event.target.checked);
                  setTemplateEscolhido("");
                }}
                disabled={reprocessando}
              />{" "}
              Mostrar todos os templates
            </label>
            <label>
              Novo template
              <select
                required
                value={templateEscolhido}
                onChange={(event) => setTemplateEscolhido(event.target.value)}
                disabled={reprocessando}
              >
                <option value="" disabled>
                  Selecione um template compatível
                </option>
                {templates
                  .filter((template) =>
                    template.nome
                      .toLowerCase()
                      .includes(buscaTemplate.trim().toLowerCase()),
                  )
                  .filter((template) => {
                    const regimes = template.regimes_tributarios || [
                      "qualquer",
                    ];
                    const compativel =
                      regimes.includes("qualquer") ||
                      regimes.includes(regimeJob.regime_encontrado || "");
                    return buscarTodosTemplates || compativel;
                  })
                  .map((template) => {
                    const regimes = template.regimes_tributarios || [
                      "qualquer",
                    ];
                    const compativel =
                      regimes.includes("qualquer") ||
                      regimes.includes(regimeJob.regime_encontrado || "");
                    return (
                      <option
                        key={template.id}
                        value={template.id}
                        disabled={!compativel}
                      >
                        {template.nome}
                        {compativel ? "" : " — regime incompatível"}
                      </option>
                    );
                  })}
              </select>
            </label>
            <small>
              Os incompatíveis aparecem na busca completa para consulta, mas
              ficam bloqueados por segurança. A troca fica registrada no log.
            </small>
            {reprocessando && (
              <div className="submission-status">
                <span className="loading-spinner" /> Trocando o template e
                devolvendo o trabalho para a fila...
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="retry-button"
                disabled={reprocessando}
                onClick={() => {
                  setRegimeJob(null);
                  setRemoveJob(regimeJob);
                }}
              >
                Remover da lista
              </button>
              <a
                className="secondary-button"
                aria-disabled={reprocessando}
                href="/painel/templates"
              >
                Criar template
              </a>
              <button
                type="submit"
                className="primary-button"
                disabled={reprocessando}
              >
                {reprocessando ? (
                  <>
                    <span className="loading-spinner light" /> Processando...
                  </>
                ) : (
                  "Trocar e reprocessar"
                )}
              </button>
            </div>
          </form>
        </div>
      )}
      {removeJob && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!removingJob) setRemoveJob(null);
          }}
        >
          <section
            className="modal compact-modal remove-job-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-job-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="remove-job-icon">
              <Trash2 size={24} />
            </div>
            <span className="eyebrow dark">EXCLUSÃO SEGURA</span>
            <h2 id="remove-job-title">Remover o job #{removeJob.id}?</h2>
            <p>
              <strong>{formatCnpj(removeJob.cnpj)}</strong> ·{" "}
              {operationLabel(removeJob)}
            </p>
            <small>
              O trabalho desaparecerá da fila. Se estiver pendente ou pausado,
              será cancelado. O histórico e o responsável permanecerão
              registrados para auditoria.
            </small>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={removingJob}
                onClick={() => setRemoveJob(null)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={removingJob}
                onClick={() => void archiveJob(removeJob)}
              >
                {removingJob ? "Removendo..." : "Remover trabalho"}
              </button>
            </div>
          </section>
        </div>
      )}
      {showNew && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!criandoLote) setShowNew(false);
          }}
        >
          <form
            className="modal template-modal"
            onSubmit={createBatch}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <span className="eyebrow dark">AUTOMAÇÃO EM LOTE</span>
                <h2>Escolha as automações</h2>
                <p>
                  Para somente Importar e gravar, o template é opcional. Ao combinar com outra automação, selecione um template.
                </p>
              </div>
              <button
                type="button"
                disabled={criandoLote}
                onClick={() => setShowNew(false)}
              >
                <XCircle />
              </button>
            </div>
            <div className="modal-step template-first-step">
              <b>1</b>
              <label>
                Template {precisaTemplateSelecionado ? "obrigatório" : "opcional"}
                <select
                  name="template_id"
                  value={templateEscolhido}
                  onChange={(event) => {
                    const value = event.target.value;
                    const escolhido = templates.find((item) => String(item.id) === value);
                    setTemplateEscolhido(value);
                    if (!escolhido?.possui_conexao && selectedServices.includes("configuracao_conexao")) {
                      setSelectedServices((current) => current.filter((item) => item !== "configuracao_conexao"));
                      setAutomationWarning("A automação de conexão foi desmarcada porque este template não possui dados de conexão do banco cadastrados. Cadastre banco, usuário e senha na tela de Templates para liberar esta opção.");
                    }
                    if (!escolhido?.possui_scheduler && selectedServices.includes("scheduler")) {
                      setSelectedServices((current) => current.filter((item) => item !== "scheduler"));
                      setAutomationWarning("A automação Scheduler foi desmarcada porque este template não possui um comando Scheduler configurado. Configure e salve o Scheduler na tela de Templates.");
                    }
                  }}
                  required={precisaTemplateSelecionado}
                  disabled={criandoLote}
                >
                  <option value="">
                    {precisaTemplateSelecionado
                      ? "Selecione um template"
                      : "Sem template (somente importar e gravar)"}
                  </option>
                  {templates.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}
                </select>
                <small>As demais automações dependem dos dados cadastrados no template.</small>
              </label>
            </div>
            <div className="automation-choice-step">
              <div className="automation-choice-heading">
                <b>2</b>
                <span><strong>Escolha as automações</strong><small>{templateEscolhido ? "Disponibilidade verificada para o template selecionado." : "Importar e gravar pode ser executado sozinho sem template."}</small></span>
              </div>
            <div className="service-selector">
              <button
                type="button"
                disabled={!templateEscolhido}
                className={`service-choice purple ${selectedServices.includes("configuracao_conexao") ? "selected" : ""} ${templateEscolhido && !templates.find((item) => String(item.id) === templateEscolhido)?.possui_conexao ? "unavailable" : ""}`}
                onClick={() => toggleService("configuracao_conexao")}
              >
                <Database />
                <span>
                  <strong>Instalar dados de conexao do robo</strong>
                  <small>{templateEscolhido && !templates.find((item) => String(item.id) === templateEscolhido)?.possui_conexao ? "Indisponível: dados de conexão não cadastrados" : "Aplica a conexão do template"}</small>
                </span>
              </button>
              <button
                type="button"
                disabled={!templateEscolhido}
                className={`service-choice blue ${selectedServices.includes("cadastro_template") ? "selected" : ""}`}
                onClick={() => toggleService("cadastro_template")}
              >
                <Settings2 />
                <span>
                  <strong>Cadastrar</strong>
                  <small>VIEW, TMP e divergências</small>
                </span>
              </button>
              <button
                type="button"
                disabled={!templateEscolhido}
                className={`service-choice blue ${selectedServices.includes("comparar_divergencias") ? "selected" : ""}`}
                onClick={() => toggleService("comparar_divergencias")}
              >
                <ShieldCheck />
                <span>
                  <strong>Comparar divergências</strong>
                  <small>Aplica somente as flags; não altera VIEW/TMP</small>
                </span>
              </button>
              <button
                type="button"
                disabled={criandoLote}
                className={`service-choice green ${selectedServices.includes("importar_e_gravar") ? "selected" : ""}`}
                onClick={() => toggleService("importar_e_gravar")}
              >
                <FilePlus2 />
                <span>
                  <strong>Importar e gravar</strong>
                  <small>Processamento completo</small>
                </span>
              </button>
              <button
                type="button"
                disabled={!templateEscolhido}
                className={`service-choice orange ${selectedServices.includes("configuracao_xml") ? "selected" : ""}`}
                onClick={() => toggleService("configuracao_xml")}
              >
                <Settings2 />
                <span>
                  <strong>Configuração XML</strong>
                  <small>Caminhos do template</small>
                </span>
              </button>
              <button type="button" disabled={!templateEscolhido} className={`service-choice teal ${selectedServices.includes("scheduler") ? "selected" : ""} ${templateEscolhido && !templates.find((item) => String(item.id) === templateEscolhido)?.possui_scheduler ? "unavailable" : ""}`} onClick={() => toggleService("scheduler")}>
                <Clock3 />
                <span><strong>Scheduler</strong><small>{templateEscolhido && !templates.find((item) => String(item.id) === templateEscolhido)?.possui_scheduler ? "Indisponível: configure o Scheduler neste template" : "Executa comandos agendados"}</small></span>
              </button>
            </div>
            </div>
            <div className="modal-step">
              <b>3</b>
              <label>
                CNPJs dos clientes
                <textarea
                  name="cnpjs"
                  rows={7}
                  required
                  inputMode="numeric"
                  value={cnpjText}
                  disabled={criandoLote}
                  onChange={(event) => setCnpjText(event.target.value)}
                  onBlur={() => setCnpjText(parseCnpjs(cnpjText).join("\n"))}
                  placeholder={
                    "Cole um ou vários CNPJs, um por linha\nAceita pontos, barra e hífen"
                  }
                />
              </label>
            </div>
            <div
              className={`cnpj-counter ${parseCnpjs(cnpjText).some((cnpj) => cnpj.length !== 14) ? "invalid" : ""}`}
            >
              <strong>{parseCnpjs(cnpjText).length}</strong> CNPJ(s)
              identificado(s)
              {parseCnpjs(cnpjText).some((cnpj) => cnpj.length !== 14) &&
                " — existe item com quantidade diferente de 14 dígitos"}
            </div>
            {criandoLote && (
              <div className="submission-status">
                <span className="loading-spinner" /> Preparando{" "}
                {parseCnpjs(cnpjText).length} trabalho(s) na fila. Aguarde...
              </div>
            )}
            <button className="primary-button" disabled={criandoLote}>
              {criandoLote ? (
                <>
                  <span className="loading-spinner light" /> Criando
                  trabalhos...
                </>
              ) : (
                <>
                  Executar serviços selecionados <ChevronRight size={18} />
                </>
              )}
            </button>
          </form>
          {automationWarning && (
            <div className="template-message-backdrop" onMouseDown={(event) => event.stopPropagation()}>
              <section className="template-message-box" role="alertdialog" aria-modal="true" aria-labelledby="automation-warning-title">
                <div className="template-message-icon warning"><AlertTriangle size={25} /></div>
                <h2 id="automation-warning-title">Automação indisponível</h2>
                <p>{automationWarning}</p>
                <button type="button" className="primary-button" onClick={() => setAutomationWarning("")}>Entendi</button>
              </section>
            </div>
          )}
        </div>
      )}
      {queryJob && (
        <div className="modal-backdrop" onMouseDown={() => !queryLoading && setQueryJob(null)}>
          <section className="modal sql-query-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title">
              <div><span className="eyebrow dark">CONSULTA REMOTA SOMENTE LEITURA</span><h2>{formatCnpj(queryJob.cnpj)}</h2><p>VIEW: configura&ccedil;&atilde;o enviada pelo App Mix. TMP: dados atuais no banco do cliente.</p></div>
              <button type="button" disabled={queryLoading} onClick={() => setQueryJob(null)}><XCircle /></button>
            </div>
            {!queryOptions && !queryError && <div className="submission-status"><span className="loading-spinner" /> Localizando a m&aacute;quina e as tabelas do job...</div>}
            {queryOptions && <>
              <div className="sql-query-meta"><span>Machine ID: <b>{queryOptions.machine_id.slice(0, 12)}...</b></span><span>Banco: <b>{queryOptions.dialect || "detectado pelo robo"}</b></span><span>Limite: <b>{queryOptions.max_rows} linhas</b></span></div>
              <div className="sql-count-actions"><strong>Consultas r&aacute;pidas:</strong><button type="button" onClick={buildCompareQuery}>Contar e comparar {queryOptions.tables.length} tabelas</button><button type="button" onClick={() => buildCountQuery("VIEW")}>Contar somente VIEWs</button><button type="button" onClick={() => buildCountQuery("TMP")}>Contar somente TMPs</button></div>
              <div className="sql-table-shortcuts">
                {queryOptions.tables.map((table) => <article key={table.key} className={table.type === "VIEW" ? "view" : "tmp"}>
                  <span>{table.group} - {table.type}</span><code>{table.name}</code><div><button type="button" onClick={() => void navigator.clipboard.writeText(table.name)}><Copy size={14} /> Copiar</button><button type="button" onClick={() => setQuerySql(queryPreviewForDialect(table.name))}>Consultar 10</button></div>
                </article>)}
              </div>
              <label className="sql-editor-label">SQL <small>Autocomplete para comandos e para as tabelas exibidas neste job.</small>
                <textarea className="sql-editor" rows={8} spellCheck={false} value={querySql} onKeyDown={handleQueryEditorKey} onChange={(event) => { setQuerySql(event.target.value); setQuerySuggestionIndex(0); setQuerySuggestionsHidden(false); }} placeholder="SELECT * FROM nome_da_view" />
              </label>
              {!querySuggestionsHidden && querySuggestions.length > 0 && <div className="sql-suggestions" role="listbox">{querySuggestions.map((suggestion, index) => <button type="button" role="option" aria-selected={index === querySuggestionIndex} className={index === querySuggestionIndex ? "active" : ""} key={suggestion} onMouseDown={(event) => event.preventDefault()} onClick={() => applyQuerySuggestion(suggestion)}>{suggestion}<small>{index === querySuggestionIndex ? "Enter" : ""}</small></button>)}</div>}
              <div className="sql-query-actions"><small>Apenas SELECT/WITH nas tabelas acima. Comandos de grava&ccedil;&atilde;o s&atilde;o bloqueados e auditados.</small><button type="button" className="primary-button" disabled={queryLoading || !querySql.trim()} onClick={() => void runDatabaseQuery()}>{queryLoading ? "Consultando..." : "Executar consulta"}</button></div>
            </>}
            {queryError && <div className="operation-warning"><AlertTriangle size={19} /><span><strong>Consulta n&atilde;o executada</strong><small>{queryError}</small></span></div>}
            {queryResult && <div className="sql-result"><div><strong>{queryResult.count} linha(s)</strong><small>{queryResult.elapsed_ms} ms{queryResult.limited ? " · resultado limitado" : ""}</small></div><div className="sql-result-table"><table><thead><tr>{queryResult.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{queryResult.rows.map((row, index) => <tr key={index} className={Number(row.DIFERENCA_LINHAS || 0) !== 0 ? "sql-divergent-row" : "sql-equal-row"}>{queryResult.columns.map((column) => <td key={column}>{row[column] == null ? "NULL" : typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column])}</td>)}</tr>)}</tbody></table></div></div>}
          </section>
        </div>
      )}
      {showPartial && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setShowPartial(false)}
        >
          <form
            className="modal import-modal"
            onSubmit={createImportBatch}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <span className="eyebrow dark">AUTOMAÇÃO DE CARGA</span>
                <h2>Importar e gravar</h2>
                <p>
                  Executa o botão IMPORTAR e confirma a importação e gravação
                  nos clientes escolhidos.
                </p>
              </div>
              <button type="button" onClick={() => setShowPartial(false)}>
                <XCircle />
              </button>
            </div>
            <div className="operation-warning">
              <AlertTriangle size={20} />
              <span>
                <strong>Operação de processamento completo</strong>
                <small>
                  Importa dados do cliente, processa na Mix e grava o resultado.
                  Para alterar somente VIEW, TMP e divergências, use Cadastrar
                  template.
                </small>
              </span>
            </div>
            <div className="modal-step">
              <b>1</b>
              <label>
                CNPJs dos clientes
                <textarea
                  rows={7}
                  required
                  inputMode="numeric"
                  value={partialCnpjText}
                  onChange={(event) => setPartialCnpjText(event.target.value)}
                  onBlur={() =>
                    setPartialCnpjText(parseCnpjs(partialCnpjText).join("\n"))
                  }
                  placeholder={
                    "Cole um ou vários CNPJs, um por linha\nAceita pontos, barra e hífen"
                  }
                />
                <small>Esta ação não altera VIEW, TMP ou configurações.</small>
              </label>
            </div>
            <div
              className={`cnpj-counter ${parseCnpjs(partialCnpjText).some((cnpj) => cnpj.length !== 14) ? "invalid" : ""}`}
            >
              <strong>{parseCnpjs(partialCnpjText).length}</strong> CNPJ(s)
              identificado(s)
            </div>
            <button
              className="primary-button import-action"
              title="Executa IMPORTAR e confirma a importação e gravação"
            >
              Importar e gravar nos CNPJs <ChevronRight size={18} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button className="metric" onClick={onClick}>
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
      <ChevronRight className="metric-arrow" size={18} />
    </button>
  );
}
