"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, CirclePause, CirclePlay, Clock3, MonitorCheck, RefreshCw, RotateCw, Search, ShieldCheck, WifiOff } from "lucide-react";

type CommandAction = "start" | "pause" | "restart";
type CommandStatus = "sending" | "pending" | "delivered" | "completed" | "failed";
type Operation = { commandId?: string; action: CommandAction; status: CommandStatus };
type Agent = {
  id: string; cnpj: string; machine_id: string; computer_name: string; windows_user: string;
  integrator_path: string; agent_version: string; desired_state: "running" | "paused";
  integrator_online: boolean; session_ready: boolean; agent_online: boolean; last_seen: string | null;
  last_command_id?: string; last_action?: CommandAction; last_command_status?: CommandStatus;
  last_result?: string; last_command_at?: string;
};

const actionName: Record<CommandAction, string> = { start: "Inicialização", pause: "Pausa", restart: "Reinício" };
const progress: Record<CommandStatus, number> = { sending: 12, pending: 38, delivered: 72, completed: 100, failed: 100 };
const formatCnpj = (value: string) => value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const seen = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR") : "ainda sem contato";
const activeStatus = (status: CommandStatus) => status === "sending" || status === "pending" || status === "delivered";

function progressText(status: CommandStatus) {
  if (status === "sending") return "Enviando solicitação";
  if (status === "pending") return "Aguardando contato do Agent";
  if (status === "delivered") return "Executando na máquina";
  if (status === "failed") return "A máquina informou uma falha";
  return "Comando concluído";
}

