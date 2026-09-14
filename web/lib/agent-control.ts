import "server-only";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { ensureCredentials } from "@/lib/credentials";

const machinePattern = /^[a-f0-9]{32,128}$/i;
const actions = new Set(["start", "pause", "restart", "update"]);
const states = new Set(["running", "paused"]);
let ready: Promise<void> | null = null;

export type AgentRow = {
  id: string;
  owner_id: number;
  cnpj: string;
  machine_id: string;
  computer_name: string;
  client_name: string;
  retaguarda: string;
  windows_user: string;
  integrator_path: string;
  agent_version: string;
  desired_state: "running" | "paused";
  integrator_online: boolean;
  session_ready: boolean;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
};

export async function ensureAgentTables() {
  ready ??= transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mix-agent-schema-v2'))");
    await client.query(`CREATE TABLE IF NOT EXISTS public.mix_agents (
    id UUID PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES public.web_users(id) ON DELETE CASCADE,
    cnpj CHAR(14) NOT NULL, machine_id VARCHAR(180) NOT NULL,
    computer_name VARCHAR(180) NOT NULL, windows_user VARCHAR(260) NOT NULL,
    integrator_path TEXT NOT NULL, agent_version VARCHAR(40) NOT NULL,
    device_secret_hash CHAR(64) NOT NULL, desired_state VARCHAR(20) NOT NULL DEFAULT 'running',
    integrator_online BOOLEAN NOT NULL DEFAULT FALSE, session_ready BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mix_agents_identity_unique UNIQUE(owner_id,cnpj,machine_id,computer_name),
    CONSTRAINT mix_agents_state_valid CHECK(desired_state IN ('running','paused'))
  );
  CREATE TABLE IF NOT EXISTS public.mix_agent_commands (
    id BIGSERIAL PRIMARY KEY, agent_id UUID NOT NULL REFERENCES public.mix_agents(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
    requested_by VARCHAR(180) NOT NULL, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, success BOOLEAN, result_message VARCHAR(800),
    CONSTRAINT mix_agent_action_valid CHECK(action IN ('start','pause','restart')),
    CONSTRAINT mix_agent_command_status_valid CHECK(status IN ('pending','delivered','completed','failed'))
  );
  ALTER TABLE public.mix_agents ADD COLUMN IF NOT EXISTS integrator_observed BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE public.mix_agents ADD COLUMN IF NOT EXISTS agent_protocol INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE public.mix_agents ADD COLUMN IF NOT EXISTS client_name VARCHAR(180) NOT NULL DEFAULT '';
  ALTER TABLE public.mix_agents ADD COLUMN IF NOT EXISTS retaguarda VARCHAR(180) NOT NULL DEFAULT '';
  DO $agent_update$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.mix_agent_commands'::regclass AND conname='mix_agent_action_update_valid') THEN
      ALTER TABLE public.mix_agent_commands DROP CONSTRAINT IF EXISTS mix_agent_action_valid;
      ALTER TABLE public.mix_agent_commands ADD CONSTRAINT mix_agent_action_update_valid CHECK(action IN ('start','pause','restart','update'));
    END IF;
  END $agent_update$;
  CREATE INDEX IF NOT EXISTS mix_agents_owner_idx ON public.mix_agents(owner_id,last_seen DESC);
  CREATE INDEX IF NOT EXISTS mix_agent_commands_pending_idx ON public.mix_agent_commands(agent_id,status,id);`);
  }).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

