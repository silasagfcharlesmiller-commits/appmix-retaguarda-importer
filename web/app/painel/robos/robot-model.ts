export type Agent = {
  id: string; cnpj: string; machine_id: string; computer_name: string; windows_user: string;
  agent_version: string; agent_protocol: number; desired_state: "running" | "paused";
  connection_status: "online" | "delayed" | "offline" | "pending";
  integrator_observed: boolean; integrator_online: boolean; session_ready: boolean;
  agent_online: boolean; last_seen: string | null;
  last_action?: string; last_command_status?: string; last_result?: string; last_command_at?: string;
};
export type Action = "start" | "pause" | "update";
export type Client = {
  cnpj: string; client_name: string; retaguarda: string;
  status: "loading" | "loaded" | "not_found" | "error"; error?: string;
};
export const formatCnpj = (value: string) => value.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
export const isPending = (agent: Agent) => ["pending", "delivered"].includes(agent.last_command_status || "");
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export function matchesSearch(agent: Agent, client: Client | undefined, search: string) {
  const term = normalize(search);
  if (!term) return true;
  const digits = term.replace(/\D/g, "");
  return normalize(agent.machine_id).includes(term) || normalize(client?.client_name || "").includes(term)
    || (Boolean(digits) && /^[\d\s./-]+$/.test(term) && agent.cnpj.replace(/\D/g, "").includes(digits));
}

export function agentStatus(agent: Agent, stale: boolean) {
  if (stale) return { label: "Consulta indisponível", tone: "warning" };
  if (agent.connection_status === "pending") return { label: "Aguardando contato", tone: "neutral" };
  if (agent.connection_status === "delayed") return { label: "Contato atrasado", tone: "warning" };
  if (!agent.agent_online || agent.connection_status === "offline") return { label: "Sem contato recente", tone: "danger" };
  if (!agent.integrator_observed) return { label: "Processo não confirmado", tone: "warning" };
  if (agent.integrator_online) return { label: "Processo aberto", tone: "success" };
  if (agent.desired_state === "paused") return { label: "Pausado", tone: "warning" };
  return { label: "Integrador parado", tone: "danger" };
}
