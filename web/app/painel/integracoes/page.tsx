"use client";

import { useEffect, useState } from "react";
import { Activity, ArrowLeft, BookOpen, CheckCircle2, ChevronDown, Copy, ExternalLink, KeyRound, RefreshCw, ServerCog, ShieldCheck, XCircle } from "lucide-react";

type Data = {
  configured: boolean;
  key_configured: boolean;
  owner: { login: string; credential_active: boolean } | null;
  selected_credential_user_id: number | null;
  credential_users: Array<{ id: number; nome: string; email: string; credential_active: boolean }>;
  keys: Array<{ id: number; key_prefix: string; active: boolean; last_used_at?: string }>;
  services: Array<{ service_name: string; label: string; active: boolean; host_name?: string }>;
  audits: Array<{ id: number; method: string; path: string; requester: string; status_code: number; created_at: string }>;
};

type ApiOperation = { method: "GET" | "POST"; path: string; title: string; description: string; body?: string };

const operations: ApiOperation[] = [
  { method: "GET", path: "/capabilities", title: "Descobrir capacidades", description: "Explica ao modelo o que a API sabe consultar e executar." },
  { method: "GET", path: "/knowledge?q={pergunta}", title: "Pesquisar conhecimento", description: "Pesquisa regras e instruções cadastradas no painel sem banco vetorial." },
  { method: "GET", path: "/status", title: "Verificar serviços", description: "Confirma banco, API de automação e workers ativos." },
  { method: "GET", path: "/templates", title: "Listar templates", description: "Retorna somente templates existentes e disponíveis." },
  { method: "POST", path: "/lotes", title: "Cadastrar template nos clientes", description: "Enfileira um template existente para um ou mais CNPJs.", body: '{\n  "template_nome": "ECOCENTAURO",\n  "cnpjs": ["00000000000000"]\n}' },
  { method: "POST", path: "/importacoes", title: "Importar e gravar", description: "Enfileira a carga nos CNPJs informados.", body: '{\n  "cnpjs": ["00000000000000"]\n}' },
  { method: "POST", path: "/configuracoes-xml", title: "Aplicar configuração XML", description: "Aplica os caminhos XML já salvos em um template existente.", body: '{\n  "template_nome": "ECOCENTAURO",\n  "cnpjs": ["00000000000000"]\n}' },
  { method: "POST", path: "/conexoes", title: "Instalar dados de conexão", description: "Envia ao robô os dados de conexão já salvos e cifrados no template.", body: '{\n  "template_nome": "ECOCENTAURO",\n  "cnpjs": ["00000000000000"]\n}' },
  { method: "POST", path: "/schedulers", title: "Executar Scheduler", description: "Executa o comando Scheduler salvo no template e aceita machine_ids adicionais autorizados.", body: '{\n  "template_id": 60,\n  "cnpjs": ["00000000000000"],\n  "machine_ids": ["ID_ADICIONAL_AUTORIZADO"]\n}' },
  { method: "GET", path: "/lotes/{lote_id}", title: "Consultar lote", description: "Acompanha todos os jobs pertencentes a um lote." },
  { method: "GET", path: "/jobs/{job_id}", title: "Consultar job", description: "Retorna status, progresso, etapa e eventual erro de um trabalho." },
];

