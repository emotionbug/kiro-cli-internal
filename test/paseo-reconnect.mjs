#!/usr/bin/env node
// Real pinned Paseo daemon, SDK, plugin bridge, native Kiro provider and HTTP
// transport. Only the loopback Kiro backend is controlled; no cloud generation.
// Run with the package's Node (SQLite support required):
// node test/paseo-reconnect.mjs [--app /path/to/portable/app]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
const app = path.resolve(args[1] ?? (process.env.KIRO_TEST_BUNDLE_ROOT
  ? path.join(process.env.KIRO_TEST_BUNDLE_ROOT, "app") : path.join(root, "payload/app")));
const scratch = await mkdtemp(path.join(os.tmpdir(), "paseo-reconnect-"));
const home = path.join(scratch, "home");
const workspace = path.join(scratch, "workspace");
await Promise.all([mkdir(home), mkdir(workspace)]);
// Set before importing the server; no user config or running daemon is selected.
const isolatedEnvironment = {
  HOME: home, USERPROFILE: home, PASEO_HOME: path.join(home, "paseo"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"),
};
for (const key of Object.keys(process.env))
  if (/^(?:PASEO_|OMP_|PI_|KIRO_|BUN_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_OPTIONS$)/i.test(key))
    delete process.env[key];
Object.assign(process.env, isolatedEnvironment);
const require = createRequire(path.join(app, "package.json"));
const clientEntry = require.resolve("@getpaseo/client/internal/daemon-client");
const serverEntry = require.resolve("@getpaseo/server");
const providerEntry = path.join(app, "plugin/omp-kiro/server/provider.mjs");
const { WebSocket, WebSocketServer } = require("ws");
const pino = require("pino");
const logger = pino({ level: "silent" });
const [{ createPaseoDaemon }, { DaemonClient }] = await Promise.all([
  import(pathToFileURL(serverEntry).href), import(pathToFileURL(clientEntry).href),
]);
const versions = {};
for (const name of ["server", "client"]) {
  const manifest = JSON.parse(await readFile(path.join(app, "node_modules/@getpaseo", name, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.13.0", `Requalify changed Paseo ${name}`);
  versions[name] = manifest.version;
}
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const report = {
  startedAt: new Date().toISOString(),
  qualification: "Paseo observation reconnect; no prompt replay",
  engine: "real native Kiro HTTP provider and transport, plugin bridge, daemon and SDK; controlled loopback backend",
  notQualified: ["cloud model generation", "browser rendering", "cloud/provider stream resume", "production authentication (qualified separately by Windows ZIP smoke)"],
  versions, node: process.version, platform: process.platform,
  inputs: { client: await digest(clientEntry), nativeProvider: await digest(providerEntry) },
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
      if (backendFailure) throw backendFailure;
      await delay(20);
    }
  })(), label, maximum);
}

// A real HTTP backend holds the initial response while SDK observation is down.
// It requests the real native write_file tool; only that tool creates the file.
const backendSessions = new Map();
let promptCalls = 0, toolExecutions = 0, backendFailure;
const { crc32 } = await import(pathToFileURL(path.join(app, "plugin/omp-kiro/server/eventstream.mjs")));
function eventFrame(type, value) {
  const headers = Buffer.concat(Object.entries({ ":message-type": "event", ":event-type": type }).map(([name, value]) => {
    const key = Buffer.from(name), text = Buffer.from(value), bytes = Buffer.alloc(key.length + 4);
    bytes[0] = key.length; key.copy(bytes, 1); bytes[1 + key.length] = 7;
    bytes.writeUInt16BE(text.length, key.length + 2);
    return Buffer.concat([bytes, text]);
  }));
  const payload = Buffer.from(JSON.stringify(value));
  const bytes = Buffer.alloc(16 + headers.length + payload.length);
  bytes.writeUInt32BE(bytes.length, 0); bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12); payload.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return bytes;
}
const backend = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    let raw = "";
    for await (const bytes of request) { raw += bytes; assert.ok(raw.length < 1024 * 1024); }
    const body = JSON.parse(raw);
    if (request.headers["x-amz-target"] === "KiroControlPlaneBearerService.ListAvailableModels") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ modelId: "fixture-named", modelName: "Fixture Named", tokenLimits: { maxInputTokens: 32768, maxOutputTokens: 1024 } }] }));
      return;
    }
    assert.equal(request.headers["x-amz-target"], "AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    const state = body.conversationState;
    const current = state.currentMessage.userInputMessage;
    assert.equal(current.modelId, "fixture-named");
    const marker = JSON.stringify(state).match(/RECONNECT_(?:ACCEPTED_BEFORE_DROP|ACKNOWLEDGEMENT_LOST)/)?.[0];
    assert.ok(marker, "Missing original reconnect prompt");
    let session = backendSessions.get(marker);
    if (!session) {
      promptCalls++;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      session = { marker, conversationId: state.conversationId, requests: 0, promptCalls: 1,
        toolExecutions: 0, toolCallId: `write-${marker}`, release, gate };
      backendSessions.set(marker, session);
    }
    assert.equal(state.conversationId, session.conversationId, "Observation reconnect changed the native conversation");
    session.requests++;
    assert.ok(session.requests <= 2, "Native backend received a replayed prompt or completed tool");
    if (session.requests === 1) {
      const tools = current.userInputMessageContext.tools.map((tool) => tool.toolSpecification);
      const write = tools.find((tool) => tool.name === "write_file");
      assert.ok(write);
      assert.deepEqual(write.inputSchema.json.required, ["path", "content"]);
      await session.gate;
      response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      response.end(eventFrame("toolUseEvent", { toolUseId: session.toolCallId, name: "write_file",
        input: JSON.stringify({ path: `${marker}.txt`, content: marker }), stop: true }));
    } else {
      assert.equal(await readFile(path.join(workspace, `${marker}.txt`), "utf8"), marker);
      const results = current.userInputMessageContext.toolResults;
      assert.equal(results.filter((result) => result.toolUseId === session.toolCallId && result.status === "success").length, 1);
      session.toolExecutions++; toolExecutions++;
      response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      response.end(eventFrame("assistantResponseEvent", { content: marker }));
    }
  } catch (error) {
    backendFailure ??= error;
    if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ __type: "ValidationException", message: "Controlled reconnect fixture invariant failed" }));
    else response.destroy();
  }
});
await new Promise((resolve, reject) => { backend.once("error", reject); backend.listen(0, "127.0.0.1", resolve); });
const fixturePlugin = path.join(scratch, "native-fixture-plugin");
await mkdir(fixturePlugin);
await mkdir(path.join(fixturePlugin, "node_modules"));
await symlink(path.join(app, "plugin/omp-kiro"), path.join(fixturePlugin, "node_modules/omp-kiro"),
  process.platform === "win32" ? "junction" : "dir");
