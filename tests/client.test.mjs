import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The client half is a browser module: it registers itself with the page's
// module loader and takes react through an injected require. Both are faked
// here so the module can be exercised in Node — the parsers are what carry the
// risk, and they must be checked against real tool output.
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

function loadClientModule() {
  let registered = null
  const style = { id: '', textContent: '' }
  globalThis.window = { __ModuleLoader__: { load: (spec) => { registered = spec } } }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => style,
    head: { appendChild: () => {} },
  }
  // eslint-disable-next-line no-eval -- the bundle registers itself on the global
  eval(source)
  const react = { createElement: () => null, useState: (value) => [value, () => {}] }
  const fakeRequire = (name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    throw new Error('unexpected require: ' + name)
  }
  return { module: registered.factory(fakeRequire), style, spec: registered }
}

const { module: client, style, spec } = loadClientModule()
const vm = client.__viewModel

/** A settled tool result carrying exactly the text the model received. */
function settled(text, { isError = false, error, argsRaw = '{"project":"demo","query":"auth"}' } = {}) {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'c1',
    call: { name: 'mcp__codebase_memory__search_graph', argsRaw },
    callTime: 0,
    content: [{ type: 'text', text }],
    isError,
    ...(error ? { error } : {}),
    subCalls: [],
  }
}

test('the client half registers itself and is additive by tool name', () => {
  assert.equal(spec.id, 'dsh-codebase-memory')
  assert.deepEqual(client.inject, ['slots'])

  const registered = []
  const ctx = {
    effect: (callback) => { callback(); return () => {} },
    slots: {
      inject: (_key, callback) => { callback() },
      register: (spec) => { registered.push(spec); return () => {} },
    },
  }
  client.apply(ctx)

  assert.equal(registered.length, vm.TOOL_NAMES.length)
  assert.equal(registered.length, 15)
  for (const spec of registered) {
    assert.equal(spec.name, 'tool.call.toolview')
    assert.equal(spec.registrant, 'dsh-codebase-memory')
    assert.match(spec.key, /^mcp__codebase_memory__/)
  }
  // One entry per name, or a later registration would shadow an earlier one.
  assert.equal(new Set(registered.map((spec) => spec.key)).size, 15)
  assert.ok(style.textContent.includes('.cbm-card'), 'the stylesheet is injected')
})

test('a running call is not parsed and reports progress state', () => {
  const running = {
    callId: 'c2',
    name: 'mcp__codebase_memory__search_graph',
    argsRaw: '{"project":"demo","query":"retry"}',
    turn: 1,
    step: 1,
    time: 0,
    subCalls: [],
  }
  assert.equal(vm.stateOf(running), 'running')
  const model = vm.modelOf(running, running.name)
  assert.equal(model.parsed, null)
  assert.equal(model.summary, 'retry')
  assert.deepEqual(model.args, { project: 'demo', query: 'retry' })
})

test('trace_path output keeps its groups, hops and totals', () => {
  // Verbatim from a real call, including the truncation footer.
  const text = [
    'function: startModHandshake',
    'direction: both',
    'callees_total: 9',
    'callees: 6  (rows: name hop; qn = group prefix + "." + name)',
    'mqe-plugins.QQAuth.src.main.java.cn.xfyweb.QQAuth.QQAuthMain:',
    '  handleModNew 2',
    '  processModHandshakeResponse 1',
    'mqe-plugins.QQAuth.src.main.java.cn.xfyweb.QQAuth.adminpanel.AdminPanelHttpServer:',
    '  error 1',
    'callers_total: 1',
    'callers: 1  (rows: name hop; qn = group prefix + "." + name)',
    'mqe-plugins.QQAuth.src.main.java.cn.xfyweb.QQAuth.QQAuthMain:',
    '  onPreLogin 1',
    'truncated: true',
    'next: c1.o.u2c6bc198b3bee15bg1.d12654ccf98187cb.2.1263',
    'hint: "more rows exist — re-call with cursor set to \'next\' and ALL other arguments identical (no duplicates), or narrow with depth/edge_types"',
  ].join('\n')

  const model = vm.modelOf(settled(text), 'mcp__codebase_memory__trace_path')
  assert.equal(model.state, 'ok')
  const sections = model.parsed.sections
  // Three qn groups, one per qualified-name prefix, each carrying its own rows.
  assert.equal(sections.length, 3)
  assert.deepEqual(sections[0].rows.map((row) => ({ name: row.name, hop: row.hop })), [
    { name: 'handleModNew', hop: 2 },
    { name: 'processModHandshakeResponse', hop: 1 },
  ])
  assert.deepEqual(sections[1].rows.map((row) => row.name), ['error'])
  assert.deepEqual(sections[2].rows.map((row) => row.name), ['onPreLogin'])
  // Section labels and the footer must not become sections or rows.
  assert.equal(sections.some((section) => /^(callees|callers|next|hint|truncated)/.test(section.label)), false)

  assert.deepEqual(model.parsed.kv.callees_total, '9')
  assert.ok(model.chips.includes('被调用 9'), 'totals surface as chips: ' + JSON.stringify(model.chips))
  assert.ok(model.chips.includes('调用者 1'))
  assert.ok(model.chips.includes('已截断'))
  assert.match(model.summary, /依赖 9 \/ 调用者 1/)
})

