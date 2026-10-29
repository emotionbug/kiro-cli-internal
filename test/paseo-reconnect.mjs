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
const PASEO_RECONNECT_PERIOD_MS = 30000;

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
const fixturePluginId = "native-reconnect-fixture";
const pluginFailures = [];
let fixtureStage = "fixture setup";
function safeMessageSnippet(message) {
  let snippet = message;
  for (const [directory, replacement] of [[home, "[home]"], [app, "[app]"], [scratch, "[fixture]"]]) {
    snippet = snippet.replaceAll(directory, replacement);
    snippet = snippet.replaceAll(directory.replaceAll("\\", "/"), replacement);
    snippet = snippet.replaceAll(directory.replaceAll("\\", "\\\\"), replacement);
  }
  return snippet
    .replace(/\b(?:https?|wss?|file):\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/(["']?\b(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\bcontrolled-loopback-token\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]+)*\b/g, "[redacted]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n<>"'|]*/g, "[path]")
    .replace(/(^|[\s("'=])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g, "$1[path]")
    .replace(/\\\\[^\\\s"'<>]+\\[^\r\n<>"'|]*/g, "[path]")
    .replace(/\s+/g, " ").trim().slice(0, 512);
}
function safeError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" && /^(?:ERR_[A-Z_]+|E[A-Z]+|DAEMON_[A-Z_]+)$/.test(error.code)
    ? error.code : undefined;
  const type = ["Error", "AssertionError", "TypeError", "RangeError", "SyntaxError"].includes(error?.name ?? error?.type)
    ? (error.name ?? error.type) : "Error";
  const origin = typeof error?.stack === "string"
    ? error.stack.split("\n").find((line) => /^\s+at /.test(line)) : undefined;
  const ownedAssertion = origin?.includes(import.meta.url) ||
    origin?.includes(fileURLToPath(import.meta.url));
  const location = ownedAssertion ? /:(\d+):(\d+)\)?$/.exec(origin) : null;
  let classification = "native_fixture_failure";
  let assertion = "Native fixture operation failed; see stage and redacted message snippet";
  if (code === "ERR_ASSERTION") {
    classification = "fixture_invariant";
    // Only assertions originating here inspect exclusively synthetic inputs and
    // public API results. Never export assertions from dependency internals.
    assertion = ownedAssertion
      ? message.split("\n")[0].replaceAll(app, "[app]").replaceAll(scratch, "[fixture]")
      : "Native dependency assertion failed";
  } else if (/^Timed out: [a-zA-Z0-9 -]+$/.test(message)) {
    classification = "fixture_timeout";
    assertion = message;
  } else if (/^Invalid plugin provider icon "icon\.svg": (?:file does not exist or is not a regular file|path leaves the plugin directory|exceeds 64 KiB)$/.test(message)) {
    classification = "plugin_provider_icon";
    assertion = message;
  } else if (/^Provider '?kiro-http'? (?:is not configured|is disabled|is not available(?:\. Please ensure the CLI is installed\.)?)$/.test(message)) {
    classification = "native_provider_unavailable";
    assertion = message;
  } else if (message === "Plugin contribution must return a cleanup function") {
    classification = "plugin_contribution_contract";
    assertion = message;
  } else if (message.startsWith("Build failed with ")) {
    classification = "plugin_compilation";
    assertion = "The real fixture plugin failed compilation";
  } else if (code && /^E(?:NOENT|ACCES|PERM|ADDRINUSE|CONNREFUSED|CONNRESET|PIPE)$/.test(code)) {
    classification = "fixture_io";
    assertion = `Fixture I/O failed (${code})`;
  }
  return {
    type, ...(code ? { code } : {}), classification, assertion,
    messageSnippet: safeMessageSnippet(message),
    messageDigest: createHash("sha256").update(message).digest("hex"),
    ...(location ? { source: `test/paseo-reconnect.mjs:${location[1]}:${location[2]}` } : {}),
    ...(error?.cause ? { cause: safeError(error.cause) } : {}),
  };
}
// PluginService deliberately catches built-in startup/registration failures.
// Retain only classified errors for our owned plugin, never raw daemon logs.
const logger = pino({ level: "error" }, {
  write(line) {
    const entry = JSON.parse(line);
    if (entry.msg === "Failed to start built-in plugin" && entry.pluginId === fixturePluginId)
      pluginFailures.push({ stage: fixtureStage, ...safeError(entry.err) });
  },
});
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
  pluginFailures,
};
// Both acknowledgement scenarios share the same outage window: about 60s for
// a rejected retry followed by recovery, then 30s to prove close cancels retry.
const startedAt = Date.now();
const deadline = startedAt + 105000;
async function bounded(promise, label, maximum = 10000) {
  let timer;
  const remaining = Math.min(maximum, deadline - Date.now());
  assert.ok(remaining > 0, "Reconnect qualification exceeded 105 second deadline");
  try {
    report.stage = label;
    fixtureStage = label;
    const value = await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), remaining); }),
    ]);
    report.lastCompletedStage = label;
    return value;
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
// Provider icons are plugin-root-relative and cannot resolve through a symlink
// outside that root. Package the real provider asset with the wrapper too.
await publishFixtureFile(path.join(fixturePlugin, "icon.svg"),
  await readFile(path.join(app, "plugin/omp-kiro/icon.svg")));
await publishFixtureFile(path.join(fixturePlugin, "paseo-plugin.json"), JSON.stringify({
  id: fixturePluginId, name: "Native reconnect backend qualification", requirements: { paseo: ">=0.13.0" },
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
  // PluginServerContext requires synchronous contribution cleanup. Connections
  // belong to the real provider runtime and are disposed by its shutdown path.
  return () => {};
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
  }, logger, { builtinPlugins: {
    ids: new Set([fixturePluginId]),
    async load(start) {
      await start({ id: fixturePluginId, directory: fixturePlugin });
    },
  } }), "daemon creation");
  await bounded(daemon.start(), "daemon start");
  report.stage = fixtureStage = "native plugin registration";
  assert.equal(pluginFailures.length, 0, "Native fixture plugin registration failed");
  const providers = await bounded(daemon.agentManager.listProviderAvailability(), "native provider registration");
  assert.ok(providers.some((provider) => provider.provider === "kiro-http" && provider.available),
    "Native fixture provider was not registered and available");
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
    report.activeScenario = kind;
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
    const submitMessage = async () => {
      try {
        await client.sendAgentMessage(agent.id, `Write exactly one fixture marker ${state.marker}`, { messageId: state.clientMessageId });
        state.delivery = { accepted: true };
      } catch (error) {
        state.delivery = { accepted: false, code: error.code, outcome: error.outcome };
        throw error;
      }
    };
    if (kind === "accepted-before-drop") {
      await bounded(submitMessage(), "accepted prompt acknowledgement");
      assert.deepEqual(state.delivery, { accepted: true });
    } else {
      dropAcknowledgement = true;
      state.outcome = submitMessage().catch((error) => { state.unknownDeliveryError = error; });
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
    stage: report.stage,
    lastCompletedStage: report.lastCompletedStage,
    activeScenario: report.activeScenario,
    ...safeError(error),
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