async function publishFixtureFile(file, value) {
  await writeFile(`${file}.tmp`, value, { flag: "wx" });
  await rename(`${file}.tmp`, file);
}
await publishFixtureFile(path.join(fixturePlugin, "paseo-plugin.json"), JSON.stringify({
  id: "native-reconnect-fixture", name: "Native reconnect backend qualification", requirements: { paseo: ">=0.13.0" },
}));
await publishFixtureFile(path.join(fixturePlugin, "index.server.ts"), `
import { createKiroHttpProvider } from "omp-kiro/server/provider.mjs";
export default function contribute(server) {
  server.registerProvider(createKiroHttpProvider({
    stateDir: ${JSON.stringify(path.join(home, "native-sessions"))},
    authProvider: async () => ({ kind: "social", provider: "google", access_token: "controlled-loopback-token", expires_at: "2099-01-01T00:00:00.000Z", region: "us-east-1" }),
    fetchImpl: async (url, init) => {
      const target = new URL(url);
      if (!["runtime.us-east-1.kiro.dev", "management.us-east-1.kiro.dev"].includes(target.hostname)) throw new Error("Non-Kiro fixture destination");
      return fetch("http://127.0.0.1:${backend.address().port}/", { ...init, redirect: "error" });
    },
  }));
}
`);

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
  daemon = await bounded(createPaseoDaemon({
    listen: "127.0.0.1:0", paseoHome: process.env.PASEO_HOME,
    corsAllowedOrigins: [], staticDir: workspace, mcpDebug: false,
    agentClients: {}, providerOverrides: { "kiro-http": { enabled: true } },
    agentStoragePath: path.join(home, "agents"),
    relayEnabled: false, pluginsEnabled: false, mcpEnabled: false,
    browserToolsEnabled: false, enableTerminalAgentHooks: false,
    webUi: { enabled: false, distDir: null }, metadataGeneration: { providers: [] },
  }, logger, { builtinPlugins: { async load(start) {
    await start({ id: "native-reconnect-fixture", directory: fixturePlugin });
  } } }), "daemon creation");
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
    const agent = state.agent = await bounded(client.createAgent({ provider: "kiro-http", cwd: workspace, model: "fixture-named", title: kind }), "native agent creation");
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
  await until(() => offline && scenarios.every(({ client }) => !client.isConnected) && promptCalls === 2, "disconnect and native backend requests");
  for (const state of scenarios) {
    const active = daemon.agentManager.getAgent(state.agent.id);
    assert.equal(active.lifecycle, "running");
    state.turnId = active.activeTurnId;
    assert.ok(state.turnId);
    state.backendSession = backendSessions.get(state.marker);
    assert.ok(state.backendSession);
    state.sessionId = state.backendSession.conversationId;
    assert.ok(state.sessionId);
  }
  // Both SDKs must actually try at 30s while offline, then schedule the same
  // delay again. No fake clock, reduced production delay, or mutation replay.
  await until(() => scenarios.every(({ kind }) => upgradeEvents.some((event) => event.kind === kind && !event.accepted)), "real 30-second rejected reconnects", 35000);
  for (const state of scenarios) {
    assert.equal(daemon.agentManager.getAgent(state.agent.id).activeTurnId, state.turnId);
    state.toolCallId = state.backendSession.toolCallId;
    state.backendSession.release();
    await until(() => daemon.agentManager.getAgent(state.agent.id).lifecycle === "idle", "active turn completes offline");
    state.guardedText = `${state.marker}\nRECONNECT_SENTINEL_MUST_SURVIVE`;
    await writeFile(path.join(workspace, `${state.marker}.txt`), state.guardedText);
    state.liveCountBeforeReconnect = state.timelineSignals.length;
  }
  offline = false;
  await until(() => scenarios.every((state) => state.client.isConnected &&
    state.timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length > state.restoredBefore &&
    state.directorySnapshots.length > state.directoryBefore), "real 30-second retry and resubscription", 35000);
  for (const state of scenarios) {
    const { client, agent, before, backendSession, kind } = state;
    const catchUp = await bounded(client.fetchAgentTimeline(agent.id, {
      direction: before.endCursor ? "after" : "tail", ...(before.endCursor ? { cursor: before.endCursor } : {}),
      projection: "canonical", limit: 100,
    }), "cursor history catch-up");
    assert.equal(catchUp.error, null);
    assert.equal(catchUp.hasNewer, false);
    assert.ok(catchUp.entries.some((entry) => entry.item.type === "assistant_message" && entry.item.text.includes(state.marker) && entry.turnId === state.turnId));
    assert.ok(catchUp.entries.some((entry) => entry.item.type === "tool_call" && entry.turnId === state.turnId), "Offline tool is missing from recovered history");
    const full = await bounded(client.fetchAgentTimeline(agent.id, { direction: "tail", projection: "canonical", limit: 100 }), "complete history");
    assert.equal(full.entries.filter((entry) => entry.item.type === "tool_call" &&
      entry.item.name === "write_file" && entry.item.status === "completed" &&
      entry.turnId === state.turnId).length, 1, "Native completed tool must occur exactly once");
    const users = full.entries.filter((entry) => entry.item.type === "user_message" && entry.item.clientMessageId === state.clientMessageId);
    assert.equal(users.length, 1, "Prompt was lost or duplicated in canonical history");
    assert.equal(backendSession.promptCalls, 1);
    assert.equal(frameCounts.get(kind), 1, "SDK replayed a mutation after transport loss");
    assert.equal(backendSession.toolExecutions, 1);
    assert.equal(backendSession.requests, 2, "Observation reconnect replayed native generation");
    assert.equal(backendSession.conversationId, state.sessionId);
    assert.equal(await readFile(path.join(workspace, `${state.marker}.txt`), "utf8"), state.guardedText,
      "Observation reconnect repeated the completed native write side effect");
    if (kind === "acknowledgement-lost") {
      await bounded(state.outcome, "ambiguous submission outcome");
      assert.deepEqual(state.delivery, { accepted: false, code: "DAEMON_CONNECTION_LOST", outcome: "unknown" });
      assert.equal(state.queuedResult.deliveryOutcome, "unknown");
      assert.equal(state.queued.get(agent.id).length, 0);
      assert.equal((await sendQueued(state.queuedInput)).status, "missing");
      assert.equal(backendSession.promptCalls, 1);
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
      promptFrames: frameCounts.get(kind), nativePrompts: backendSession.promptCalls,
      toolExecutions: backendSession.toolExecutions, rejectedReconnects: upgrades.filter((event) => !event.accepted).length,
      delivery: state.delivery, recoveredEntries: catchUp.entries.length, recoveredUserCopies: users.length,
      restoredSubscriptions: state.timelineSignals.filter((m) => m.type === "agent.timeline.subscription_restored").length - state.restoredBefore,
      directorySnapshots: state.directorySnapshots.length - state.directoryBefore,
      observationEventsAfterReconnect: state.timelineSignals.length - state.liveCountBeforeReconnect,
      upgrades: upgrades.map(({ at, accepted }) => ({ elapsedMs: at - startedAt, accepted })),
    });
  }
  assert.ifError(proxyError);
  assert.ifError(backendFailure);
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
} catch (error) {
  report.result = "failed";
  report.failure = {
    at: new Date().toISOString(),
    type: error?.name ?? "Error",
    assertion: error?.code === "ERR_ASSERTION"
      ? String(error.message).split("\n")[0].replaceAll(app, "[app]").replaceAll(scratch, "[fixture]")
      : "Native reconnect qualification failed; private runtime output is not exported",
  };
  process.exitCode = 1;
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
  for (const session of backendSessions.values()) session.release();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
report.finishedAt = new Date().toISOString();
console.log(JSON.stringify(report, null, 2));
