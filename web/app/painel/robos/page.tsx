"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, RefreshCw, Search, X } from "lucide-react";
import { ActionButton, RobotRow, SelectionCheckbox } from "./robot-table";
import { useAgentClients } from "./use-agent-clients";
import { formatCnpj, isPending, matchesSearch, type Action, type Agent } from "./robot-model";
import styles from "./robots.module.css";

export default function RobotsPage() {
  const [items, setItems] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, Action>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [failures, setFailures] = useState<string[]>([]);
  const [refreshError, setRefreshError] = useState("");
  const [clientRevision, setClientRevision] = useState(0);
  const loadingRef = useRef<Promise<void> | null>(null);
  const commandsRef = useRef(new Set<string>());
  const acceptedRef = useRef(new Map<string, { action: Action; requestedAt: string }>());
  const cnpjKey = JSON.stringify([...new Set(items.map(item => item.cnpj))].sort());
  const clients = useAgentClients(cnpjKey, clientRevision);

  const load = useCallback(() => {
    if (loadingRef.current) return loadingRef.current;
    const request = (async () => {
      try {
        const response = await fetch("/api/agents", { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (response.status === 401) return void (window.location.href = "/login");
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result.items)) throw new Error(result.detail || "Não foi possível consultar os robôs.");
        const next: Agent[] = result.items.map((agent: Agent) => {
          const accepted = acceptedRef.current.get(agent.id);
          if (!accepted) return agent;
          if (agent.last_command_at && Date.parse(agent.last_command_at) >= Date.parse(accepted.requestedAt)) {
            acceptedRef.current.delete(agent.id);
            return agent;
          }
          return { ...agent, last_action: accepted.action, last_command_status: "pending" };
        });
        setItems(next);
        setSelected(previous => new Set([...previous].filter(id => next.some(agent => agent.id === id))));
        setRefreshError("");
      } catch (error) {
        setRefreshError(error instanceof Error ? error.message : "Falha ao consultar os robôs.");
      } finally { setLoading(false); }
    })();
    loadingRef.current = request;
    void request.finally(() => { loadingRef.current = null; });
    return request;
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  const visible = items.filter(agent => matchesSearch(agent, clients[agent.cnpj], search));
  const selectedVisible = visible.filter(agent => selected.has(agent.id));
  const eligible = selectedVisible.filter(agent => !isPending(agent) && !busy[agent.id]);
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const sending = Object.keys(busy).length > 0;
  const lookupErrors = new Set(items.filter(agent => clients[agent.cnpj]?.status === "error").map(agent => agent.cnpj)).size;

  async function command(agents: Agent[], action: Action) {
    if (commandsRef.current.size) return;
    // Lock synchronously, including all bulk targets, before the first request.
    const targets = agents.filter(agent => !commandsRef.current.has(agent.id) && !acceptedRef.current.has(agent.id) && !isPending(agent));
    if (!targets.length) return;
    targets.forEach(agent => commandsRef.current.add(agent.id));
    setBusy(previous => ({ ...previous, ...Object.fromEntries(targets.map(agent => [agent.id, action])) }));
    setMessage(`Enviando ${targets.length} solicitação(ões)…`);
    setFailures([]);
    const queue = [...targets];
    const errors: string[] = [];
    let accepted = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const agent = queue.shift()!;
        try {
          const response = await fetch("/api/agents", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent_id: agent.id, action }), signal: AbortSignal.timeout(20000),
          });
          if (response.status === 401) { queue.length = 0; window.location.href = "/login"; throw new Error("Sessão expirada."); }
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.detail || "O comando não foi aceito.");
          accepted++;
          acceptedRef.current.set(agent.id, { action, requestedAt: result.requested_at });
          setItems(previous => previous.map(item => item.id === agent.id ? { ...item, last_action: action, last_command_status: "pending" } : item));
        } catch (error) {
          errors.push(`${formatCnpj(agent.cnpj)} · ${agent.machine_id}: ${error instanceof Error && error.name !== "TimeoutError" ? error.message : "Sem confirmação do envio. Aguarde a próxima consulta antes de tentar novamente."}`);
        }
      }
    }));
    await load();
    targets.forEach(agent => commandsRef.current.delete(agent.id));
    setBusy(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !targets.some(agent => agent.id === id))));
    setMessage(`${accepted} de ${targets.length} solicitação(ões) de ${action === "start" ? "início" : action === "pause" ? "pausa" : "atualização"} aceita(s). ${accepted ? "Aguardando confirmação dos agentes." : ""}`);
    setFailures(errors);
  }

  function selectAll(checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous);
      visible.forEach(agent => { if (checked) next.add(agent.id); else next.delete(agent.id); });
      return next;
    });
  }

  return <main className={`editor-page ${styles.page}`}>
    <header className={`editor-header ${styles.header}`}>
      <div><a className="back" href="/painel"><ArrowLeft size={17} /> Voltar ao painel</a>
        <span className="eyebrow dark">CONTROLE REMOTO DO INTEGRADOR</span><h1>Robôs dos clientes</h1>
        <p>Cadastro automático por CNPJ · Status a cada 2 segundos. Processo aberto não confirma conexão com a retaguarda.</p>
      </div>
      <button className={`secondary-button ${styles.refresh}`} disabled={loading} onClick={() => { void load(); setClientRevision(value => value + 1); }}><RefreshCw size={16} /> Atualizar lista</button>
    </header>
    <div className={styles.summary} aria-label="Resumo dos robôs">
      <span><Bot size={16} /> <strong>{items.length}</strong> robôs</span>
      <span><i className={`${styles.dot} ${styles.onlineDot}`} /><strong>{items.filter(item => item.agent_online && item.integrator_observed && item.integrator_online && !refreshError).length}</strong> processos abertos</span>
      <span><i className={`${styles.dot} ${styles.pausedDot}`} /><strong>{items.filter(item => item.desired_state === "paused").length}</strong> com pausa solicitada</span>
    </div>
    {refreshError && <div className="notice" role="alert">{refreshError} Última leitura preservada; nova tentativa automática.</div>}
    {lookupErrors > 0 && <div className="notice" role="status">Cadastro indisponível para {lookupErrors} CNPJ(s). Nova tentativa automática em até um minuto; use Atualizar lista para tentar agora.</div>}
    <div aria-live="polite" aria-atomic="true">
      {message && <div className="notice">{message}</div>}
      {failures.length > 0 && <ul className={styles.failures}>{failures.map(failure => <li key={failure}>{failure}</li>)}</ul>}
    </div>
    <section className={styles.panel} aria-label="Gerenciamento de robôs">
      <div className={styles.toolbar}>
        <label className={styles.search}><Search size={18} aria-hidden="true" /><span className={styles.srOnly}>Pesquisar por CNPJ, Machine ID ou nome do cliente</span>
          <input type="search" value={search} placeholder="CNPJ, Machine ID ou nome do cliente" onChange={event => setSearch(event.target.value)} />
        </label>
        <div className={styles.bulkActions}>
          <ActionButton action="start" bulk disabled={eligible.length === 0 || sending} onClick={() => void command(eligible, "start")} />
          <ActionButton action="pause" bulk disabled={eligible.length === 0 || sending} onClick={() => void command(eligible, "pause")} />
        </div>
      </div>
      <div className={styles.selectionInfo}>
        <span>{visible.length} de {items.length} robôs · {selectedVisible.length} selecionados no filtro{selected.size > selectedVisible.length ? ` · ${selected.size - selectedVisible.length} fora do filtro` : ""}</span>
        {selected.size > 0 && <button type="button" disabled={sending} onClick={() => setSelected(new Set())}><X size={13} /> Limpar seleção</button>}
        <small>Ações em massa usam somente os selecionados visíveis sem comando pendente.</small>
      </div>
      <div className={styles.tableScroll} role="region" aria-label="Tabela de robôs; role horizontalmente para ver todas as colunas" tabIndex={0} aria-busy={loading}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>Robôs dos clientes com cadastro automático e controles individuais</caption>
          <colgroup><col className={styles.checkColumn} /><col className={styles.statusColumn} /><col className={styles.cnpjColumn} /><col className={styles.nameColumn} /><col className={styles.machineColumn} /><col className={styles.actionsColumn} /></colgroup>
          <thead><tr>
            <th scope="col"><SelectionCheckbox checked={allSelected} mixed={selectedVisible.length > 0 && !allSelected} disabled={!visible.length || sending} label="Selecionar todos os robôs do filtro" onChange={selectAll} /></th>
            <th scope="col">Status</th><th scope="col">CNPJ</th><th scope="col">Nome do Cliente</th><th scope="col">Machine ID</th><th scope="col">Ações rápidas</th>
          </tr></thead>
          <tbody>{loading ? <tr><td colSpan={6} className={styles.empty}>Consultando robôs…</td></tr> : visible.length === 0 ?
            <tr><td colSpan={6} className={styles.empty}>{refreshError && !items.length ? "A consulta falhou. Use Atualizar lista para tentar novamente." : items.length ? "Nenhum robô corresponde à pesquisa." : "Nenhuma máquina vinculada. Os robôs aparecerão após a instalação e o cadastro do agente."}</td></tr> :
            visible.map(agent => <RobotRow key={agent.id} agent={agent} client={clients[agent.cnpj]} selected={selected.has(agent.id)} busy={busy[agent.id]} locked={sending} stale={Boolean(refreshError)}
              onSelect={checked => setSelected(previous => { const next = new Set(previous); if (checked) next.add(agent.id); else next.delete(agent.id); return next; })}
              onCommand={action => void command([agent], action)} />)}
          </tbody>
        </table>
      </div>
    </section>
  </main>;
}
