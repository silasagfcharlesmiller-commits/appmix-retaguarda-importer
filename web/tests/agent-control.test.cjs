const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// All SQL, credentials and network dependencies are isolated. These tests must
// never load lib/db or read environment credentials.
function control(handler) {
  const calls = [];
  const query = async (sql, args = []) => {
    calls.push({sql, args});
    if (sql.includes('CREATE TABLE') || sql.includes('pg_advisory_xact_lock')) return {rows:[],rowCount:0};
    return handler(sql,args);
  };
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname,'../lib/agent-control.ts'),'utf8');
  const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js, {exports, Buffer, require(name) {
    if (name === 'server-only') return {};
    if (name === 'node:crypto') return require(name);
    if (name === '@/lib/db') return {query,transaction:work => work({query})};
    if (name === '@/lib/credentials') return {ensureCredentials:async () => {}};
    throw Error(`Unexpected dependency: ${name}`);
  }});
  return {api:exports,calls};
}
const rows = (...items) => ({rows:items,rowCount:items.length});

test('metadata edit is bounded to the authenticated owner and trims names',async () => {
  const {api,calls} = control((sql,args) => {
    assert.match(sql,/WHERE id=\$3 AND owner_id=\$4/);
    assert.deepEqual(Array.from(args),['Cliente','Retaguarda','agent-1',7]);
    return rows({id:'agent-1'});
  });
  assert.equal((await api.identifyAgent(7,'agent-1',' Cliente ',' Retaguarda ')).ok,true);
  assert.ok(calls.length);
});
test('update preserves paused/running state and is queued only for a capable device',async () => {
  const {api} = control((sql,args) => {
    if (sql.startsWith('UPDATE public.mix_agents')) {assert.equal(args[0],null);assert.equal(args[2],7);return rows({id:'a',agent_protocol:2});}
    if (sql.startsWith('SELECT id')) return rows();
    assert.equal(args[1],'update'); return rows({id:3,action:'update'});
  });
  assert.equal((await api.queueCommand(7,'a','update','operator')).action,'update');
  const legacy = control(() => rows({id:'a',agent_protocol:1}));
  await assert.rejects(() => legacy.api.queueCommand(7,'a','update','operator'),/nova versão/);
});
test('a pending command prevents conflicting follow-up commands',async () => {
  const {api} = control(sql => sql.startsWith('UPDATE') ? rows({id:'a',agent_protocol:2}) : rows({id:99}));
  await assert.rejects(() => api.queueCommand(7,'a','pause','operator'),/andamento/);
});
test('commands cannot be completed for another device or before delivery',async () => {
  const {api} = control((sql,args) => {
    if (sql.startsWith('UPDATE')) {assert.match(sql,/agent_id=\$5 AND status='delivered'/);assert.equal(args[4],'own-device');}
    else assert.equal(args[1],'own-device');
    return rows();
  });
  await assert.rejects(() => api.completeCommand({id:'own-device'},{command_id:88,success:true}),/não entregue/);
});
test('status refresh cannot consume a queued command and preserves unknown process state',async () => {
  const {api,calls} = control((sql,args) => {
    assert.match(sql,/CASE WHEN \$6 THEN \$1 ELSE integrator_online END/);
    assert.equal(args[5],false);
    return rows({desired_state:'running'});
  });
  const result = await api.acceptHeartbeat({id:'a'}, {protocol:2,integrator_observed:false,integrator_online:false},true);
  assert.equal(result.command,null);
  assert.equal(calls.filter(c => c.sql.includes("SET status='delivered'")).length,0);
});
test('real diagnostic waits for both results and reports every failure',async () => {
  let phase = 'pending';
  const {api} = control(sql => {
    if (sql.startsWith('SELECT action')) return rows(
      {action:'restart',status:phase==='pending'?'delivered':'failed',success:false,result_message:'Abertura não confirmada'},
      {action:'start',status:phase==='pending'?'pending':'failed',success:false,result_message:'Permissão da tarefa'}
    );
    return rows({id:'a'});
  });
  const input = {test_id:'a'.repeat(32)};
  assert.equal((await api.agentSelfTest({id:'a'},input)).complete,false);
  phase='done';
  const result = await api.agentSelfTest({id:'a'},input);
  assert.equal(result.complete,true);assert.equal(result.success,false);
  assert.match(result.message,/Abertura não confirmada/);assert.match(result.message,/Permissão da tarefa/);
});
test('repeating diagnostic polling does not enqueue another restart',async () => {
  let inserted = 0;
  const {api} = control(sql => {
    if (sql.startsWith('SELECT action')) return inserted ? rows({action:'restart',status:'delivered',success:false},{action:'start',status:'pending',success:false}) : rows();
    if (sql.startsWith('SELECT id FROM public.mix_agent_commands')) return rows();
    if (sql.startsWith('INSERT')) inserted++;
    return rows({id:'a'});
  });
  const input={test_id:'b'.repeat(32)};
  await api.agentSelfTest({id:'a'},input);await api.agentSelfTest({id:'a'},input);
  assert.equal(inserted,1);
});
