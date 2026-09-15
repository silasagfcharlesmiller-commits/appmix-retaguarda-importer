const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(js, { exports, ...globals, require(name) {
    if (name === 'server-only') return {};
    if (name in dependencies) return dependencies[name];
    throw new Error(`Dependency must be mocked: ${name}`);
  } });
  return exports;
}

const cnpj = '11222333000181';
const model = load('app/painel/robos/robot-model.ts');
const robot = { id: 'robot-a', cnpj, machine_id: 'ABCDEF0123456789', agent_online: true,
  connection_status: 'online', integrator_observed: true, integrator_online: true, desired_state: 'running' };

test('search matches masked CNPJ, machine ID and accented names without matching every row for text', () => {
  const client = { client_name: 'Teste Víctor' };
  for (const term of ['11.222.333/0001-81', '11222333', 'abcdef', 'teste victor']) assert.equal(model.matchesSearch(robot, client, term), true);
  assert.equal(model.matchesSearch(robot, client, 'unknown'), false);
  assert.equal(model.matchesSearch(robot, undefined, 'victor'), false);
  assert.equal(model.matchesSearch(robot, client, '...'), false);
});

test('stale, delayed and unconfirmed readings never show a green process badge', () => {
  assert.equal(model.agentStatus(robot, false).tone, 'success');
  assert.equal(model.agentStatus(robot, true).tone, 'warning');
  assert.equal(model.agentStatus({ ...robot, connection_status: 'delayed' }, false).tone, 'warning');
  assert.equal(model.agentStatus({ ...robot, integrator_observed: false }, false).tone, 'warning');
  assert.equal(model.agentStatus({ ...robot, agent_online: false }, false).tone, 'danger');
  assert.equal(model.agentStatus({ ...robot, integrator_online: false, desired_state: 'paused' }, false).label, 'Pausado');
});

test('cadastro parser returns only public labels, verifies CNPJ and never hardcodes Victor/Arius', () => {
  const { parseAgentClient } = load('lib/agent-client.ts', { '@/lib/credentials': {} });
  const data = { clientes_mxf_cmf: { cli_cnpj: '11.222.333/0001-81', cli_nome: 'Teste Victor' }, retaguarda: { nome: 'Arius' }, password: 'must-not-leak' };
  const first = parseAgentClient({ data }, cnpj);
  assert.equal(first.client_name, 'Teste Victor');
  assert.equal(first.retaguarda, 'Arius');
  assert.equal('password' in first, false);
  data.clientes_mxf_cmf.cli_nome = 'Outro cliente';
  data.retaguarda.nome = 'Outra retaguarda';
  assert.equal(parseAgentClient({ data }, cnpj).retaguarda, 'Outra retaguarda');
  assert.throws(() => parseAgentClient({ data }, '00000000000000'), /não corresponde/);
  delete data.retaguarda;
  assert.equal(parseAgentClient({ data }, cnpj).retaguarda, '');
});

test('upstream lookup refreshes expired authentication and handles missing cadastro', async () => {
  const renewals = [];
  const requests = [];
  const replies = [{ status: 401 }, { status: 200, ok: true, json: async () => ({ data: null }) }];
  const { getAgentClient } = load('lib/agent-client.ts', { '@/lib/credentials': { credentialBearer: async (owner, refresh) => { renewals.push([owner, refresh]); return 'test-token'; } } }, {
    AbortSignal, fetch: async (url, options) => { requests.push({ url, options }); return replies.shift(); },
  });
  assert.equal((await getAgentClient(7, cnpj)).status, 'not_found');
  assert.deepEqual(renewals, [[7, false], [7, true]]);
  assert.ok(requests.every(item => item.url.endsWith(`?cli_cnpj=${cnpj}`) && !item.options.method));
});

test('cadastro route authorizes the owner before contacting App Mix', async () => {
  let lookupCount = 0;
  let allowed = false;
  const api = load('app/api/agents/clients/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200 }) } },
    '@/lib/session': { COOKIE_NAME: 'session', verifySession: async () => ({ email: 'test@example.invalid' }) },
    '@/lib/users': { getUser: async () => ({ owner_id: 7 }) },
    '@/lib/db': { query: async (sql, args) => { assert.match(sql, /owner_id=\$1 AND cnpj=\$2/); assert.deepEqual(Array.from(args), [7, cnpj]); return { rowCount: allowed ? 1 : 0 }; } },
    '@/lib/agent-client': { getAgentClient: async () => { lookupCount++; return { cnpj, client_name: 'Teste Victor', retaguarda: 'Arius' }; } },
  });
  const request = { cookies: { get: () => ({ value: 'test' }) }, nextUrl: new URL(`http://localhost/api/agents/clients?cnpj=${cnpj}`) };
  assert.equal((await api.GET(request)).status, 404);
  assert.equal(lookupCount, 0);
  allowed = true;
  assert.equal((await api.GET(request)).body.retaguarda, 'Arius');
  assert.equal(lookupCount, 1);
});

test('robot rendering uses exactly one row and three visible actions, with no manual identity form', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { RobotRow } = load('app/painel/robos/robot-table.tsx', {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'lucide-react': require('lucide-react'),
    './robot-model': model, './robots.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) },
  });
  const html = renderToStaticMarkup(React.createElement('table', null, React.createElement('tbody', null,
    React.createElement(RobotRow, { agent: { ...robot, windows_user: 'test', computer_name: 'PC', agent_protocol: 2 },
      client: { status: 'loaded', client_name: 'Teste Victor', retaguarda: 'Arius' }, selected: false, stale: false, onSelect() {}, onCommand() {} }))));
  assert.equal((html.match(/<tr/g) || []).length, 1);
  assert.equal((html.match(/<td/g) || []).length, 6);
  assert.equal((html.match(/<button/g) || []).length, 3);
  for (const label of ['Iniciar', 'Pausar', 'Atualizar', 'Teste Victor']) assert.ok(html.includes(label));
  assert.ok(!html.includes('Arius'));
  assert.ok(!html.includes('Identificar cliente'));
});

test('credential tokens are decrypted only on the server, deduplicated and isolated by owner', async () => {
  const records = new Map();
  const logins = [];
  const api = load('lib/credentials.ts', {
    'node:crypto': require('node:crypto'), 'node:path': require('node:path'),
    'node:fs': { readFileSync() { throw new Error('Local credentials must not be read'); } },
    '@/lib/db': { query: async (sql, args) => ({ rows: records.has(args[0]) ? [records.get(args[0])] : [] }) },
  }, { Buffer, AbortSignal, process: { env: { NODE_ENV: 'production', APP_MIX_CREDENTIAL_SECRET: 'isolated-test-secret-32-characters-long' } },
    fetch: async (_, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.password, 'synthetic-password');
      logins.push(body.email);
      return { ok: true, json: async () => ({ access_token: `Bearer token-for-${body.email}` }) };
    },
  });
  const encrypted = api.encryptSecret('synthetic-password');
  records.set(7, { login: 'owner-a', password_encrypted: encrypted });
  records.set(8, { login: 'owner-b', password_encrypted: encrypted });
  const first = await Promise.all([api.credentialBearer(7), api.credentialBearer(7)]);
  assert.deepEqual(first, ['token-for-owner-a', 'token-for-owner-a']);
  assert.deepEqual(logins, ['owner-a']);
  assert.equal(await api.credentialBearer(8), 'token-for-owner-b');
  records.delete(7);
  await assert.rejects(() => api.credentialBearer(7), /Valide a credencial/);
});
