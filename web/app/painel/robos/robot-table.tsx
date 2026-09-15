"use client";
import { useEffect, useRef } from "react";
import { AlertCircle, CirclePause, CirclePlay, Clock3, RefreshCw } from "lucide-react";
import { agentStatus, formatCnpj, isPending, type Action, type Agent, type Client } from "./robot-model";
import styles from "./robots.module.css";

export function SelectionCheckbox({ checked, mixed = false, disabled, label, onChange }: {
  checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} className={styles.checkbox} type="checkbox" checked={checked} disabled={disabled}
    aria-label={label} aria-checked={mixed ? "mixed" : checked} onChange={event => onChange(event.target.checked)} />;
}

export function ActionButton({ action, disabled, onClick, title, sending = false, bulk = false }: {
  action: Action; disabled?: boolean; onClick: () => void; title?: string; sending?: boolean; bulk?: boolean;
}) {
  const Icon = sending ? RefreshCw : action === "start" ? CirclePlay : action === "pause" ? CirclePause : RefreshCw;
  const label = action === "start" ? "Iniciar" : action === "pause" ? "Pausar" : "Atualizar";
  return <button type="button" className={`${styles.action} ${styles[action]}`} disabled={disabled} onClick={onClick} title={title}>
    <Icon size={15} className={sending ? styles.spinning : undefined} aria-hidden="true" />{label}{bulk ? " Selecionados" : ""}
  </button>;
}

export function RobotRow({ agent, client, selected, busy, locked = false, stale, onSelect, onCommand }: {
  agent: Agent; client?: Client; selected: boolean; busy?: Action; locked?: boolean; stale: boolean;
  onSelect: (selected: boolean) => void; onCommand: (action: Action) => void;
}) {
  const status = agentStatus(agent, stale);
  const pending = isPending(agent);
  const disabled = locked || Boolean(busy) || pending;
  const placeholder = !client || client.status === "loading" ? "Consultando…"
    : client.status === "error" ? "Consulta indisponível" : client.status === "not_found" ? "Cadastro não encontrado" : "Não informado na API";
  const name = client?.client_name || placeholder;
  const identity = `${formatCnpj(agent.cnpj)} · ${agent.machine_id}`;
  const contact = agent.last_seen ? new Date(agent.last_seen).toLocaleString("pt-BR") : "ainda sem contato";
  const commandHint = pending ? `${agent.last_action === "update" ? "Atualização" : "Comando"} em andamento: ${agent.last_command_status === "delivered" ? "recebido; aguardando confirmação" : "aguardando recebimento"}` : agent.last_result;
  return <tr className={selected ? styles.selected : undefined}>
    <td><SelectionCheckbox checked={selected} disabled={Boolean(busy)} label={`Selecionar robô ${identity}`} onChange={onSelect} /></td>
    <td><div className={styles.statusCell}>
      <span className={`${styles.badge} ${styles[status.tone]}`} title={`Último contato: ${contact}. Estado solicitado: ${agent.desired_state === "paused" ? "pausado" : "em execução"}.`}>
        <span className={styles.dot} aria-hidden="true" />{status.label}
      </span>
      {commandHint && <span tabIndex={0} className={styles.commandHint} title={commandHint} aria-label={commandHint}>{pending ? <Clock3 size={15} /> : <AlertCircle size={15} />}</span>}
    </div></td>
    <td className={styles.cnpj}>{formatCnpj(agent.cnpj)}</td>
    <td><div className={styles.clientCell}><span className={styles.truncate} title={name}>{name}</span>
      {client?.status === "error" && <span tabIndex={0} className={styles.lookupError} title={`${client.error} ${client.client_name ? "Exibindo o último cadastro consultado." : ""}`} aria-label={client.error}><AlertCircle size={15} /></span>}
    </div></td>
    <td><code className={styles.machine} tabIndex={0} title={`${agent.machine_id}\nMáquina: ${agent.computer_name} · ${agent.windows_user}\nAgente v${agent.agent_version}\nSessão: ${!agent.agent_online || stale ? "sem confirmação recente" : agent.session_ready ? "disponível" : "aguardando login"}`}>{agent.machine_id}</code></td>
    <td><div className={styles.actions} role="group" aria-label={`Ações do robô ${identity}`}>
      <ActionButton action="start" disabled={disabled} sending={busy === "start"} onClick={() => onCommand("start")} title={`Iniciar Integrador · ${identity}`} />
      <ActionButton action="pause" disabled={disabled} sending={busy === "pause"} onClick={() => onCommand("pause")} title={`Pausar Integrador · ${identity}`} />
      <ActionButton action="update" disabled={disabled || agent.agent_protocol < 2} sending={busy === "update"} onClick={() => onCommand("update")}
        title={agent.agent_protocol < 2 ? "Instale a nova versão do agente localmente para habilitar atualização remota." : `Atualizar agente e instalador · versão atual ${agent.agent_version}`} />
    </div></td>
  </tr>;
}
