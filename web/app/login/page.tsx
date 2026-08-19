"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
    });
    if (response.ok) window.location.href = "/painel";
    else {
      const result = await response.json().catch(() => ({}));
      setError(result.detail || "Nao foi possivel entrar.");
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="brand"><span className="brand-mark"><Sparkles size={21} /></span><span>APP MIX</span></div>
        <div className="story-copy">
          <span className="eyebrow">CENTRAL DE AUTOMACAO FISCAL</span>
          <h1>Operacoes complexas.<br /><em>Controle simples.</em></h1>
          <p>Envie lotes, acompanhe cada empresa e mantenha sua equipe no ritmo certo em um unico painel.</p>
        </div>
        <div className="trust-row"><ShieldCheck size={20} /><span>Acesso protegido e operacoes auditaveis</span></div>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={login}>
          <div className="login-icon"><LockKeyhole size={25} /></div>
          <span className="eyebrow dark">AREA RESTRITA</span>
          <h2>Bem-vindo de volta</h2>
          <p className="muted">Entre com seu acesso para abrir o painel.</p>
          <label>E-mail<input name="email" type="email" autoComplete="username" required placeholder="voce@empresa.com.br" /></label>
          <label>Senha<input name="password" type="password" autoComplete="current-password" required placeholder="Sua senha" /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={loading}>{loading ? "Entrando..." : <>Entrar no painel <ArrowRight size={18} /></>}</button>
          <small>Ao entrar, voce concorda com as politicas internas de seguranca.</small>
        </form>
      </section>
    </main>
  );
}
