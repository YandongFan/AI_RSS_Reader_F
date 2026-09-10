const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/codex-app-server.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['child_process', 'fs', 'path', 'readline'],
}).outputFiles[0].text;

function loadServer() {
  const processes = [];
  class FakeProcess extends EventEmitter {
    constructor() {
      super();
      this.messages = [];
      this.stdout = new EventEmitter();
      this.stdout.close = () => {};
      this.stderr = new EventEmitter();
      this.stdin = {
        write: value => this.receive(JSON.parse(value)),
        end: () => { this.ended = true; },
      };
    }
    kill() { this.killed = true; }
    send(message) { setImmediate(() => this.stdout.emit('line', JSON.stringify(message))); }
    receive(message) {
      this.messages.push(message);
      if (message.method === 'initialize') this.send({ id: message.id, result: { userAgent: 'test' } });
      if (message.method === 'account/read') this.send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
      if (message.method === 'account/login/start') {
        this.send({ id: message.id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/login-test' } });
        this.send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } });
      }
      if (message.method === 'account/logout') this.send({ id: message.id, result: {} });
      if (message.method === 'model/list') this.send({ id: message.id, result: { data: [
        { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true, hidden: false },
        { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false, hidden: false },
      ], nextCursor: null } });
      if (message.method === 'thread/start') this.send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') {
        this.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        this.send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: '[{"id":0}]' } } });
        this.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
      }
    }
  }
  const sandbox = {
    module: { exports: {} }, exports: {}, Buffer, setTimeout, clearTimeout, setImmediate,
    require: name => {
      if (name === 'child_process') return { spawn: () => { const process = new FakeProcess(); processes.push(process); return process; } };
      if (name === 'readline') return { createInterface: ({ input }) => input };
      return require(name);
    },
  };
  vm.runInNewContext(code, sandbox);
  return { api: sandbox.module.exports, processes };
}

test('uses Codex managed ChatGPT login without exposing OAuth tokens', async () => {
  const { api, processes } = loadServer();
  const opened = [];
  const status = await api.loginCodexAccount('codex-test', async url => opened.push(url));
  assert.deepEqual(opened, ['https://chatgpt.com/login-test']);
  assert.deepEqual({ ...status }, { signedIn: true, authType: 'chatgpt', planType: 'plus' });
  const login = processes[0].messages.find(message => message.method === 'account/login/start');
  assert.deepEqual({ ...login.params }, { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' });
  assert.equal(processes[0].killed, true);
});

test('runs analysis in an ephemeral read-only Codex thread with structured output', async () => {
  const { api, processes } = loadServer();
  const schema = { type: 'array', items: { type: 'object' } };
  const result = await api.callCodexModel('codex-test', '', 'classify papers', schema);
  assert.equal(result, '[{"id":0}]');
  const thread = processes[0].messages.find(message => message.method === 'thread/start');
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.sandbox, 'read-only');
  assert.equal('model' in thread.params, false);
  const turn = processes[0].messages.find(message => message.method === 'turn/start');
  assert.equal(turn.params.input[0].text, 'classify papers');
  assert.deepEqual({ ...turn.params.sandboxPolicy }, { type: 'readOnly' });
  assert.equal('access' in turn.params.sandboxPolicy, false);
  assert.deepEqual({ ...turn.params.outputSchema }, schema);
});

test('lists account models and maps a desktop display name to its Codex model id', async () => {
  const listed = loadServer();
  const models = await listed.api.readCodexModels('codex-test');
  assert.deepEqual(Array.from(models, item => ({ ...item })), [
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true },
    { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false },
  ]);

  const called = loadServer();
  await called.api.callCodexModel('codex-test', 'GPT-5.6 Luna', 'classify papers', { type: 'array' });
  const thread = called.processes[0].messages.find(message => message.method === 'thread/start');
  assert.equal(thread.params.model, 'gpt-5.6-luna');
});

test('falls back to the Codex default when a saved model is no longer available', async () => {
  const { api, processes } = loadServer();
  await api.callCodexModel('codex-test', 'removed-model', 'classify papers', { type: 'array' });
  const thread = processes[0].messages.find(message => message.method === 'thread/start');
  assert.equal('model' in thread.params, false);
});