export async function identifyAgent(ownerId: number, agentId: string, clientName: string, retaguarda: string) {
  await ensureAgentTables();
  const result = await query("UPDATE public.mix_agents SET client_name=$1,retaguarda=$2,updated_at=NOW() WHERE id=$3 AND owner_id=$4 RETURNING id", [clientName.trim().slice(0,180),retaguarda.trim().slice(0,180),agentId,ownerId]);
  if (!result.rowCount) throw new Error("Agente não encontrado.");
  return {ok:true};
}

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerAgent(input: Record<string, unknown>, mixBearer: string) {
  await ensureAgentTables();
  await ensureCredentials();
  const cnpj = digits(input.cnpj);
  const machineId = String(input.machine_id || "").trim();
  const mixLogin = String(input.mix_login || "").trim().toLowerCase();
  const computerName = String(input.computer_name || "").trim().slice(0, 180);
  const windowsUser = String(input.windows_user || "").trim().slice(0, 260);
  const integratorPath = String(input.integrator_path || "").trim().slice(0, 1200);
  const agentVersion = String(input.agent_version || "").trim().slice(0, 40);
  if (cnpj.length !== 14 || !machinePattern.test(machineId) || !mixLogin || !computerName || !windowsUser || !integratorPath || !agentVersion)
    throw new Error("Dados de vinculacao do Agente incompletos.");
  if (!mixBearer || mixBearer.length < 20) throw new Error("Autenticacao Mix ausente.");

  const validation = await fetch(`https://api.mixfiscal.com.br/integrador/api/v1/settings/details/${encodeURIComponent(machineId)}`, {
    headers: { Authorization: `Bearer ${mixBearer}`, Accept: "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!validation.ok) throw new Error("O App Mix nao confirmou o Machine ID informado.");
  const details = await validation.json().catch(() => ({})) as Record<string, unknown>;
  if (String(details.machine_id || "").trim() !== machineId || digits(details.cnpj_cpf) !== cnpj)
    throw new Error("O Machine ID nao pertence ao CNPJ autenticado.");

  const owners = await query<{ owner_id: number }>(
    `SELECT owner_id FROM public.mix_credentials WHERE ativa=TRUE AND LOWER(login)=LOWER($1) ORDER BY atualizado_em DESC LIMIT 2`,
    [mixLogin],
  );
  if (owners.rowCount !== 1) throw new Error("A credencial Mix precisa estar ativa e vinculada a uma unica conta no App Mix.");
  const ownerId = owners.rows[0].owner_id;
  const clientName = String(input.client_name || details.company_name || details.razao_social || details.client_name || "").trim().slice(0, 180);
  const retaguarda = String(input.retaguarda || details.retaguarda || "").trim().slice(0, 180);
  const secret = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const row = await query<{ id: string }>(`INSERT INTO public.mix_agents
    (id,owner_id,cnpj,machine_id,computer_name,windows_user,integrator_path,agent_version,device_secret_hash,desired_state,last_seen,client_name,retaguarda)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',NULL,$10,$11)
    ON CONFLICT(owner_id,cnpj,machine_id,computer_name) DO UPDATE SET
      client_name=COALESCE(NULLIF(EXCLUDED.client_name,''),mix_agents.client_name),retaguarda=COALESCE(NULLIF(EXCLUDED.retaguarda,''),mix_agents.retaguarda),
      windows_user=EXCLUDED.windows_user,integrator_path=EXCLUDED.integrator_path,
      agent_version=EXCLUDED.agent_version,device_secret_hash=EXCLUDED.device_secret_hash,
      desired_state='running',integrator_online=FALSE,session_ready=FALSE,updated_at=NOW(),last_seen=NULL
    RETURNING id`, [id, ownerId, cnpj, machineId, computerName, windowsUser, integratorPath, agentVersion, hashSecret(secret), clientName, retaguarda]);
  return { agent_id: row.rows[0].id, secret };
}

export async function authenticateAgent(id: string, secret: string) {
  await ensureAgentTables();
  if (!id || !secret) return null;
  const result = await query<AgentRow & { device_secret_hash: string }>(
    "SELECT * FROM public.mix_agents WHERE id=$1", [id],
  );
  const agent = result.rows[0];
  if (!agent || !safeEqual(agent.device_secret_hash, hashSecret(secret))) return null;
  return agent;
}

export async function acceptHeartbeat(agent: AgentRow, input: Record<string, unknown>, statusOnly = false) {
  await ensureAgentTables();
  const online = input.integrator_online === true;
  const observed = input.protocol !== 2 || input.integrator_observed === true;
  const session = input.session_ready === true;
  const version = String(input.agent_version || agent.agent_version).trim().slice(0, 40);
  const updated = await transaction(async (client) => {
    const state = await client.query<{ desired_state: "running" | "paused" }>(
      `UPDATE public.mix_agents SET integrator_online=CASE WHEN $6 THEN $1 ELSE integrator_online END,integrator_observed=$6,session_ready=$2,agent_version=$3,agent_protocol=$5,last_seen=NOW(),updated_at=NOW()
       WHERE id=$4 RETURNING desired_state`, [online, session, version, agent.id, input.protocol === 2 ? 2 : 1, observed],
    );
    if (statusOnly) return {desired_state:state.rows[0].desired_state,command:null};
    await client.query("UPDATE public.mix_agent_commands SET status='failed',success=FALSE,completed_at=NOW(),result_message='Teste expirado; repetir o diagnóstico.' WHERE agent_id=$1 AND requested_by LIKE 'installer-test:%' AND status='pending' AND requested_at<NOW()-INTERVAL '140 seconds'", [agent.id]);
    const command = await client.query<{ id: string; action: string }>(
      `SELECT id,action FROM public.mix_agent_commands
       WHERE agent_id=$1 AND (status='pending' OR (status='delivered' AND delivered_at<NOW()-(CASE WHEN action='update' THEN INTERVAL '15 minutes' ELSE INTERVAL '2 minutes' END)))
       AND NOT EXISTS (SELECT 1 FROM public.mix_agent_commands busy WHERE busy.agent_id=$1 AND busy.status='delivered' AND busy.delivered_at>=NOW()-(CASE WHEN busy.action='update' THEN INTERVAL '15 minutes' ELSE INTERVAL '2 minutes' END))
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [agent.id],
    );
    if (command.rowCount) await client.query(
      "UPDATE public.mix_agent_commands SET status='delivered',delivered_at=NOW() WHERE id=$1",
      [command.rows[0].id],
    );
    return { desired_state: state.rows[0].desired_state, command: command.rows[0] || null };
  });
  return { desired_state: updated.desired_state, command: updated.command ? { id: Number(updated.command.id), action: updated.command.action } : null };
}

export async function completeCommand(agent: AgentRow, input: Record<string, unknown>) {
  const commandId = Number(input.command_id);
  const success = input.success === true;
  const message = String(input.message || "").replace(/[\r\n]+/g, " ").slice(0, 800);
  if (!Number.isSafeInteger(commandId) || commandId <= 0) throw new Error("Comando invalido.");
  const result = await query(`UPDATE public.mix_agent_commands SET status=$1,success=$2,result_message=$3,completed_at=NOW()
    WHERE id=$4 AND agent_id=$5 AND status='delivered' RETURNING id`, [success ? "completed" : "failed", success, message, commandId, agent.id]);
  if (!result.rowCount) {
    const previous = await query("SELECT id FROM public.mix_agent_commands WHERE id=$1 AND agent_id=$2 AND status IN ('completed','failed') AND success=$3", [commandId,agent.id,success]);
    if (!previous.rowCount) throw new Error("Comando não entregue ou não encontrado para este Agente.");
  }
  return { ok: true };
}

export async function listAgents(ownerId: number) {
  await ensureAgentTables();
  return (await query(`SELECT a.id,BTRIM(a.cnpj) AS cnpj,a.machine_id,a.computer_name,a.client_name,a.retaguarda,a.windows_user,a.integrator_path,
      a.agent_version,a.agent_protocol,a.desired_state,a.integrator_online,a.integrator_observed,a.session_ready,a.last_seen,a.created_at,a.updated_at,
      COALESCE(a.last_seen>NOW()-INTERVAL '90 seconds',FALSE) AS agent_online,
      CASE WHEN a.last_seen IS NULL THEN 'pending' WHEN a.last_seen>NOW()-INTERVAL '90 seconds' THEN 'online' WHEN a.last_seen>NOW()-INTERVAL '3 minutes' THEN 'delayed' ELSE 'offline' END AS connection_status,
      c.action AS last_action,c.status AS last_command_status,c.result_message AS last_result,c.requested_at AS last_command_at
    FROM public.mix_agents a LEFT JOIN LATERAL (
      SELECT action,status,result_message,requested_at FROM public.mix_agent_commands WHERE agent_id=a.id ORDER BY id DESC LIMIT 1
    ) c ON TRUE WHERE a.owner_id=$1 ORDER BY a.last_seen DESC NULLS LAST,a.computer_name`, [ownerId])).rows;
}

export async function queueCommand(ownerId: number, agentId: string, action: string, actor: string) {
  await ensureAgentTables();
  if (!actions.has(action)) throw new Error("Acao invalida.");
  const state = action === "update" ? null : action === "pause" ? "paused" : "running";
  if (state !== null && !states.has(state)) throw new Error("Estado invalido.");
  return transaction(async (client) => {
    const found = await client.query("UPDATE public.mix_agents SET desired_state=COALESCE($1,desired_state),updated_at=NOW() WHERE id=$2 AND owner_id=$3 RETURNING id,agent_protocol", [state, agentId, ownerId]);
    if (!found.rowCount) throw new Error("Agente nao encontrado.");
    if (action === "update" && Number(found.rows[0].agent_protocol) < 2) throw new Error("Este agente precisa receber a nova versão localmente uma vez antes de aceitar atualização remota.");
    const pending = await client.query("SELECT id FROM public.mix_agent_commands WHERE agent_id=$1 AND status IN ('pending','delivered') LIMIT 1", [agentId]);
    if (pending.rowCount) throw new Error("Aguarde a conclusão do comando em andamento antes de enviar outro.");
    const command = await client.query("INSERT INTO public.mix_agent_commands(agent_id,action,requested_by) VALUES($1,$2,$3) RETURNING id,action,status,requested_at", [agentId, action, actor.slice(0, 180)]);
    return command.rows[0];
  });
}

// Idempotent test identified by a random nonce; only the enrolled device can
// request/read it. Commands travel through the very same queue as panel actions.
export async function agentSelfTest(agent: AgentRow, input: Record<string, unknown>) {
  const testId = String(input.test_id || "");
  if (!/^[a-f0-9]{32}$/.test(testId)) throw new Error("Identificador de teste inválido.");
  const actor = `installer-test:${testId}`;
  return transaction(async (client) => {
    await client.query("SELECT id FROM public.mix_agents WHERE id=$1 FOR UPDATE", [agent.id]);
    let commands = await client.query<{action: string;status: string;success: boolean;result_message: string}>(
      "SELECT action,status,success,result_message FROM public.mix_agent_commands WHERE agent_id=$1 AND requested_by=$2 ORDER BY id", [agent.id, actor]);
    if (!commands.rowCount) {
      const pending = await client.query("SELECT id FROM public.mix_agent_commands WHERE agent_id=$1 AND status IN ('pending','delivered') LIMIT 1", [agent.id]);
      if (pending.rowCount) return {complete:false,success:false,message:"Aguardando comando anterior."};
      await client.query("UPDATE public.mix_agents SET desired_state='running' WHERE id=$1", [agent.id]);
      await client.query("INSERT INTO public.mix_agent_commands(agent_id,action,requested_by) VALUES($1,'restart',$2),($1,'start',$2)", [agent.id, actor]);
      return {complete:false,success:false,message:"Teste de reinício e início solicitado."};
    }
    // Do not leave a diagnostic command pending indefinitely after the UI closes.
    await client.query("UPDATE public.mix_agent_commands SET status='failed',success=FALSE,completed_at=NOW(),result_message='Teste expirado; repetir o diagnóstico.' WHERE agent_id=$1 AND requested_by=$2 AND status='pending' AND requested_at<NOW()-INTERVAL '140 seconds'", [agent.id, actor]);
    commands = await client.query("SELECT action,status,success,result_message FROM public.mix_agent_commands WHERE agent_id=$1 AND requested_by=$2 ORDER BY id", [agent.id, actor]);
    const complete = commands.rows.length === 2 && commands.rows.every(row => ["completed", "failed"].includes(row.status));
    return {complete, success:complete && commands.rows.every(row => row.success), message:commands.rows.map(row => `${row.action}: ${row.result_message || row.status}`).join("; ")};
  });
}
