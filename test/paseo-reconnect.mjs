#!/usr/bin/env node
// Real pinned Paseo daemon, SDK, WebSocket transport and OMP adapter. Only the
// OMP RPC runtime is deterministic: this does not qualify real model generation.
// Run with the package's Node (SQLite support required):
// node test/paseo-reconnect.mjs [--app /path/to/portable/app]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import {
  PASEO_BROWSER_ASSET, PASEO_BROWSER_PROJECTED_ASSET, PASEO_BROWSER_PATCHED_SHA256,
  PASEO_RECONNECT_PERIOD_MS, projectPaseoQueuedMessageRecovery,
} from "../build/paseo-reconnect.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--app"), "Expected [--app PATH]");
const app = path.resolve(args[1] ?? path.join(root, "payload/app"));
const scratch = await mkdtemp(path.join(os.tmpdir(), "paseo-reconnect-"));
const home = path.join(scratch, "home");
const workspace = path.join(scratch, "workspace");
await Promise.all([mkdir(home), mkdir(workspace)]);
// Set before importing the server; no user config, OMP state or running daemon.
const isolatedEnvironment = {
  HOME: home, USERPROFILE: home, PASEO_HOME: path.join(home, "paseo"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"), PI_CODING_AGENT_DIR: path.join(home, "omp"),
  APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"),
};
Object.assign(process.env, isolatedEnvironment);
const require = createRequire(path.join(app, "package.json"));
const serverRoot = path.dirname(require.resolve("@getpaseo/server"));
const clientEntry = require.resolve("@getpaseo/client/internal/daemon-client");
const serverEntry = require.resolve("@getpaseo/server");
const adapterEntry = path.join(serverRoot, "agent/providers/omp/agent.js");
const { WebSocket, WebSocketServer } = require("ws");
const pino = require("pino");
const logger = pino({ level: "silent" });
const [{ createPaseoDaemon }, { DaemonClient }, { OmpAgentClient }] = await Promise.all([
  import(pathToFileURL(serverEntry).href), import(pathToFileURL(clientEntry).href),
  import(pathToFileURL(adapterEntry).href),
]);
const versions = {};
for (const name of ["server", "client"]) {
  const manifest = JSON.parse(await readFile(path.join(app, "node_modules/@getpaseo", name, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.13.0", `Requalify changed Paseo ${name}`);
  versions[name] = manifest.version;
}
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const report = {
  qualification: "Paseo observation reconnect; no prompt replay",
  engine: "controlled injected OMP RPC runtime; real published OMP adapter, daemon and SDK",
  notQualified: ["real OMP subprocess/model generation", "browser rendering", "cloud/provider stream resume"],
  versions, node: process.version, platform: process.platform,
  inputs: { client: await digest(clientEntry), ompAdapter: await digest(adapterEntry) },
  scenarios: [],
};
// Execute only the exact shipped queue-send function, not the browser bundle
// bootstrap. It has no module dependencies on the exercised error paths.
const packageRoot = path.join(app, "node_modules/@getpaseo/server");
let browserRelative = PASEO_BROWSER_PROJECTED_ASSET;
let browserBytes;
try {
  browserBytes = await readFile(path.join(packageRoot, browserRelative));
} catch (error) {
  if (error.code !== "ENOENT" || args.length !== 0) throw error;
  // Default source-fixture mode can qualify the projection before packaging.
  // Explicit --app qualification must exercise the actual projected ZIP.
  browserRelative = PASEO_BROWSER_ASSET;
  browserBytes = await readFile(path.join(packageRoot, browserRelative));
}
const browserHash = createHash("sha256").update(browserBytes).digest("hex");
const projectedBytes = browserRelative === PASEO_BROWSER_PROJECTED_ASSET
  ? browserBytes : projectPaseoQueuedMessageRecovery(browserBytes);
assert.equal(createHash("sha256").update(projectedBytes).digest("hex"), PASEO_BROWSER_PATCHED_SHA256);
if (browserRelative === PASEO_BROWSER_PROJECTED_ASSET) {
  const htmlBytes = await readFile(path.join(packageRoot, "dist/server/web-ui/index.html"));
  const html = htmlBytes.toString("utf8");
  assert.equal(html.split(PASEO_BROWSER_PROJECTED_ASSET.slice("dist/server/web-ui".length)).length, 2);
  assert.ok(!html.includes(PASEO_BROWSER_ASSET.slice("dist/server/web-ui".length)));
  await assert.rejects(readFile(path.join(packageRoot, PASEO_BROWSER_ASSET)), { code: "ENOENT" });
  for (const [suffix, decode] of [[".gz", gunzipSync], [".br", brotliDecompressSync]]) {
    assert.deepEqual(decode(await readFile(path.join(packageRoot, browserRelative + suffix))), browserBytes);
    await assert.rejects(readFile(path.join(packageRoot, PASEO_BROWSER_ASSET + suffix)), { code: "ENOENT" });
    // The package may omit compressed HTML; when present it must agree exactly.
    let compressedHtml;
    try { compressedHtml = await readFile(path.join(packageRoot, "dist/server/web-ui/index.html" + suffix)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (compressedHtml) assert.deepEqual(decode(compressedHtml), htmlBytes);
  }
}
function queueSender(bytes) {
  const source = bytes.toString("utf8");
  const prefix = "e.sendQueuedComposerMessageNow=";
  const begin = source.indexOf(prefix);
  const end = source.indexOf(",e.openComposerAttachment=", begin);
  assert.ok(begin >= 0 && end > begin, "Missing shipped queue send function");
  return runInNewContext(`(${source.slice(begin + prefix.length, end)})`, { Map, Error }, { timeout: 1000 });
}
const sendQueued = queueSender(projectedBytes);
// Exercise the two exact browser methods without bootstrapping Expo. Controlled
// timers here inspect the shipped delay, never accelerate the real SDK below.
const projectedSource = projectedBytes.toString("utf8");
const retryMethodsStart = projectedSource.indexOf("emitDisconnectedStateForReconnect(e,t){");
const retryMethodsEnd = projectedSource.indexOf("resolvePingProbe(){", retryMethodsStart);
assert.ok(retryMethodsStart >= 0 && retryMethodsEnd > retryMethodsStart);
const browserTimers = [];
const BrowserRetry = runInNewContext(`(class {${projectedSource.slice(retryMethodsStart, retryMethodsEnd)}})`,
  { Date, Math, String, setTimeout: (callback, delayMs) => { browserTimers.push({ callback, delayMs }); return browserTimers.length; } },
  { timeout: 1000 });
const browserRetry = Object.assign(new BrowserRetry(), {
  config: {}, shouldReconnect: true, traceInstant() {},
  updateConnectionState(state) { this.state = state; }, attemptConnect() { throw new Error("Unexpected VM connection"); },
});
for (const attempt of [0, 1, 10000]) {
  browserRetry.reconnectAttempt = attempt;
  const at = Date.now();
  browserRetry.emitDisconnectedStateForReconnect("offline");
  browserRetry.armReconnectTimer();
  assert.equal(browserTimers.at(-1).delayMs, PASEO_RECONNECT_PERIOD_MS);
  assert.ok(Math.abs(Date.parse(browserRetry.state.nextRetryAt) - at - PASEO_RECONNECT_PERIOD_MS) < 100);
}
report.browserProjection = { asset: browserRelative, observedSha256: browserHash, projectedSha256: PASEO_BROWSER_PATCHED_SHA256, cases: [] };
for (const [name, error, expectedCopies] of [
  ["ambiguous-disconnect", Object.assign(new Error("lost acknowledgement"), { code: "DAEMON_CONNECTION_LOST", outcome: "unknown" }), 0],
  ["request-timeout", Object.assign(new Error("acknowledgement timeout"), { code: "DAEMON_REQUEST_TIMEOUT" }), 0],
  ["known-not-submitted", Object.assign(new Error("offline before send"), { code: "DAEMON_CONNECTION_LOST" }), 1],
]) {
  let queue = new Map([["agent", [{ id: "queued", text: "fixture", attachments: [] }]]]);
  let sends = 0;
  const input = { agentId: "agent", messageId: "queued",
    queue: { read: (id) => queue.get(id) ?? [], write: (update) => { queue = update(queue); } },
    submitMessage: async () => { sends++; throw error; },
  };
  const result = await sendQueued(input);
  assert.equal(result.status, "failed");
  assert.equal(queue.get("agent").length, expectedCopies);
  if (expectedCopies === 0) {
    assert.equal(result.deliveryOutcome, "unknown");
    assert.equal((await sendQueued(input)).status, "missing");
    assert.equal(sends, 1, "Catch-up replayed an ambiguously delivered queued mutation");
  }
  report.browserProjection.cases.push({ name, sends, queuedCopiesAfterFailure: queue.get("agent").length, deliveryOutcome: result.deliveryOutcome });
}
// Both acknowledgement scenarios share the same outage window: about 60s for
// a rejected retry followed by recovery, then 30s to prove close cancels retry.
const startedAt = Date.now();
const deadline = startedAt + 105000;
async function bounded(promise, label, maximum = 10000) {
  let timer;
  const remaining = Math.min(maximum, deadline - Date.now());
  assert.ok(remaining > 0, "Reconnect qualification exceeded 105 second deadline");
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, label, maximum = 10000) {
  await bounded((async () => {
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Reconnect qualification deadline");
      await delay(20);
    }
  })(), label, maximum);
}

// This fixture owns the runtime seam and the sole external-effect counter.
// Unexpected adapter calls fail rather than pretending to implement RPC methods.
const model = { provider: "fixture", id: "selected", name: "Selected fixture model", input: ["text"], contextWindow: 32768, maxTokens: 1024 };
const runtimes = [];
let promptCalls = 0, toolExecutions = 0, abortCalls = 0;
const runtime = {
  async startSession(input) {
    assert.equal(input.cwd === workspace || input.cwd === home, true);
    const listeners = new Set();
    const messages = [];
    const state = { sessionId: randomUUID(), model, thinkingLevel: "off", isStreaming: false,
      isCompacting: false, messageCount: 0, queuedMessageCount: 0 };
    const session = {
      input, state, closed: false, messages, pending: null, promptCalls: 0, toolExecutions: 0,
      environment: { ...isolatedEnvironment },
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      emit(event) { for (const fn of listeners) fn(event); },
      async prompt({ message }) {
        assert.equal(session.closed, false);
        assert.equal(state.isStreaming, false, "A prompt was replayed into the active turn");
        promptCalls++;
        session.promptCalls++;
        state.isStreaming = true;
        const user = { role: "user", content: message, id: randomUUID(), timestamp: Date.now() };
        messages.push(user);
        session.pending = { message, user };
        // Adapter creates its turn before awaiting this RPC acknowledgement.
        queueMicrotask(() => {
          session.emit({ type: "agent_start" });
          session.emit({ type: "turn_start" });
          session.emit({ type: "message_end", message: user });
        });
        return { requestId: randomUUID(), agentInvoked: true };
      },
      async finishOffline(marker) {
        assert.ok(session.pending, "Missing pending runtime turn");
        const toolCallId = randomUUID();
        const file = path.join(workspace, `${marker}.txt`);
        session.emit({ type: "tool_execution_start", toolCallId, toolName: "write", args: { path: file, content: marker } });
        // Real local effect, deliberately after loss of observation. A replay
        // would increment both the runtime prompt and external-effect counts.
        await writeFile(file, marker, { flag: "wx" });
        toolExecutions++;
        session.toolExecutions++;
        session.emit({ type: "tool_execution_end", toolCallId, toolName: "write", result: { content: [{ type: "text", text: "written" }] }, isError: false });
        const assistant = { role: "assistant", provider: model.provider, model: model.id,
          responseId: randomUUID(), content: [{ type: "text", text: marker }], stopReason: "stop", timestamp: Date.now() };
        session.emit({ type: "message_start", message: assistant });
        session.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: marker } });
        session.emit({ type: "message_end", message: assistant });
        messages.push(assistant);
        state.isStreaming = false;
        state.messageCount = messages.length;
        session.pending = null;
        session.emit({ type: "agent_end", messages: [assistant] });
        assert.equal(await readFile(file, "utf8"), marker);
        return toolCallId;
      },
      async getState() { return { ...state }; },
      async getMessages() { return [...messages]; },
      async getAvailableModels() { return [model]; },
      async getSessionStats() { return { tokens: { input: 1, output: 1 } }; },
      async getCommands() { return []; },
      async getBranchMessages() { return messages.filter((m) => m.role === "user").map((m) => ({ entryId: m.id, text: m.content })); },
      async setSubagentSubscription() {},
      async abort() { abortCalls++; state.isStreaming = false; },
      async close() { session.closed = true; listeners.clear(); },
    };
    runtimes.push(session);
    return session;
  },
};

let daemon, proxy;
const scenarios = [];
const sockets = new Set();
const pairs = new Set();
let offline = false, rejectedUpgrades = 0, handshakes = 0, promptFrames = 0;
let dropAcknowledgement = false, hiddenAcknowledgements = 0;
let proxyError;
const upgradeEvents = [], frameCounts = new Map();
const wss = new WebSocketServer({ noServer: true });
function drop() {
  offline = true;
  for (const pair of pairs) { pair.browser.terminate(); pair.upstream.terminate(); }
}
try {
  const provider = new OmpAgentClient({ logger, runtime, runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } } });
  daemon = await bounded(createPaseoDaemon({
    listen: "127.0.0.1:0", paseoHome: process.env.PASEO_HOME,
    corsAllowedOrigins: [], staticDir: workspace, mcpDebug: false,
    agentClients: { omp: provider }, providerOverrides: { omp: { enabled: true } },
    agentStoragePath: path.join(home, "agents"),
    relayEnabled: false, pluginsEnabled: false, mcpEnabled: false,
    browserToolsEnabled: false, enableTerminalAgentHooks: false,
    webUi: { enabled: false, distDir: null }, metadataGeneration: { providers: [] },
  }, logger), "daemon creation");
  await bounded(daemon.start(), "daemon start");
  const target = daemon.getListenTarget();
  assert.equal(target.type, "tcp");
  assert.ok(target.port > 0 && target.port !== 6767);
  const upstreamUrl = `ws://127.0.0.1:${target.port}/ws`;
  proxy = createServer((_request, response) => response.writeHead(404).end());
  proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  proxy.on("upgrade", (request, socket, head) => {
    const kind = new URL(request.url, "http://fixture").searchParams.get("fixture");
    upgradeEvents.push({ kind, at: Date.now(), accepted: !offline });
    if (offline) {
      rejectedUpgrades++;
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (browser) => {
      handshakes++;
      const upstream = new WebSocket(upstreamUrl);
      const pair = { browser, upstream };
      pairs.add(pair);
      const queue = [];
      browser.on("message", (data, binary) => {
        if (!binary) {
          const frame = JSON.parse(data.toString());
          if (frame.type === "session" && frame.message.type === "send_agent_message_request") {
            promptFrames++;
            frameCounts.set(kind, (frameCounts.get(kind) ?? 0) + 1);
          }
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else queue.push([data, binary]);
      });
      upstream.on("open", () => { for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; });
      upstream.on("message", (data, binary) => {
        if (!binary && dropAcknowledgement) {
          const frame = JSON.parse(data.toString());
          if (kind === "acknowledgement-lost" && frame.type === "session" && frame.message.type === "send_agent_message_response") {
            assert.equal(frame.message.payload.accepted, true);
            hiddenAcknowledgements++;
            dropAcknowledgement = false;
            drop();
            return;
          }
        }
        if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
      });
      browser.on("error", () => upstream.terminate());
      upstream.on("error", (error) => { if (!offline) proxyError = error; browser.terminate(); });
      browser.on("close", () => { pairs.delete(pair); upstream.terminate(); });
      upstream.on("close", () => { pairs.delete(pair); browser.terminate(); });
    });
  });
  await bounded(new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); }), "proxy listen");
  for (const kind of ["accepted-before-drop", "acknowledgement-lost"]) {
    const state = { kind, timelineSignals: [], connectionStates: [], directorySnapshots: [] };
    scenarios.push(state);
    const client = state.client = new DaemonClient({
      url: `ws://127.0.0.1:${proxy.address().port}/ws?fixture=${kind}`,
      clientId: randomUUID(), clientType: "browser", logger,
      reconnect: { enabled: true, baseDelayMs: PASEO_RECONNECT_PERIOD_MS, maxDelayMs: PASEO_RECONNECT_PERIOD_MS },
      webSocketFactory: (url, options) => new WebSocket(url, options),
    });
    client.subscribeConnectionStatus((event) => state.connectionStates.push({ ...event, at: Date.now() }));
    await bounded(client.connect(), "initial SDK connection");
    const agent = state.agent = await bounded(client.createAgent({ provider: "omp", cwd: workspace, model: "fixture/selected", title: kind }), "agent creation");
    state.directory = client.observeAgents();
    state.directory.subscribe({ snapshot: (snapshot) => state.directorySnapshots.push(snapshot), update() {}, error(error) { proxyError = error; } });
    await bounded(state.directory.ready, "directory observation");
    state.timeline = client.subscribeAgentTimeline(agent.id, (message) => state.timelineSignals.push(message));
    await bounded(state.timeline.ready, "timeline observation");
    state.before = await bounded(client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical", limit: 100 }), "pre-drop history");
    state.restoredBefore = state.timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length;
    state.directoryBefore = state.directorySnapshots.length;
    state.marker = `RECONNECT_${kind.replaceAll("-", "_").toUpperCase()}`;
    state.clientMessageId = randomUUID();
    state.queued = new Map([[agent.id, [{ id: state.clientMessageId, text: state.marker, attachments: [] }]]]);
    const submitMessage = async () => {
      try {
        await client.sendAgentMessage(agent.id, `Write exactly one fixture marker ${state.marker}`, { messageId: state.clientMessageId });
        state.delivery = { accepted: true };
      } catch (error) {
        state.delivery = { accepted: false, code: error.code, outcome: error.outcome };
        throw error;
      }
    };
    state.queuedInput = { agentId: agent.id, messageId: state.clientMessageId, submitMessage,
      queue: { read: (id) => state.queued.get(id) ?? [], write: (update) => { state.queued = update(state.queued); } },
    };
    if (kind === "accepted-before-drop") {
      await bounded(submitMessage(), "accepted prompt acknowledgement");
      assert.deepEqual(state.delivery, { accepted: true });
    } else {
      dropAcknowledgement = true;
      state.outcome = sendQueued(state.queuedInput).then((result) => { state.queuedResult = result; });
    }
  }
  await until(() => offline && scenarios.every(({ client }) => !client.isConnected) && promptCalls === 2, "disconnect and runtime prompts");
  for (const state of scenarios) {
    const active = daemon.agentManager.getAgent(state.agent.id);
    assert.equal(active.lifecycle, "running");
    state.turnId = active.activeTurnId;
    assert.ok(state.turnId);
    state.runtimeSession = runtimes.find((session) => session.pending?.message.includes(state.marker));
    assert.ok(state.runtimeSession);
    assert.equal(state.runtimeSession.input.model, "fixture/selected");
    state.sessionId = state.runtimeSession.state.sessionId;
  }
  // Both SDKs must actually try at 30s while offline, then schedule the same
  // delay again. No fake clock, reduced production delay, or mutation replay.
  await until(() => scenarios.every(({ kind }) => upgradeEvents.some((event) => event.kind === kind && !event.accepted)), "real 30-second rejected reconnects", 35000);
  for (const state of scenarios) {
    assert.equal(daemon.agentManager.getAgent(state.agent.id).activeTurnId, state.turnId);
    assert.equal(state.runtimeSession.closed, false);
    state.toolCallId = await bounded(state.runtimeSession.finishOffline(state.marker), "offline tool and completion");
    await until(() => daemon.agentManager.getAgent(state.agent.id).lifecycle === "idle", "active turn completes offline");
    state.liveCountBeforeReconnect = state.timelineSignals.length;
  }
  offline = false;
  await until(() => scenarios.every((state) => state.client.isConnected &&
    state.timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length > state.restoredBefore &&
    state.directorySnapshots.length > state.directoryBefore), "real 30-second retry and resubscription", 35000);
  for (const state of scenarios) {
    const { client, agent, before, runtimeSession, kind } = state;
    const catchUp = await bounded(client.fetchAgentTimeline(agent.id, {
      direction: before.endCursor ? "after" : "tail", ...(before.endCursor ? { cursor: before.endCursor } : {}),
      projection: "canonical", limit: 100,
    }), "cursor history catch-up");
    assert.equal(catchUp.error, null);
    assert.equal(catchUp.hasNewer, false);
    assert.ok(catchUp.entries.some((entry) => entry.item.type === "assistant_message" && entry.item.text.includes(state.marker) && entry.turnId === state.turnId));
    assert.ok(catchUp.entries.some((entry) => entry.item.type === "tool_call" && entry.turnId === state.turnId), "Offline tool is missing from recovered history");
    const full = await bounded(client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical", limit: 100 }), "complete history");
    const users = full.entries.filter((entry) => entry.item.type === "user_message" && entry.item.clientMessageId === state.clientMessageId);
    assert.equal(users.length, 1, "Prompt was lost or duplicated in canonical history");
    assert.equal(runtimeSession.promptCalls, 1);
    assert.equal(frameCounts.get(kind), 1, "SDK replayed a mutation after transport loss");
    assert.equal(runtimeSession.toolExecutions, 1);
    assert.equal(abortCalls, 0, "Observation disconnect canceled the OMP turn");
    assert.equal(runtimeSession.state.sessionId, state.sessionId);
    assert.equal(runtimeSession.closed, false);
    if (kind === "acknowledgement-lost") {
      await bounded(state.outcome, "ambiguous submission outcome");
      assert.deepEqual(state.delivery, { accepted: false, code: "DAEMON_CONNECTION_LOST", outcome: "unknown" });
      assert.equal(state.queuedResult.deliveryOutcome, "unknown");
      assert.equal(state.queued.get(agent.id).length, 0);
      assert.equal((await sendQueued(state.queuedInput)).status, "missing");
      assert.equal(runtimeSession.promptCalls, 1);
      assert.equal(frameCounts.get(kind), 1);
    }
    const reconnects = state.connectionStates.filter((event) => event.status === "disconnected" && event.nextRetryAt);
    assert.ok(reconnects.length >= 2, "Missing initial and subsequent retry deadlines");
    for (const event of reconnects)
      assert.ok(Math.abs(Date.parse(event.nextRetryAt) - event.at - PASEO_RECONNECT_PERIOD_MS) < 100);
    const upgrades = upgradeEvents.filter((event) => event.kind === kind);
    assert.equal(upgrades.length, 3, "Expected initial handshake, rejected retry, recovered handshake");
    for (let i = 1; i < upgrades.length; i++) {
      const from = i === 1 ? reconnects[0].at : upgrades[i - 1].at;
      assert.ok(upgrades[i].at - from >= PASEO_RECONNECT_PERIOD_MS - 100, "Reconnect happened before the fixed period");
    }
    report.scenarios.push({
      kind, agentId: agent.id, turnId: state.turnId, sessionId: state.sessionId,
      clientMessageId: state.clientMessageId, toolCallId: state.toolCallId,
      promptFrames: frameCounts.get(kind), runtimePrompts: runtimeSession.promptCalls,
      toolExecutions: runtimeSession.toolExecutions, rejectedReconnects: upgrades.filter((event) => !event.accepted).length,
      delivery: state.delivery, recoveredEntries: catchUp.entries.length, recoveredUserCopies: users.length,
      restoredSubscriptions: state.timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length - state.restoredBefore,
      directorySnapshots: state.directorySnapshots.length - state.directoryBefore,
      observationEventsAfterReconnect: state.timelineSignals.length - state.liveCountBeforeReconnect,
      upgrades: upgrades.map(({ at, accepted }) => ({ elapsedMs: at - startedAt, accepted })),
    });
  }
  assert.ifError(proxyError);
  assert.equal(hiddenAcknowledgements, 1);
  assert.equal(promptCalls, 2);
  assert.equal(promptFrames, 2);
  assert.equal(toolExecutions, 2);
  // Closing during a fresh outage must cancel the actual pending 30s timers.
  drop();
  await until(() => scenarios.every(({ client }) => !client.isConnected), "cancellation disconnect");
  const upgradesBeforeClose = upgradeEvents.length;
  const closedAt = Date.now();
  await Promise.all(scenarios.map(({ client }) => client.close()));
  await bounded(delay(PASEO_RECONNECT_PERIOD_MS + 150), "closed clients stay closed past retry deadline", 31000);
  assert.equal(upgradeEvents.length, upgradesBeforeClose, "Closed SDK reconnected after cancellation");
  assert.equal(promptFrames, 2);
  assert.equal(promptCalls, 2);
  assert.equal(toolExecutions, 2);
  report.cancellation = { clients: scenarios.length, observedMs: Date.now() - closedAt, upgradesAfterClose: upgradeEvents.length - upgradesBeforeClose };
  report.handshakes = handshakes;
  report.rejectedUpgrades = rejectedUpgrades;
  report.browserRetry = { attempts: [0, 1, 10000], scheduledDelayMs: browserTimers.map(({ delayMs }) => delayMs) };
  report.connectionStates = scenarios.flatMap(({ kind, connectionStates }) => connectionStates.map(({ status, at, nextRetryAt }) => ({
    kind, status, elapsedMs: at - startedAt,
    ...(nextRetryAt ? { scheduledDelayMs: Date.parse(nextRetryAt) - at } : {}),
  })));
  report.elapsedMs = Date.now() - startedAt;
  report.result = "passed";
} finally {
  // No process.exit: leaked fixture handles remain qualification failures.
  // close() invalidates subscriptions before release, even on a broken socket.
  await Promise.all(scenarios.map(({ client }) => client.close()));
  for (const { timeline, directory } of scenarios) {
    await timeline?.release().catch(() => {});
    await directory?.release().catch(() => {});
  }
  for (const pair of pairs) { pair.browser.terminate(); pair.upstream.terminate(); }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => wss.close(resolve));
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (daemon) await daemon.stop();
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