test('architecture and change reports parse as sections with their own columns', () => {
  // Verbatim shapes from get_architecture and detect_changes.
  const architecture = [
    'project: mqe-plugins',
    'total_nodes: 4489',
    'node_labels: 17  (cols: label count)',
    '  Method 1523',
    '  Variable 1051',
    'hotspots: 10  (cols: qn fan_in)',
    '  mqe-plugins.QQAuth.bot.ExternalUserId.of 101',
    'routes: 6  (cols: method path handler)',
    '  - /api/health -',
  ].join('\n')
  const arch = vm.parseSections(architecture)
  assert.deepEqual(arch.map((section) => section.label), ['node_labels', 'hotspots', 'routes'])
  assert.deepEqual(arch[0].columns, ['label', 'count'])
  assert.equal(arch[0].count, 17)
  // The count stays part of the row text: it is this section's declared column,
  // and the renderer splits it for display rather than the parser guessing.
  assert.deepEqual(arch[0].rows.map((row) => row.name), ['Method 1523', 'Variable 1051'])
  // A declared-column row must not turn its metric into a hop distance.
  assert.equal(arch[1].rows[0].hop, null)
  assert.equal(arch[1].rows[0].name, 'mqe-plugins.QQAuth.bot.ExternalUserId.of 101')

  const changes = [
    'base: main',
    'direction: inbound',
    'changed_files: 39',
    '  QQAuth/CONTEXT.md',
    '  mqe-download/README.md',
    'seed_symbols: 122',
    'impacted_total: 232',
    'impacted_modules: (rows: module count)',
    '  QQAuth/src 220',
    '  AuthClient-N/src 7',
  ].join('\n')
  const diff = vm.parseSections(changes)
  assert.deepEqual(diff.map((section) => section.label), ['changed_files', 'impacted_modules'])
  // List sections keep unindented entries; key/value footer lines stay out.
  assert.deepEqual(diff[0].rows.map((row) => row.name), ['QQAuth/CONTEXT.md', 'mqe-download/README.md'])
  assert.deepEqual(diff[1].rows.map((row) => row.name), ['QQAuth/src 220', 'AuthClient-N/src 7'])
  assert.equal(diff[1].rows[0].hop, null)
})

test('search_graph table output splits into symbol and location', () => {
  const text = [
    'total: 140',
    'search_mode: bm25',
    'results: 8  (cols: qn label file lines in out)',
    'mqe-plugins.AuthClient-N.HandshakeStore.State.State Method AuthClient-N/src/main/java/cn/xfyweb/authclient/HandshakeStore.java 28-31 -17.76',
    'mqe-plugins.QQAuth.QQAuthMain.startModHandshake Method QQAuth/src/main/java/cn/xfyweb/QQAuth/QQAuthMain.java 1047-1072 -15.84',
    'has_more: true',
  ].join('\n')

  const model = vm.modelOf(settled(text), 'mcp__codebase_memory__search_graph')
  const table = model.parsed.table
  assert.equal(table.cols.join(' '), 'qn label file lines in out')
  assert.equal(table.rows.length, 2, 'only data rows: ' + JSON.stringify(table.rows))
  assert.ok(model.chips.includes('140 条'), 'total surfaces as a chip: ' + JSON.stringify(model.chips))
  assert.match(model.summary, /auth/)
  assert.match(model.summary, /2 条结果/)
})

test('index_status JSON becomes structured values, not a text blob', () => {
  const text = JSON.stringify({
    project: 'root-mqe-plugins',
    nodes: 7414,
    edges: 25318,
    status: 'ready',
    root_path: '/root/mqe-plugins',
    parse_partial: { files: [{ path: 'a/gradlew' }, { path: 'b/gradlew' }], count: 2, truncated: false },
    skipped: { files: [{ path: 'c.properties' }], count: 1, truncated: false },
  })
  const model = vm.modelOf(settled(text, { argsRaw: '{"project":"root-mqe-plugins"}' }), 'mcp__codebase_memory__index_status')
  assert.equal(model.parsed.json.nodes, 7414)
  // Scalars stay directly readable in the expanded body.
  assert.deepEqual(model.parsed.flat.scalars.slice(0, 3), [['project', 'root-mqe-plugins'], ['nodes', '7414'], ['edges', '25318']])
  // Nested objects collapse to a count rather than dumping their contents.
  assert.deepEqual(model.parsed.flat.collections, [['parse_partial', '2 项'], ['skipped', '1 项']])
  // The headline numbers reach the collapsed card.
  assert.ok(model.chips.includes('7414 节点'), JSON.stringify(model.chips))
  assert.ok(model.chips.includes('25318 边'))
  assert.ok(model.chips.includes('部分解析 2'))
  assert.ok(model.chips.includes('跳过 1'))
  assert.equal(model.summary, 'root-mqe-plugins · ready')
})

test('an error result shows the reason rather than an empty body', () => {
  const text = '/root/x is outside the allowed root. To allow it, run: codebase-memory-mcp allow-root /root/x'
  const model = vm.modelOf(settled(text, { isError: true }), 'mcp__codebase_memory__index_repository')
  assert.equal(model.state, 'error')
  assert.match(model.summary, /outside the allowed root/)
})

test('an unrecognised shape degrades to plain text instead of inventing structure', () => {
  const text = 'some future upstream format\nthat we do not know about'
  const model = vm.modelOf(settled(text), 'mcp__codebase_memory__query_graph')
  assert.equal(model.parsed.table, null)
  assert.equal(model.parsed.sections, null)
  assert.equal(model.parsed.json, null)
  assert.equal(model.text, text)
})

test('malformed JSON arguments never throw', () => {
  const broken = { ...settled('{}'), call: { name: 'x', argsRaw: '{"project": ' } }
  assert.deepEqual(vm.argsOf(broken), { __raw: '{"project": ' })
})