export default function IntegracoesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState("");
  const [newKey, setNewKey] = useState("");
  const [openPath, setOpenPath] = useState("/status");
  const [loading, setLoading] = useState(true);
  const [credentialUserId, setCredentialUserId] = useState("");
  const [origin, setOrigin] = useState("");

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/hermes-admin", { cache: "no-store" });
      if (response.status === 401) return void (location.href = "/login");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Não foi possível carregar a integração.");
      setData(result);
      setCredentialUserId(String(result.selected_credential_user_id || result.credential_users?.find((item: { credential_active: boolean }) => item.credential_active)?.id || ""));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    load().catch((error: Error) => setMessage(error.message));
  }, []);

  const apiBase = origin ? `${origin}/api/hermes/v1` : "/api/hermes/v1";
  const openApiUrl = origin ? `${origin}/api/hermes/openapi.json` : "/api/hermes/openapi.json";

  async function copy(value: string, confirmation: string) {
    await navigator.clipboard.writeText(value);
    setMessage(confirmation);
  }

  async function generate() {
    if (!confirm("Gerar uma nova chave revogará imediatamente a chave Hermes anterior. Continuar?")) return;
    const response = await fetch("/api/hermes-admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential_user_id: Number(credentialUserId) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return setMessage(result.detail || "Não foi possível gerar a chave.");
    setNewKey(result.secret);
    setMessage(result.warning);
    await load();
  }

  async function bindCredential() {
    const response = await fetch("/api/hermes-admin", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential_user_id: Number(credentialUserId) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return setMessage(result.detail || "Não foi possível alterar a credencial técnica.");
    setMessage(`Hermes vinculado à credencial Mix de ${result.login}.`);
    await load();
  }

  return (
    <main className="editor-page hermes-page">
      <header className="editor-header hermes-header">
        <div>
          <a className="back" href="/painel"><ArrowLeft size={17} /> Voltar ao painel</a>
          <span className="eyebrow dark">OPENAPI 3.1 · GATEWAY SEGURO</span>
          <h1>API Hermes</h1>
          <p>Contrato executável para integrar o Hermes à fila do App Mix sem expor a VM.</p>
        </div>
        <div className="hermes-header-actions">
          <a className="secondary-button" href="/painel/integracoes/conhecimento"><BookOpen size={16} /> Conhecimento</a>
          <a className="secondary-button" href="/HERMES_GUIA_MESTRE.md" target="_blank" rel="noreferrer"><BookOpen size={16} /> Guia MD</a>
          <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Atualizar</button>
          <a className="primary-button" href="/api/hermes/openapi.json" target="_blank" rel="noreferrer"><ExternalLink size={16} /> OpenAPI JSON</a>
        </div>
      </header>

      {message && <div className="notice"><span>{message}</span></div>}

      <section className={`credential-banner ${data?.configured ? "active" : "inactive"}`}>
        {data?.configured ? <CheckCircle2 /> : <XCircle />}
        <div><strong>{data?.configured ? "API pronta para integração" : "API ainda não liberada"}</strong><small>{!data ? "Verificando configuração..." : data.configured ? `Operador técnico: ${data.owner?.login}` : "Gere uma chave e mantenha uma credencial Mix ativa."}</small></div>
      </section>

      <div className="hermes-summary-grid">
        <section className="profile-card hermes-summary-card"><ShieldCheck /><div><small>Autenticação</small><strong>Bearer token</strong><span>{data?.key_configured ? "Chave ativa" : "Chave pendente"}</span></div></section>
        <section className="profile-card hermes-summary-card"><ServerCog /><div><small>Base URL</small><strong>/api/hermes/v1</strong><span>HTTPS · JSON</span></div></section>
        <section className="profile-card hermes-summary-card"><Activity /><div><small>Serviços</small><strong>{data?.services.filter((service) => service.active).length || 0}/{data?.services.length || 3} ativos</strong><span>Heartbeat em tempo real</span></div></section>
      </div>

      <section className="profile-card hermes-security-card">
        <div className="section-label"><KeyRound /><strong>Credencial do Hermes</strong><small>A chave fica armazenada somente como hash. O segredo aparece uma única vez.</small></div>
        <div className="hermes-credential-binding">
          <label>Credencial técnica usada nas automações<select value={credentialUserId} onChange={(event) => setCredentialUserId(event.target.value)}><option value="">Selecione uma credencial Mix ativa</option>{data?.credential_users.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={!candidate.credential_active}>{candidate.nome} · {candidate.email}{candidate.credential_active ? "" : " (sem credencial ativa)"}</option>)}</select></label>
          {data?.key_configured && <button className="secondary-button" onClick={() => void bindCredential()} disabled={!credentialUserId}>Vincular credencial</button>}
        </div>
        <div className="hermes-key-status">
          <span className={`status ${data?.key_configured ? "concluido" : "erro"}`}>{data?.key_configured ? "Configurada" : "Pendente"}</span>
          <span>Credencial Mix: {data?.owner?.credential_active ? "ativa" : "pendente"}</span>
          {data?.keys.filter((key) => key.active).map((key) => <span key={key.id}>{key.key_prefix}… · último uso: {key.last_used_at ? new Date(key.last_used_at).toLocaleString("pt-BR") : "ainda não utilizada"}</span>)}
        </div>
        {newKey && <div className="hermes-secret"><label>Copie agora; o segredo não será mostrado novamente<input readOnly value={newKey} onFocus={(event) => event.currentTarget.select()} /></label><button className="secondary-button" onClick={() => void copy(newKey, "Chave copiada com segurança.")}><Copy size={16} /> Copiar</button></div>}
        <button className="primary-button" onClick={() => void generate()}><ShieldCheck size={17} /> {data?.key_configured ? "Rotacionar chave" : "Gerar chave do Hermes"}</button>
      </section>

      <section className="swagger-shell">
        <div className="swagger-title"><div><strong>APP MIX · Gateway Hermes</strong><small>v1.3.0 · cinco automações implementadas</small></div><button className="secondary-button" onClick={() => void copy(openApiUrl, "URL OpenAPI copiada.")}><Copy size={15} /> Copiar OpenAPI</button></div>
        <div className="swagger-server"><span>Servidor</span><code>{apiBase}</code></div>
        <div className="swagger-auth"><ShieldCheck size={16} /><span><b>Authorize</b> · Authorization: Bearer &lt;chave&gt; · POST também exige Idempotency-Key e X-Hermes-User</span></div>
        <div className="swagger-tag"><strong>Automação</strong><small>Endpoints liberados para o Hermes</small></div>
        <div className="swagger-operations">
          {operations.map((operation) => {
            const open = openPath === operation.path;
            return <article className={`swagger-operation ${operation.method.toLowerCase()} ${open ? "open" : ""}`} key={`${operation.method}-${operation.path}`}>
              <button className="swagger-operation-summary" onClick={() => setOpenPath(open ? "" : operation.path)} aria-expanded={open}>
                <span className="swagger-method">{operation.method}</span><code>{operation.path}</code><span>{operation.title}</span><ChevronDown size={17} />
              </button>
              {open && <div className="swagger-operation-body">
                <p>{operation.description}</p><h3>Cabeçalhos</h3>
                <div className="swagger-parameter"><code>Authorization</code><span>Bearer &lt;chave&gt;</span><b>obrigatório</b></div>
                {operation.method === "POST" && <><div className="swagger-parameter"><code>Idempotency-Key</code><span>UUID único por intenção</span><b>obrigatório</b></div><div className="swagger-parameter"><code>X-Hermes-User</code><span>Solicitante da operação</span><b>obrigatório</b></div></>}
                {operation.body && <><h3>Request body · application/json</h3><pre>{operation.body}</pre></>}
                <h3>Respostas</h3><div className="swagger-responses"><span><b>{operation.method === "POST" ? "201" : "200"}</b> Sucesso</span><span><b>401</b> Chave inválida</span><span><b>429</b> Limite excedido</span></div>
              </div>}
            </article>;
          })}
        </div>
      </section>

      <section className="profile-card"><div className="section-label"><Activity /><strong>Serviços da VM</strong><small>Estado consultado pelo Hermes antes de enviar operações.</small></div>{data?.services.map((service) => <div className="team-row" key={service.service_name}><div><strong>{service.label}</strong><small>{service.host_name || "Sem sinal recente"}</small></div><span className={`status ${service.active ? "concluido" : "erro"}`}>{service.active ? "Ativo" : "Inativo"}</span></div>)}</section>
      <section className="profile-card"><div className="section-label"><ShieldCheck /><strong>Cobertura atual da API</strong><small>As cinco automações operacionais estão liberadas; criar ou editar templates continua restrito ao painel.</small></div><div className="team-row"><div><strong>Cadastrar template existente</strong><small>POST /lotes</small></div><span className="status concluido">Liberado</span></div><div className="team-row"><div><strong>Importar e gravar</strong><small>POST /importacoes</small></div><span className="status concluido">Liberado</span></div><div className="team-row"><div><strong>Configuração XML</strong><small>POST /configuracoes-xml</small></div><span className="status concluido">Liberado</span></div><div className="team-row"><div><strong>Dados de conexão do robô</strong><small>POST /conexoes</small></div><span className="status concluido">Liberado</span></div><div className="team-row"><div><strong>Scheduler</strong><small>POST /schedulers</small></div><span className="status concluido">Liberado</span></div></section>
      <section className="profile-card"><h2>Últimas chamadas</h2>{data?.audits.length ? data.audits.map((audit) => <div className="team-row" key={audit.id}><div><strong>{audit.method} {audit.path}</strong><small>{audit.requester} · {new Date(audit.created_at).toLocaleString("pt-BR")}</small></div><span className={`status ${audit.status_code < 400 ? "concluido" : "erro"}`}>{audit.status_code}</span></div>) : <p className="muted">Nenhuma chamada recebida.</p>}</section>
    </main>
  );
}
