"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, CirclePause, CirclePlay, Clock3, MonitorCheck, RefreshCw, RotateCw, ShieldCheck, WifiOff } from "lucide-react";

type Agent = {
  client_name: string; retaguarda: string; agent_protocol: number; connection_status: "online" | "delayed" | "offline" | "pending";
  id: string; cnpj: string; machine_id: string; computer_name: string; windows_user: string;
  integrator_path: string; agent_version: string; desired_state: "running" | "paused";
  integrator_observed: boolean; integrator_online: boolean; session_ready: boolean; agent_online: boolean; last_seen: string | null;
  last_action?: string; last_command_status?: string; last_result?: string;
};

const formatCnpj = (value: string) => value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const seen = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR") : "ainda sem contato";

export default function RobotsPage() {
  const [items, setItems] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<Agent | null>(null);
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const loadingRef = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/agents", { cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (response.status === 401) return void (location.href = "/login");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Nao foi possivel consultar os robos.");
      setItems(result.items || []); setRefreshError("");
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Falha ao consultar os robôs.");
    } finally {
      loadingRef.current = false;
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  async function command(agent: Agent, action: "start" | "pause" | "restart" | "update") {
    const key = `${agent.id}:${action}`;
    setBusy(key); setMessage("");
    try {
      const response = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agent.id, action }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "O comando nao foi aceito.");
      setMessage(action === "update" ? "Atualização solicitada. Acompanhe a versão e a confirmação do Agente." : action === "pause" ? "Pausa solicitada. O Agente manterá o Integrador fechado." : action === "restart" ? "Reinicio solicitado." : "Inicializacao solicitada.");
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao enviar o comando.");
    } finally { setBusy(""); }
  }

  async function saveIdentity() {
    if (!editing) return;
    setBusy("identity");
    try {
      const response = await fetch("/api/agents", {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent_id:editing.id,client_name:editing.client_name,retaguarda:editing.retaguarda})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Falha ao salvar o cliente.");
      setEditing(null); await load(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Falha ao salvar."); }
    finally { setBusy(""); }
  }

  return <main className="editor-page agents-page">
    <header className="editor-header agents-header">
      <div><a className="back" href="/painel"><ArrowLeft size={17}/> Voltar ao painel</a><span className="eyebrow dark">CONTROLE REMOTO DO INTEGRADOR</span><h1>Robôs dos clientes</h1><p>Inicie, pause, reinicie ou atualize o agente. Consulta automática a cada 5 segundos; processo aberto não comprova conexão com a retaguarda.</p></div>
      <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Atualizar</button>
    </header>
    {refreshError && <div className="notice">{refreshError} Última leitura preservada; nova tentativa automática em alguns segundos.</div>}
    {message && <div className="notice"><span>{message}</span></div>}
    {editing && <section className="profile-card" role="dialog" aria-label="Identificar cliente"><h2>Identificar cliente · {formatCnpj(editing.cnpj)}</h2><form onSubmit={event => {event.preventDefault(); void saveIdentity();}}><label>Nome do cliente<input value={editing.client_name || ""} maxLength={180} disabled={busy !== ""} onChange={event => setEditing({...editing,client_name:event.target.value})}/></label><label>Retaguarda<input value={editing.retaguarda || ""} maxLength={180} disabled={busy !== ""} onChange={event => setEditing({...editing,retaguarda:event.target.value})}/></label><button className="primary-button" disabled={busy !== ""}>Salvar</button><button className="secondary-button" type="button" disabled={busy !== ""} onClick={() => setEditing(null)}>Cancelar</button></form></section>}
    <section className="agents-summary">
      <article><ShieldCheck/><div><small>Agentes conectados</small><strong>{items.filter(item => item.agent_online && !refreshError).length}</strong></div></article>
      <article><MonitorCheck/><div><small>Integradores abertos</small><strong>{items.filter(item => item.agent_online && item.integrator_observed && item.integrator_online && !refreshError).length}</strong></div></article>
      <article><CirclePause/><div><small>Pausados pelo painel</small><strong>{items.filter(item => item.desired_state === "paused").length}</strong></div></article>
    </section>
    {loading ? <section className="profile-card agents-empty"><span className="loading-spinner"/> Consultando Agentes...</section> : items.length === 0 ?
      <section className="profile-card agents-empty"><Bot size={34}/><h2>Nenhuma máquina vinculada</h2><p>As máquinas aparecerão aqui depois que o novo instalador concluir o cadastro do Integrador e do Agente.</p></section> :
      <section className="agents-grid">{items.map(agent => {
        const operational = !refreshError && agent.agent_online && agent.integrator_observed && agent.integrator_online;
        const pending = ["pending", "delivered"].includes(agent.last_command_status || "");
        const contact = refreshError ? "CONSULTA INDISPONÍVEL" : agent.connection_status === "delayed" ? "CONTATO ATRASADO" : agent.connection_status === "pending" ? "AGUARDANDO PRIMEIRO CONTATO" : agent.connection_status === "offline" ? "SEM CONTATO RECENTE" : agent.integrator_observed === false ? "PROCESSO SEM CONFIRMAÇÃO" : "";
        return <article className="profile-card agent-card" key={agent.id}>
          <div className="agent-card-head"><div className={`agent-icon ${agent.agent_online ? "online" : "offline"}`}>{agent.agent_online ? <Bot/> : <WifiOff/>}</div><div><small>{formatCnpj(agent.cnpj)}</small><h2>{agent.client_name || `Cliente ${formatCnpj(agent.cnpj)}`}</h2><span>{agent.retaguarda || "Retaguarda não informada"}</span><button className="secondary-button" disabled={busy !== ""} onClick={() => setEditing({...agent})}>Identificar cliente</button></div><b className={`agent-badge ${operational ? "online" : agent.desired_state === "paused" ? "paused" : "offline"}`}>{contact || (operational ? "PROCESSO ABERTO" : agent.desired_state === "paused" ? "PAUSADO" : agent.agent_online ? "INTEGRADOR PARADO" : "SEM CONTATO RECENTE")}</b></div>
          <div className="agent-details"><span><small>Máquina / conta</small><strong>{agent.computer_name} · {agent.windows_user.split("\\").pop()}</strong></span><span><small>Machine ID</small><code title={agent.machine_id}>{agent.machine_id.slice(0, 16)}…</code></span><span><small>Agente</small><strong>v{agent.agent_version}</strong></span><span><small>Sessão do Windows</small><strong>{!agent.agent_online || refreshError ? "Sem confirmação recente" : agent.session_ready ? "Disponível" : "Aguardando login"}</strong></span><span><small>Último contato</small><strong>{seen(agent.last_seen)}</strong></span></div>
          {pending && <div className="agent-last-result"><Clock3 size={15}/><span>{agent.last_action === "update" ? "Atualização em andamento" : "Comando em andamento"} · {agent.last_command_status === "pending" ? "aguardando recebimento pelo agente" : "recebido; aguardando confirmação na máquina"}</span></div>}
          {agent.last_result && <div className="agent-last-result"><Clock3 size={15}/><span>{agent.last_result}</span></div>}
          <div className="agent-actions">{agent.desired_state === "paused" || !agent.integrator_online ? <button className="primary-button" disabled={busy !== "" || pending} onClick={() => void command(agent, "start")}><CirclePlay size={17}/> Iniciar</button> : <button className="agent-pause" disabled={busy !== "" || pending} onClick={() => void command(agent, "pause")}><CirclePause size={17}/> Pausar</button>}<button className="secondary-button" disabled={busy !== "" || pending} onClick={() => void command(agent, "restart")}><RotateCw size={16}/> Reiniciar</button><button className="secondary-button" disabled={busy !== "" || pending || agent.agent_protocol < 2} title={agent.agent_protocol < 2 ? "Instale uma vez a nova versão do agente para habilitar atualização remota." : "Atualizar agente e instalador"} onClick={() => void command(agent, "update")}><RefreshCw size={16}/> Atualizar agente</button></div>
        </article>;
      })}</section>}
  </main>;
}