export default function RobotsPage() {
  const [items, setItems] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [operations, setOperations] = useState<Record<string, Operation>>({});
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const locks = useRef(new Set<string>());

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/agents", { cache: "no-store" });
      if (response.status === 401) return void (location.href = "/login");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Não foi possível consultar os robôs.");
      const agents = (result.items || []) as Agent[];
      setItems(agents);
      setOperations(current => {
        let changed = false;
        const next = { ...current };
        for (const agent of agents) {
          const operation = next[agent.id];
          if (!operation && agent.last_command_id && agent.last_action && agent.last_command_status && activeStatus(agent.last_command_status)) {
            next[agent.id] = { commandId: String(agent.last_command_id), action: agent.last_action, status: agent.last_command_status };
            locks.current.add(agent.id);
            changed = true;
            continue;
          }
          if (!operation?.commandId || String(agent.last_command_id || "") !== operation.commandId) continue;
          const status = agent.last_command_status;
          if (!status || status === operation.status) continue;
          next[agent.id] = { ...operation, status };
          if (!activeStatus(status)) locks.current.delete(agent.id);
          changed = true;
        }
        return changed ? next : current;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao consultar os robôs.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const waiting = Object.values(operations).some(operation => activeStatus(operation.status));
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), waiting ? 2500 : 15000);
    return () => window.clearInterval(timer);
  }, [load, waiting]);

  const visibleItems = useMemo(() => {
    const term = search.replace(/\s/g, "").toLowerCase();
    return items.filter(agent => {
      const matchesText = !term || [agent.cnpj, agent.computer_name, agent.windows_user, agent.machine_id]
        .some(value => String(value || "").replace(/\s/g, "").toLowerCase().includes(term));
      const matchesStatus = filter === "all" ||
        (filter === "online" && agent.agent_online && agent.integrator_online) ||
        (filter === "paused" && agent.desired_state === "paused") ||
        (filter === "offline" && !agent.agent_online);
      return matchesText && matchesStatus;
    });
  }, [items, search, filter]);

  async function command(agent: Agent, action: CommandAction) {
    if (locks.current.has(agent.id) || activeStatus(operations[agent.id]?.status || "completed")) return;
    locks.current.add(agent.id);
    setOperations(current => ({ ...current, [agent.id]: { action, status: "sending" } }));
    setMessage("");
    try {
      const response = await fetch("/api/agents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agent.id, action }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "O comando não foi aceito.");
      setOperations(current => ({ ...current, [agent.id]: { action, commandId: String(result.id), status: "pending" } }));
      await load(true);
    } catch (error) {
      locks.current.delete(agent.id);
      setOperations(current => { const next = { ...current }; delete next[agent.id]; return next; });
      setMessage(error instanceof Error ? error.message : "Falha ao enviar o comando.");
    }
  }

  return <main className="editor-page agents-page">
    <header className="editor-header agents-header">
      <div><a className="back" href="/painel"><ArrowLeft size={17}/> Voltar ao painel</a><span className="eyebrow dark">CONTROLE REMOTO DO INTEGRADOR</span><h1>Robôs dos clientes</h1><p>Acompanhe e controle cada máquina em uma lista única.</p></div>
      <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16}/> Atualizar</button>
    </header>
    {message && <div className="notice"><span>{message}</span></div>}
    <section className="agents-summary">
      <article><ShieldCheck/><div><small>Agentes conectados</small><strong>{items.filter(item => item.agent_online).length}</strong></div></article>
      <article><MonitorCheck/><div><small>Integradores abertos</small><strong>{items.filter(item => item.integrator_online).length}</strong></div></article>
      <article><CirclePause/><div><small>Pausados</small><strong>{items.filter(item => item.desired_state === "paused").length}</strong></div></article>
    </section>
    <section className="agents-toolbar">
      <label><Search size={17}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por CNPJ, máquina ou usuário"/></label>
      <select value={filter} onChange={event => setFilter(event.target.value)} aria-label="Filtrar robôs por status"><option value="all">Todos os status</option><option value="online">Online</option><option value="paused">Pausados</option><option value="offline">Agent offline</option></select>
      <small>{visibleItems.length} de {items.length} robô(s)</small>
    </section>
    {loading ? <section className="profile-card agents-empty"><span className="loading-spinner"/> Consultando Agents...</section> : items.length === 0 ?
      <section className="profile-card agents-empty"><Bot size={34}/><h2>Nenhuma máquina vinculada</h2><p>As máquinas aparecerão aqui depois que o instalador concluir o cadastro do Integrador e do Agent.</p></section> : visibleItems.length === 0 ?
      <section className="profile-card agents-empty"><Search size={30}/><h2>Nenhum robô encontrado</h2><p>Altere a busca ou o filtro para visualizar outras máquinas.</p></section> :
      <section className="agents-list">{visibleItems.map(agent => {
        const operational = agent.agent_online && agent.integrator_online;
        const operation = operations[agent.id];
        const blocked = Boolean(operation && activeStatus(operation.status));
        return <article className={`profile-card agent-row ${blocked ? "command-running" : ""}`} key={agent.id}>
          <div className="agent-identity"><div className={`agent-icon ${agent.agent_online ? "online" : "offline"}`}>{agent.agent_online ? <Bot/> : <WifiOff/>}</div><div><small>{formatCnpj(agent.cnpj)}</small><h2>{agent.computer_name}</h2><span>{agent.windows_user}</span></div></div>
          <div className="agent-state"><b className={`agent-badge ${operational ? "online" : agent.desired_state === "paused" ? "paused" : "offline"}`}>{operational ? "ONLINE" : agent.desired_state === "paused" ? "PAUSADO" : agent.agent_online ? "INTEGRADOR PARADO" : "AGENT OFFLINE"}</b><small>{seen(agent.last_seen)}</small></div>
          <div className="agent-inline-details"><span><small>Machine ID</small><code title={agent.machine_id}>{agent.machine_id.slice(0, 12)}…</code></span><span><small>Sessão</small><strong>{agent.session_ready ? "Disponível" : "Sem login"}</strong></span><span><small>Agent</small><strong>v{agent.agent_version}</strong></span></div>
          <div className="agent-command-cell">{operation ? <div className={`agent-progress ${operation.status}`}><div><strong>{actionName[operation.action]}</strong><small>{progressText(operation.status)}</small></div><div className="agent-progress-track"><span style={{ width: `${progress[operation.status]}%` }}/></div><div className="agent-progress-steps"><span className="done">Enviado</span><span className={progress[operation.status] >= 72 ? "done" : ""}>Recebido</span><span className={operation.status === "completed" ? "done" : operation.status === "failed" ? "failed" : ""}>{operation.status === "failed" ? "Falhou" : "Concluído"}</span></div></div> : agent.last_result ? <div className="agent-last-result"><Clock3 size={15}/><span title={agent.last_result}>{agent.last_result}</span></div> : <small className="agent-no-command">Nenhum comando recente</small>}</div>
          <div className="agent-actions">{agent.desired_state === "paused" || !agent.integrator_online ? <button className="primary-button" disabled={blocked} onClick={() => void command(agent, "start")}><CirclePlay size={17}/>{blocked ? "Aguarde" : "Iniciar"}</button> : <button className="agent-pause" disabled={blocked} onClick={() => void command(agent, "pause")}><CirclePause size={17}/>{blocked ? "Aguarde" : "Pausar"}</button>}<button className="secondary-button" disabled={blocked} onClick={() => void command(agent, "restart")}><RotateCw size={16}/> Reiniciar</button></div>
        </article>;
      })}</section>}
  </main>;
}
