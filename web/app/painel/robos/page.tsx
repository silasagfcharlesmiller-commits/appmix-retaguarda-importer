"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bot, CirclePause, CirclePlay, Clock3, MonitorCheck, RefreshCw, RotateCw, ShieldCheck, WifiOff } from "lucide-react";

type Agent = {
  id: string; cnpj: string; machine_id: string; computer_name: string; windows_user: string;
  integrator_path: string; agent_version: string; desired_state: "running" | "paused";
  integrator_online: boolean; session_ready: boolean; agent_online: boolean; last_seen: string | null;
  last_action?: string; last_command_status?: string; last_result?: string;
};

const formatCnpj = (value: string) => value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const seen = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR") : "ainda sem contato";

export default function RobotsPage() {
  const [items, setItems] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/agents", { cache: "no-store" });
      if (response.status === 401) return void (location.href = "/login");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Nao foi possivel consultar os robos.");
      setItems(result.items || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao consultar os robos.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function command(agent: Agent, action: "start" | "pause" | "restart") {
    const key = `${agent.id}:${action}`;
    setBusy(key); setMessage("");
    try {
      const response = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agent.id, action }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "O comando nao foi aceito.");
      setMessage(action === "pause" ? "Pausa solicitada. O Agente manterá o Integrador fechado." : action === "restart" ? "Reinicio solicitado." : "Inicializacao solicitada.");
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao enviar o comando.");
    } finally { setBusy(""); }
  }

  return <main className="editor-page agents-page">
    <header className="editor-header agents-header">
      <div><a className="back" href="/painel"><ArrowLeft size={17}/> Voltar ao painel</a><span className="eyebrow dark">CONTROLE REMOTO DO INTEGRADOR</span><h1>Robôs dos clientes</h1><p>Inicie, pause ou reinicie o Integrador na máquina vinculada ao CNPJ.</p></div>
      <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Atualizar</button>
    </header>
    {message && <div className="notice"><span>{message}</span></div>}
    <section className="agents-summary">
      <article><ShieldCheck/><div><small>Agentes conectados</small><strong>{items.filter(item => item.agent_online).length}</strong></div></article>
      <article><MonitorCheck/><div><small>Integradores abertos</small><strong>{items.filter(item => item.integrator_online).length}</strong></div></article>
      <article><CirclePause/><div><small>Pausados pelo painel</small><strong>{items.filter(item => item.desired_state === "paused").length}</strong></div></article>
    </section>
    {loading ? <section className="profile-card agents-empty"><span className="loading-spinner"/> Consultando Agentes...</section> : items.length === 0 ?
      <section className="profile-card agents-empty"><Bot size={34}/><h2>Nenhuma máquina vinculada</h2><p>As máquinas aparecerão aqui depois que o novo instalador concluir o cadastro do Integrador e do Agente.</p></section> :
      <section className="agents-grid">{items.map(agent => {
        const operational = agent.agent_online && agent.integrator_online;
        return <article className="profile-card agent-card" key={agent.id}>
          <div className="agent-card-head"><div className={`agent-icon ${agent.agent_online ? "online" : "offline"}`}>{agent.agent_online ? <Bot/> : <WifiOff/>}</div><div><small>{formatCnpj(agent.cnpj)}</small><h2>{agent.computer_name}</h2><span>{agent.windows_user}</span></div><b className={`agent-badge ${operational ? "online" : agent.desired_state === "paused" ? "paused" : "offline"}`}>{operational ? "ONLINE" : agent.desired_state === "paused" ? "PAUSADO" : agent.agent_online ? "INTEGRADOR PARADO" : "AGENTE OFFLINE"}</b></div>
          <div className="agent-details"><span><small>Machine ID</small><code title={agent.machine_id}>{agent.machine_id.slice(0, 16)}…</code></span><span><small>Agente</small><strong>v{agent.agent_version}</strong></span><span><small>Sessão do Windows</small><strong>{agent.session_ready ? "Disponível" : "Aguardando login"}</strong></span><span><small>Último contato</small><strong>{seen(agent.last_seen)}</strong></span></div>
          {agent.last_result && <div className="agent-last-result"><Clock3 size={15}/><span>{agent.last_result}</span></div>}
          <div className="agent-actions">{agent.desired_state === "paused" || !agent.integrator_online ? <button className="primary-button" disabled={busy !== ""} onClick={() => void command(agent, "start")}><CirclePlay size={17}/> Iniciar</button> : <button className="agent-pause" disabled={busy !== ""} onClick={() => void command(agent, "pause")}><CirclePause size={17}/> Pausar</button>}<button className="secondary-button" disabled={busy !== ""} onClick={() => void command(agent, "restart")}><RotateCw size={16}/> Reiniciar</button></div>
        </article>;
      })}</section>}
  </main>;
}
