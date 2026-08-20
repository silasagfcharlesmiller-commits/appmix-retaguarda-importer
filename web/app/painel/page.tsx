"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, ChevronRight, Clock3, FilePlus2, LayoutDashboard, LogOut, Menu, RefreshCw, Search, Settings2, Sparkles, UserRound, XCircle } from "lucide-react";

type Status = "pendente" | "processando" | "concluido" | "erro" | "cancelado";
type Template = { id: number; nome: string };
type Job = { id: number; cnpj: string; status: Status; tentativas: number; mensagem_erro?: string; criado_em: string; processado_em?: string; template_nome: string };

const statusLabel: Record<Status, string> = { pendente: "Pendente", processando: "Processando", concluido: "Concluido", erro: "Erro", cancelado: "Cancelado" };
const formatCnpj = (value: string) => value.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const formatDate = (value?: string) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const parseCnpjs = (value: string) => [...new Set(value.split(/[\s,;]+/).map((item) => item.replace(/\D/g, "")).filter(Boolean))];

export default function PainelPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Status | "">("");
  const [notice, setNotice] = useState("");
  const [cnpjText, setCnpjText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsResponse, templatesResponse] = await Promise.all([fetch("/api/mix/v1/jobs?limite=100", { cache: "no-store" }), fetch("/api/mix/v1/templates", { cache: "no-store" })]);
      if (jobsResponse.status === 401) return void (window.location.href = "/login");
      if (!jobsResponse.ok || !templatesResponse.ok) throw new Error("Nao foi possivel consultar a API.");
      setJobs((await jobsResponse.json()).items || []);
      setTemplates((await templatesResponse.json()).items || []);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Falha ao carregar dados."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [load]);
  const counts = useMemo(() => jobs.reduce((all, job) => ({ ...all, [job.status]: (all[job.status] || 0) + 1 }), {} as Record<Status, number>), [jobs]);
  const visible = jobs.filter((job) => (!filter || job.status === filter) && (!search || job.cnpj.includes(search.replace(/\D/g, "")) || job.template_nome.toLowerCase().includes(search.toLowerCase())));

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cnpjs = parseCnpjs(cnpjText);
    const tamanhosInvalidos = cnpjs.filter((cnpj) => cnpj.length !== 14);
    if (!cnpjs.length) return setNotice("Informe pelo menos um CNPJ.");
    if (tamanhosInvalidos.length) return setNotice(`${tamanhosInvalidos.length} CNPJ(s) não possuem exatamente 14 dígitos.`);
    const response = await fetch("/api/mix/v1/lotes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template_id: Number(form.get("template_id")), cnpjs, origem: "Painel web" }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return setNotice(result.detail || "Nao foi possivel criar o lote.");
    setNotice(`Lote criado com ${result.quantidade} empresa(s). O worker iniciara o processamento.`);
    setCnpjText("");
    setShowNew(false);
    await load();
  }

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Sparkles size={20} /></span><span>APP MIX</span></div>
        <nav><a className="active" href="/painel"><LayoutDashboard size={19} /> Visao geral</a><a onClick={() => setFilter("pendente")}><Clock3 size={19} /> Fila</a><a onClick={() => setFilter("concluido")}><CheckCircle2 size={19} /> Historico</a><a href="/painel/templates"><Settings2 size={19}/> Templates</a><a href="/painel/perfil"><UserRound size={19}/> Perfil e senha</a></nav>
        <div className="worker-card"><span className="pulse" /><div><strong>Worker</strong><small>Verifique o notebook</small></div></div>
        <button className="logout" onClick={logout}><LogOut size={18} /> Sair</button>
      </aside>

      <main className="content">
        <header className="topbar"><button className="mobile-menu"><Menu /></button><div><span className="eyebrow dark">CENTRAL OPERACIONAL</span><h1>Visao geral</h1></div><div className="top-actions"><button className="icon-button" onClick={load} title="Atualizar"><RefreshCw size={18} /></button><button className="primary-button compact" onClick={() => setShowNew(true)}><FilePlus2 size={18} /> Novo lote</button></div></header>
        {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice("")}><XCircle size={17} /></button></div>}

        <section className="metric-grid">
          <Metric label="Aguardando" value={counts.pendente || 0} icon={<Clock3 />} tone="amber" onClick={() => setFilter("pendente")} />
          <Metric label="Em processamento" value={counts.processando || 0} icon={<Activity />} tone="blue" onClick={() => setFilter("processando")} />
          <Metric label="Concluidos" value={counts.concluido || 0} icon={<CheckCircle2 />} tone="green" onClick={() => setFilter("concluido")} />
          <Metric label="Com erro" value={counts.erro || 0} icon={<AlertTriangle />} tone="red" onClick={() => setFilter("erro")} />
        </section>

        <section className="table-card">
          <div className="table-head"><div><h2>Execucoes recentes</h2><p>Acompanhamento automatico dos ultimos trabalhos</p></div><div className="filters"><label className="search"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar CNPJ ou template" /></label><select value={filter} onChange={(e) => setFilter(e.target.value as Status | "")}><option value="">Todos os status</option>{Object.entries(statusLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div></div>
          <div className="table-wrap"><table><thead><tr><th>ID</th><th>Empresa</th><th>Template</th><th>Status</th><th>Criado em</th><th /></tr></thead><tbody>
            {loading ? <tr><td colSpan={6} className="empty">Atualizando dados...</td></tr> : visible.length === 0 ? <tr><td colSpan={6} className="empty">Nenhuma execucao encontrada.</td></tr> : visible.map((job) => <tr key={job.id}><td className="mono">#{job.id}</td><td><strong>{formatCnpj(job.cnpj)}</strong></td><td>{job.template_nome}</td><td><span className={`status ${job.status}`}>{statusLabel[job.status]}</span></td><td>{formatDate(job.criado_em)}</td><td><ChevronRight size={18} /></td></tr>)}
          </tbody></table></div>
        </section>
      </main>

      {showNew && <div className="modal-backdrop" onMouseDown={() => setShowNew(false)}><form className="modal" onSubmit={createBatch} onMouseDown={(e) => e.stopPropagation()}><div className="modal-title"><div><span className="eyebrow dark">NOVA EXECUCAO</span><h2>Criar lote</h2></div><button type="button" onClick={() => setShowNew(false)}><XCircle /></button></div><label>Template<select name="template_id" required defaultValue=""><option value="" disabled>Selecione um template</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label><label>CNPJs<textarea name="cnpjs" rows={7} required inputMode="numeric" value={cnpjText} onChange={(event) => setCnpjText(event.target.value)} onBlur={() => setCnpjText(parseCnpjs(cnpjText).join("\n"))} placeholder={"Cole um ou vários CNPJs\nAceita pontos, barra e hífen"} /></label><div className={`cnpj-counter ${parseCnpjs(cnpjText).some((cnpj) => cnpj.length !== 14) ? "invalid" : ""}`}><strong>{parseCnpjs(cnpjText).length}</strong> CNPJ(s) identificado(s){parseCnpjs(cnpjText).some((cnpj) => cnpj.length !== 14) && " — existe item com quantidade diferente de 14 dígitos"}</div><button className="primary-button">Enviar para processamento <ChevronRight size={18} /></button></form></div>}
    </div>
  );
}

function Metric({ label, value, icon, tone, onClick }: { label: string; value: number; icon: React.ReactNode; tone: string; onClick: () => void }) {
  return <button className="metric" onClick={onClick}><span className={`metric-icon ${tone}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong></span><ChevronRight className="metric-arrow" size={18} /></button>;
}
