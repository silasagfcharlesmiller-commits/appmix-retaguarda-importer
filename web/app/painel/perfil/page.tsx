"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Save,
  ShieldCheck,
  UserPlus,
  UserRound,
  XCircle,
} from "lucide-react";
type Credential = { login: string; ativa: boolean; validada_em: string | null };
type Collaborator = {
  id: number;
  nome: string;
  email: string;
  role: "admin" | "colaborador";
  ativo: boolean;
};
export default function ProfilePage() {
  const [user, setUser] = useState({
      id: 0,
      owner_id: 0,
      nome: "",
      email: "",
      role: "colaborador",
    }),
    [credential, setCredential] = useState<Credential>({
      login: "",
      ativa: false,
      validada_em: null,
    }),
    [team, setTeam] = useState<Collaborator[]>([]),
    [message, setMessage] = useState(""),
    [showMixPassword, setShowMixPassword] = useState(false),
    [showPanelPasswords, setShowPanelPasswords] = useState(false),
    [showInitialPassword, setShowInitialPassword] = useState(false),
    [resetTarget, setResetTarget] = useState<Collaborator | null>(null),
    [showResetPassword, setShowResetPassword] = useState(false);
  const load = useCallback(async () => {
    const [p, c, t] = await Promise.all([
      fetch("/api/profile"),
      fetch("/api/credentials"),
      fetch("/api/collaborators"),
    ]);
    if (p.status === 401) return void (location.href = "/login");
    setUser(await p.json());
    setCredential(await c.json());
    setTeam((await t.json()).items || []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(url: string, method: string, body: object) {
    const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      j = await r.json();
    if (!r.ok) {
      setMessage(j.detail);
      return false;
    }
    return j;
  }
  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("nova_senha") !== f.get("confirmar_senha"))
      return setMessage("A confirmacao da nova senha nao confere.");
    const j = await send("/api/profile", "PATCH", {
      login: f.get("login"),
      senha_atual: f.get("senha_atual"),
      nova_senha: f.get("nova_senha"),
    });
    if (j) {
      setUser(j);
      setMessage("Login e senha atualizados.");
      window.alert(
        "Seu login e sua senha do painel foram atualizados com sucesso.",
      );
      e.currentTarget.reset();
    }
  }
  async function saveCredential(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setMessage("Validando a credencial no App Mix...");
    const j = await send("/api/credentials", "PUT", {
      login: f.get("mix_login"),
      password: f.get("mix_password"),
    });
    if (j) {
      setCredential(j);
      setMessage("Credencial Mix validada e ativada.");
      window.alert(
        "Sua credencial do portal App Mix foi validada e ativada. As automacoes serao registradas no seu usuario Mix.",
      );
      e.currentTarget.reset();
    }
  }
  async function addCollaborator(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      j = await send("/api/collaborators", "POST", {
        nome: f.get("nome"),
        email: f.get("email"),
        password: f.get("password"),
      });
    if (j) {
      setMessage("Colaborador criado.");
      window.alert(
        "Colaborador criado com sucesso. Oriente a pessoa a entrar e cadastrar a propria credencial do portal App Mix.",
      );
      e.currentTarget.reset();
      await load();
    }
  }
  async function toggle(i: Collaborator) {
    if (
      await send("/api/collaborators", "PATCH", { id: i.id, ativo: !i.ativo })
    )
      await load();
  }
  async function changeRole(i: Collaborator) {
    const role = i.role === "admin" ? "colaborador" : "admin";
    if (
      !window.confirm(
        `${role === "admin" ? "Conceder" : "Remover"} permissao de administrador para ${i.nome}?`,
      )
    )
      return;
    if (
      await send("/api/collaborators", "PATCH", {
        action: "role",
        id: i.id,
        role,
      })
    ) {
      window.alert(`Permissao de ${i.nome} atualizada para ${role}.`);
      await load();
    }
  }
  async function resetPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!resetTarget) return;
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm"))
      return setMessage("A confirmacao da nova senha nao confere.");
    if (
      await send("/api/collaborators", "PATCH", {
        action: "reset_password",
        id: resetTarget.id,
        password: f.get("password"),
      })
    ) {
      window.alert(
        `Senha de acesso ao painel redefinida para ${resetTarget.nome}.`,
      );
      setResetTarget(null);
    }
  }
  return (
    <main className="editor-page narrow">
      <header className="editor-header">
        <div>
          <a className="back" href="/painel">
            <ArrowLeft size={17} /> Voltar ao painel
          </a>
          <span className="eyebrow dark">MINHA CONTA</span>
          <h1>Acesso e equipe</h1>
          <p>Gerencie o painel, a credencial operacional e os colaboradores.</p>
          <span className="account-level">
            {user.id === user.owner_id
              ? "Administrador master"
              : user.role === "admin"
                ? "Administrador"
                : "Colaborador"}{" "}
            · {user.nome || user.email}
          </span>
        </div>
      </header>
      {message && (
        <div className="notice">
          <span>{message}</span>
          <button onClick={() => setMessage("")}>×</button>
        </div>
      )}
      <section
        className={`credential-banner ${credential.ativa ? "active" : "inactive"}`}
      >
        {credential.ativa ? <CheckCircle2 /> : <XCircle />}
        <div>
          <strong>
            {credential.ativa
              ? "Credencial Mix ativa"
              : "Credencial Mix pendente"}
          </strong>
          <small>
            {credential.ativa
              ? `${credential.login} · validada em ${new Date(credential.validada_em!).toLocaleString("pt-BR")}`
              : "Sem uma credencial valida, nenhuma tarefa pode ser enviada."}
          </small>
        </div>
      </section>
      <form id="credencial-app-mix" className="profile-card credential-target" onSubmit={saveCredential}>
        <div className="section-label">
          <ShieldCheck />
          <strong>Minha credencial do portal App Mix</strong>
          <small>
            Use o mesmo usuario e a mesma senha usados para entrar no App Mix.
            Cada automacao ficara registrada no seu operador.
          </small>
        </div>
        <label>
          Meu usuario do App Mix
          <input
            name="mix_login"
            defaultValue={credential.login}
            required
            autoComplete="username"
          />
        </label>
        <label>
          Minha senha do App Mix
          <span className="password-input">
            <input
              name="mix_password"
              type={showMixPassword ? "text" : "password"}
              required
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowMixPassword(!showMixPassword)}
              title={
                showMixPassword
                  ? "Ocultar senha do App Mix"
                  : "Mostrar senha do App Mix"
              }
            >
              {showMixPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
          <small>
            Esta nao e a senha de entrada deste painel; e a senha do portal App
            Mix.
          </small>
        </label>
        <button className="primary-button">
          <ShieldCheck size={18} /> Validar e ativar minha credencial
        </button>
      </form>
      <form className="profile-card" onSubmit={saveProfile}>
        <div className="profile-avatar">
          <UserRound />
        </div>
        <label>
          Usuario de acesso ao painel
          <input
            name="login"
            value={user.email}
            onChange={(e) => setUser({ ...user, email: e.target.value })}
            minLength={3}
            required
          />
        </label>
        <hr />
        <div className="section-label">
          <KeyRound />
          <strong>Senha de entrada deste painel</strong>
          <small>Estas senhas nao sao as credenciais do portal App Mix.</small>
        </div>
        {[
          ["senha_atual", "Senha atual do painel"],
          ["nova_senha", "Nova senha do painel"],
          ["confirmar_senha", "Repita a nova senha do painel"],
        ].map(([name, label]) => (
          <label key={name}>
            {label}
            <span className="password-input">
              <input
                name={name}
                type={showPanelPasswords ? "text" : "password"}
                required={name === "senha_atual"}
                minLength={name === "senha_atual" ? undefined : 8}
              />
              <button
                type="button"
                onClick={() => setShowPanelPasswords(!showPanelPasswords)}
              >
                {showPanelPasswords ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>
        ))}
        <button className="primary-button">
          <Save size={18} /> Salvar acesso
        </button>
      </form>
      {user.role === "admin" && (
        <>
          <form className="profile-card" onSubmit={addCollaborator}>
            <div className="section-label">
              <UserPlus />
              <strong>Novo colaborador</strong>
              <small>
                O usuario diferencia maiusculas e minusculas. A senha inicial
                serve apenas para este painel.
              </small>
            </div>
            <label>
              Nome
              <input name="nome" required minLength={2} />
            </label>
            <label>
              Usuario de acesso ao painel
              <input
                name="email"
                required
                minLength={3}
                autoCapitalize="none"
              />
              <small>Digite depois exatamente como foi cadastrado.</small>
            </label>
            <label>
              Senha inicial do painel
              <span className="password-input">
                <input
                  name="password"
                  type={showInitialPassword ? "text" : "password"}
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  onClick={() => setShowInitialPassword(!showInitialPassword)}
                >
                  {showInitialPassword ? (
                    <EyeOff size={18} />
                  ) : (
                    <Eye size={18} />
                  )}
                </button>
              </span>
            </label>
            <button className="primary-button">
              <UserPlus size={18} /> Criar colaborador
            </button>
          </form>
          <section className="profile-card">
            <h2>Colaboradores e permissoes</h2>
            {team.length ? (
              team.map((i) => {
                const self = i.id === user.id;
                return <div className={`team-row admin-row ${self ? "self-row" : ""}`} key={i.id}>
                  <div>
                    <strong>{i.nome} {self && <span className="you-badge">Você</span>}</strong>
                    <small>
                      {i.email} ·{" "}
                      {i.role === "admin" ? "Administrador" : "Colaborador"}
                    </small>
                  </div>
                  <span
                    className={
                      i.ativo ? "status concluido" : "status cancelado"
                    }
                  >
                    {i.ativo ? "Ativo" : "Bloqueado"}
                  </span>
                  <div className="team-actions">
                    <button
                      className="secondary-action"
                      disabled={self}
                      title={self ? "Você não pode alterar a própria permissão" : ""}
                      onClick={() => changeRole(i)}
                    >
                      {i.role === "admin" ? "Remover ADM" : "Tornar ADM"}
                    </button>
                    <button
                      className="secondary-action"
                      disabled={self}
                      title={self ? "Use a seção Segurança do painel" : ""}
                      onClick={() => setResetTarget(i)}
                    >
                      Redefinir senha
                    </button>
                    <button
                      className="secondary-action"
                      disabled={self}
                      title={self ? "Você não pode bloquear o próprio acesso" : ""}
                      onClick={() => toggle(i)}
                    >
                      {i.ativo ? "Bloquear" : "Ativar"}
                    </button>
                  </div>
                </div>;
              })
            ) : (
              <p className="muted">Nenhum colaborador cadastrado.</p>
            )}
          </section>
        </>
      )}
      {resetTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setResetTarget(null)}
        >
          <form
            className="modal compact-modal"
            onSubmit={resetPassword}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <span className="eyebrow dark">ACESSO AO PAINEL</span>
                <h2>Redefinir senha de {resetTarget.nome}</h2>
                <p>A credencial pessoal do portal App Mix nao sera alterada.</p>
              </div>
              <button type="button" onClick={() => setResetTarget(null)}>
                <XCircle />
              </button>
            </div>
            <label>
              Nova senha do painel
              <span className="password-input">
                <input
                  name="password"
                  type={showResetPassword ? "text" : "password"}
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  onClick={() => setShowResetPassword(!showResetPassword)}
                >
                  {showResetPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </label>
            <label>
              Confirmar nova senha
              <input
                name="confirm"
                type={showResetPassword ? "text" : "password"}
                required
                minLength={8}
              />
            </label>
            <button className="primary-button">
              <KeyRound size={18} /> Redefinir senha
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
