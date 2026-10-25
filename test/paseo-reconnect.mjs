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
  projectPaseoQueuedMessageRecovery,
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
  const html = await readFile(path.join(packageRoot, "dist/server/web-ui/index.html"), "utf8");
  assert.ok(html.includes(PASEO_BROWSER_PROJECTED_ASSET.slice("dist/server/web-ui".length)));
  assert.ok(!html.includes(PASEO_BROWSER_ASSET.slice("dist/server/web-ui".length)));
  await assert.rejects(readFile(path.join(packageRoot, PASEO_BROWSER_ASSET)), { code: "ENOENT" });
  for (const [suffix, decode] of [[".gz", gunzipSync], [".br", brotliDecompressSync]]) {
    assert.deepEqual(decode(await readFile(path.join(packageRoot, browserRelative + suffix))), browserBytes);
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
const deadline = Date.now() + 60000;
async function bounded(promise, label, maximum = 10000) {
  let timer;
  const remaining = Math.min(maximum, deadline - Date.now());
  assert.ok(remaining > 0, "Reconnect qualification exceeded 60 second deadline");
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  await bounded((async () => {
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Reconnect qualification deadline");
      await delay(20);
    }
  })(), label);
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
      input, state, closed: false, messages, pending: null,
      environment: { ...isolatedEnvironment },
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      emit(event) { for (const fn of listeners) fn(event); },
      async prompt({ message }) {
        assert.equal(session.closed, false);
        assert.equal(state.isStreaming, false, "A prompt was replayed into the active turn");
        promptCalls++;
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

let daemon, client, timeline, directory, proxy;
const sockets = new Set();
const pairs = new Set();
let offline = false, rejectedUpgrades = 0, handshakes = 0, promptFrames = 0;
let dropAcknowledgement = false, hiddenAcknowledgements = 0;
let proxyError;
const timelineSignals = [], connectionStates = [], directorySnapshots = [];
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
    agentClients: { omp: provider }, agentStoragePath: path.join(home, "agents"),
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
          if (frame.type === "session" && frame.message.type === "send_agent_message_request") promptFrames++;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else queue.push([data, binary]);
      });
      upstream.on("open", () => { for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; });
      upstream.on("message", (data, binary) => {
        if (!binary && dropAcknowledgement) {
          const frame = JSON.parse(data.toString());
          if (frame.type === "session" && frame.message.type === "send_agent_message_response") {
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
  client = new DaemonClient({ url: `ws://127.0.0.1:${proxy.address().port}/ws`,
    clientId: randomUUID(), clientType: "browser", logger,
    // Production defaults remain enabled, including 1500ms base / 30000ms cap.
    webSocketFactory: (url, options) => new WebSocket(url, options),
  });
  client.subscribeConnectionStatus((state) => connectionStates.push({ status: state.status, at: Date.now(), nextRetryAt: state.nextRetryAt }));
  await bounded(client.connect(), "initial SDK connection");
  const agent = await bounded(client.createAgent({ provider: "omp", cwd: workspace, model: "fixture/selected", title: "Reconnect qualification" }), "agent creation");
  directory = client.observeAgents();
  directory.subscribe({ snapshot: (snapshot) => directorySnapshots.push(snapshot), update() {}, error(error) { proxyError = error; } });
  await bounded(directory.ready, "directory observation");
  timeline = client.subscribeAgentTimeline(agent.id, (message) => timelineSignals.push(message));
  await bounded(timeline.ready, "timeline observation");

  for (const kind of ["accepted-before-drop", "acknowledgement-lost"]) {
    const marker = `RECONNECT_${kind.replaceAll("-", "_").toUpperCase()}`;
    const before = await bounded(client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical", limit: 100 }), "pre-drop history");
    const restoredBefore = timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length;
    const directoryBefore = directorySnapshots.length;
    const attemptsBefore = rejectedUpgrades;
    const callsBefore = promptCalls;
    const framesBefore = promptFrames;
    const effectsBefore = toolExecutions;
    const clientMessageId = randomUUID();
    dropAcknowledgement = kind === "acknowledgement-lost";
    let sdkDelivery, queuedResult;
    let queued = new Map([[agent.id, [{ id: clientMessageId, text: marker, attachments: [] }]]]);
    const submitMessage = async () => {
      try {
        await client.sendAgentMessage(agent.id, `Write exactly one fixture marker ${marker}`, { messageId: clientMessageId });
        sdkDelivery = { accepted: true };
      } catch (error) {
        sdkDelivery = { accepted: false, code: error.code, outcome: error.outcome };
        throw error;
      }
    };
    const queuedInput = { agentId: agent.id, messageId: clientMessageId, submitMessage,
      queue: { read: (id) => queued.get(id) ?? [], write: (update) => { queued = update(queued); } },
    };
    // The transformed real browser function handles the SDK's real ambiguous
    // acknowledgement error; catch-up is then allowed to drain that same queue.
    const outcome = kind === "acknowledgement-lost"
      ? sendQueued(queuedInput).then((result) => { queuedResult = result; return sdkDelivery; })
      : submitMessage().then(() => sdkDelivery, () => sdkDelivery);
    if (kind === "accepted-before-drop") {
      assert.deepEqual(await bounded(outcome, "accepted prompt acknowledgement"), { accepted: true });
      drop();
    }
    await until(() => !client.isConnected && offline && promptCalls === callsBefore + 1, "disconnect and runtime prompt");
    const active = daemon.agentManager.getAgent(agent.id);
    assert.equal(active.lifecycle, "running");
    const turnId = active.activeTurnId;
    assert.ok(turnId);
    const runtimeSession = runtimes.find((session) => session.pending);
    assert.ok(runtimeSession);
    assert.equal(runtimeSession.closed, false);
    assert.equal(runtimeSession.input.model, "fixture/selected");
    const sessionId = runtimeSession.state.sessionId;
    // Exercise two failed reconnects, not merely a close/open pair.
    await until(() => rejectedUpgrades >= attemptsBefore + 2, "two automatic failed reconnects");
    assert.equal(daemon.agentManager.getAgent(agent.id).activeTurnId, turnId);
    assert.equal(runtimeSession.closed, false);
    const toolCallId = await bounded(runtimeSession.finishOffline(marker), "offline tool and completion");
    await until(() => daemon.agentManager.getAgent(agent.id).lifecycle === "idle", "active turn completes while disconnected");
    const liveCountBeforeReconnect = timelineSignals.length;
    offline = false;
    await until(() => client.isConnected && timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length > restoredBefore && directorySnapshots.length > directoryBefore, "automatic reconnect and state resubscription");
    // subscribeAgentTimeline restores live delivery, not missing history. As in
    // the shipped UI, explicitly fetch after our last cursor (tail when empty).
    const catchUp = await bounded(client.fetchAgentTimeline(agent.id, {
      direction: before.endCursor ? "after" : "tail", ...(before.endCursor ? { cursor: before.endCursor } : {}),
      projection: "canonical", limit: 100,
    }), "cursor history catch-up");
    assert.equal(catchUp.error, null);
    assert.equal(catchUp.hasNewer, false);
    assert.ok(catchUp.entries.some((entry) => entry.item.type === "assistant_message" && entry.item.text.includes(marker) && entry.turnId === turnId));
    assert.ok(catchUp.entries.some((entry) => entry.item.type === "tool_call" && entry.turnId === turnId), "Offline tool is missing from recovered history");
    const full = await bounded(client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical", limit: 100 }), "complete history");
    const users = full.entries.filter((entry) => entry.item.type === "user_message" && entry.item.clientMessageId === clientMessageId);
    assert.equal(users.length, 1, "Prompt was lost or duplicated in canonical history");
    assert.equal(promptCalls - callsBefore, 1);
    assert.equal(promptFrames - framesBefore, 1, "SDK replayed a mutation after transport loss");
    assert.equal(toolExecutions - effectsBefore, 1);
    assert.equal(abortCalls, 0, "Observation disconnect canceled the OMP turn");
    assert.equal(runtimeSession.state.sessionId, sessionId);
    assert.equal(runtimeSession.closed, false);
    const delivery = await bounded(outcome, "submission outcome");
    if (kind === "acknowledgement-lost") assert.deepEqual(delivery, { accepted: false, code: "DAEMON_CONNECTION_LOST", outcome: "unknown" });
    if (kind === "acknowledgement-lost") {
      assert.equal(queuedResult.deliveryOutcome, "unknown");
      assert.equal(queued.get(agent.id).length, 0);
      assert.equal((await sendQueued(queuedInput)).status, "missing");
      assert.equal(promptCalls - callsBefore, 1);
      assert.equal(promptFrames - framesBefore, 1);
    }
    assert.ifError(proxyError);
    report.scenarios.push({ kind, agentId: agent.id, turnId, sessionId, clientMessageId, toolCallId,
      promptFrames: promptFrames - framesBefore, runtimePrompts: promptCalls - callsBefore,
      toolExecutions: toolExecutions - effectsBefore, rejectedReconnects: rejectedUpgrades - attemptsBefore,
      delivery, recoveredEntries: catchUp.entries.length, recoveredUserCopies: users.length,
      restoredSubscriptions: timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length - restoredBefore,
      directorySnapshots: directorySnapshots.length - directoryBefore,
      observationEventsAfterReconnect: timelineSignals.length - liveCountBeforeReconnect,
    });
  }
  assert.equal(hiddenAcknowledgements, 1);
  report.handshakes = handshakes;
  report.connectionStates = connectionStates.map(({ status, at, nextRetryAt }) => ({ status, elapsedMs: at - connectionStates[0].at,
    ...(nextRetryAt ? { scheduledDelayMs: Math.max(0, Date.parse(nextRetryAt) - at) } : {}) }));
  report.result = "passed";
} finally {
  // No process.exit: leaked fixture handles must remain visible to qualification.
  // close() first invalidates owned subscription identities locally, so teardown
  // never waits for an RPC acknowledgement over a deliberately broken socket.
  await client?.close();
  await timeline?.release().catch(() => {});
  await directory?.release().catch(() => {});
  for (const pair of pairs) { pair.browser.terminate(); pair.upstream.terminate(); }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => wss.close(resolve));
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (daemon) await daemon.stop();
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
