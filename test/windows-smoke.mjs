// Windows qualification: real Passession -> OMP -> Kiro HTTP -> native proxy.
// Only Kiro's upstream is a controlled TLS fixture; no live account or cloud inference.
// Native desktop interaction is verified separately, never represented by a web screenshot.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const bundle = process.argv[2];
assert.ok(bundle && path.isAbsolute(bundle), "An absolute assembled bundle root is required");
const node = path.join(bundle, "runtime/node/node.exe");
if (path.resolve(process.execPath).toLowerCase() !== path.resolve(node).toLowerCase()) {
  const child = spawn(node, [process.argv[1], ...process.argv.slice(2)], { stdio: "inherit" });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  await qualify();
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function inventory(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "Bundle contains a link");
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(path.join(root, entry.name), `${name}/`));
    else files.push([name, await digest(path.join(root, entry.name))]);
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}
function records(value, predicate) {
  if (!value || typeof value !== "object") return [];
  return [...(predicate(value) ? [value] : []), ...Object.values(value).flatMap((child) => records(child, predicate))];
}

async function qualify() {
  const evidence = path.resolve(process.argv[3] ?? "windows-smoke-evidence");
  assert.ok(evidence !== bundle && !evidence.startsWith(`${bundle}${path.sep}`), "Evidence must be outside the bundle");
  await mkdir(evidence, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "Kiro native 공간 "));
  const data = path.join(scratch, "private state 사용자");
  const workspace = path.join(scratch, "workspace 작업");
  const callerHome = path.join(scratch, "original caller 홈");
  const tlsDir = path.join(scratch, "tls");
  await Promise.all([mkdir(workspace), mkdir(callerHome), mkdir(tlsDir)]);
  const password = randomBytes(32).toString("base64url");
  const accessToken = randomBytes(32).toString("base64url");
  const report = {
    qualification: "Windows: Passession -> OMP -> Kiro HTTP -> WinHTTP/SSPI proxy",
    startedAt: new Date().toISOString(), result: "failed", phase: "setup",
    upstream: "Controlled loopback HTTPS fixture; no real Kiro account or inference",
    desktopUi: "Not exercised by this CLI qualification; separate native UI evidence required",
  };
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:HOME$|USERPROFILE$|PASEO_|OMP_|PI_|KIRO_|BUN_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(key)));
  Object.assign(environment, { HOME: callerHome, USERPROFILE: callerHome, NODE_TLS_REJECT_UNAUTHORIZED: "1", DO_NOT_TRACK: "1", PASEO_PASSWORD: password });
  const children = new Set(), sockets = new Set(), servers = new Set();
  let daemon, fixtureFailure, cleanStop = false;
  let generations = 0, catalogs = 0, searches = 0, quotaRequests = 0;
  const violations = [], sequence = [], cadence = [];
  const observedModels = [];
  const fileText = "KIRO_OMP_REAL_WRITE\nUnicode: 한글 ✓\n";
  const guardedText = `${fileText}COMPLETED_WRITE_MUST_NOT_REPEAT\n`;
  const outputFile = path.join(workspace, "chain result 한글.txt");
  const promptMarker = "KIRO_PORTABLE_RECOVERY_REQUEST";
  const partialText = "KIRO_PORTABLE_INTERRUPTED_TEXT";
  const finalText = "KIRO_PORTABLE_CHAIN_OK";
  const resumeMarker = "KIRO_PORTABLE_RESUME_REQUEST";
  const toolId = "portable-write-1", searchId = "portable-search-1";
  const searchQuery = "portable Kiro Windows 검색 qualification";
  const citation = { title: "Controlled source", url: "https://kiro-source.invalid/qualification", snippet: "CITATION_ONLY_NO_FETCH", citationId: "source-1", maxVerbatimWordLimit: 17 };
  let conversationId, failedAt;

  function safe(text) {
    for (const value of [password, accessToken, scratch, bundle]) text = text.replaceAll(value, "[fixture]");
    return text;
  }
  function launch(executable, args, { stdin = "", timeout = 60000 } = {}) {
    const child = spawn(executable, args, { cwd: workspace, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      windowsVerbatimArguments: /^cmd\.exe$/i.test(path.basename(executable)) });
    children.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (bytes) => { if (stdout.length < 4 * 1024 * 1024) stdout += bytes; });
    child.stderr.on("data", (bytes) => { if (stderr.length < 4 * 1024 * 1024) stderr += bytes; });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const done = new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { child.kill(); reject(new Error("Owned command deadline exceeded")); }, timeout) : undefined;
      child.once("error", (error) => { clearTimeout(timer); children.delete(child); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); children.delete(child); resolve({ code, stdout, stderr }); });
    });
    done.catch(() => {});
    return { child, done, output: () => ({ stdout, stderr }) };
  }
  function cmd(name, args = [], options) {
    const values = [path.join(bundle, `${name}.cmd`), "--data-dir", data, ...args];
    for (const value of values) assert.ok(!/["%\r\n&|<>^!]/.test(value), "Unsafe fixture argument");
    return launch(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", `"${values.map((value) => `"${value}"`).join(" ")}"`], options);
  }
  async function checked(job, label) {
    const result = await job.done;
    if (result.code !== 0) console.error(safe(`${label}: ${result.stderr}\n${result.stdout}`));
    assert.equal(result.code, 0, `${label} failed`);
    return result.stdout;
  }
  async function until(probe, label, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (fixtureFailure) throw fixtureFailure;
      if (await probe()) return;
      await delay(200);
    }
    throw new Error(`${label} deadline exceeded`);
  }
  async function listen(server) {
    servers.add(server);
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return server.address().port;
  }
  async function start() {
    daemon = cmd("start", ["--no-app"], { timeout: 0 });
    await until(async () => {
      if (daemon.child.exitCode !== null) {
        const output = daemon.output();
        console.error(safe(output.stdout + output.stderr));
        throw new Error("Launcher exited before readiness");
      }
      return /(?:Passession|Paseo).*Kiro HTTP ready:/i.test(daemon.output().stdout);
    }, "Private daemon startup", 90000);
  }
  async function stop() {
    await checked(cmd("stop", [], { timeout: 45000 }), "Private stop");
    await Promise.race([daemon.done, delay(45000, undefined, { ref: false }).then(() => { throw new Error("Launcher did not exit after stop"); })]);
  }
  function completedResult(state, id) {
    const results = records(state, (item) => item.toolUseId === id && "status" in item);
    assert.equal(results.length, 1, "Completed tool result must be preserved exactly once");
    if (results[0].status !== "success") console.error(safe(JSON.stringify(results[0])));
    assert.equal(results[0].status, "success", "Real OMP tool execution failed");
    return results[0];
  }
  function retryObserved(kind) {
    const elapsedMs = performance.now() - failedAt;
    assert.ok(elapsedMs >= 29000 && elapsedMs < 65000, "Transport must retain its 30-second recovery cadence");
    cadence.push({ kind, elapsedMs });
  }
  try {
    const pristine = await inventory(bundle);
    const manifest = JSON.parse(await readFile(path.join(bundle, "bundle-manifest.json"), "utf8"));
    const plugin = path.join(bundle, "app/plugin/omp-kiro");
    const { crc32 } = await import(pathToFileURL(path.join(plugin, "server/eventstream.mjs")).href);
    function frame(type, body) {
      const headers = Buffer.concat(Object.entries({ ":message-type": "event", ":event-type": type }).map(([name, value]) => {
        const key = Buffer.from(name), text = Buffer.from(value), header = Buffer.alloc(key.length + 4);
        header[0] = key.length; key.copy(header, 1); header[key.length + 1] = 7;
        header.writeUInt16BE(text.length, key.length + 2);
        return Buffer.concat([header, text]);
      }));
      const payload = Buffer.from(JSON.stringify(body));
      const bytes = Buffer.alloc(16 + headers.length + payload.length);
      bytes.writeUInt32BE(bytes.length, 0); bytes.writeUInt32BE(headers.length, 4);
      bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
      headers.copy(bytes, 12); payload.copy(bytes, 12 + headers.length);
      bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
      return bytes;
    }
    const openssl = path.join(bundle, "runtime/git/usr/bin/openssl.exe");
    const ca = path.join(tlsDir, "ca.pem"), caKey = path.join(tlsDir, "ca.key"), leaf = path.join(tlsDir, "leaf.pem"), leafKey = path.join(tlsDir, "leaf.key"), csr = path.join(tlsDir, "leaf.csr"), extensions = path.join(tlsDir, "leaf.ext");
    await writeFile(extensions, "subjectAltName=DNS:runtime.us-east-1.kiro.dev,DNS:management.us-east-1.kiro.dev\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
    await checked(launch(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-keyout", caKey, "-out", ca, "-subj", "/CN=Portable Ephemeral CA", "-addext", "basicConstraints=critical,CA:TRUE"]), "Fixture CA");
    await checked(launch(openssl, ["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", leafKey, "-out", csr, "-subj", "/CN=runtime.us-east-1.kiro.dev"]), "Fixture CSR");
    await checked(launch(openssl, ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", extensions, "-out", leaf]), "Fixture certificate");
    const tlsServer = https.createServer({ key: await readFile(leafKey), cert: await readFile(leaf) }, async (request, response) => {
      try {
        const host = request.headers.host?.replace(/:443$/, "");
        assert.ok(["runtime.us-east-1.kiro.dev", "management.us-east-1.kiro.dev"].includes(host), "Unexpected service host");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, `Bearer ${accessToken}`, "Wrong managed account");
        let raw = "";
        for await (const bytes of request) { raw += bytes; assert.ok(raw.length < 16 * 1024 * 1024); }
        const body = JSON.parse(raw);
        const target = request.headers["x-amz-target"];
        if (request.url.split("?")[0] === "/mcp") {
          assert.equal(body.method, "tools/call");
          assert.equal(body.params.name, "web_search");
          assert.deepEqual(body.params.arguments, { query: searchQuery });
          assert.equal(++searches, 1, "Search was repeated");
          sequence.push("search");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [citation] }) }] } }));
          return;
        }
        if (target === "KiroControlPlaneBearerService.ListAvailableModels") {
          catalogs++;
          response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
          response.end(JSON.stringify({ models: ["auto", "fixture-named"].map((id) => ({ modelId: id, modelName: id, tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 8192 } })) }));
          return;
        }
        if (target === "AmazonCodeWhispererService.GetUsageLimits") {
          quotaRequests++;
          response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
          response.end(JSON.stringify({ nextDateReset: Math.floor(Date.now() / 1000) + 86400, subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO_PLUS" }, overageConfiguration: { overageStatus: "DISABLED" }, usageBreakdownList: [{ resourceType: "CREDIT", unit: "INVOCATIONS", currentUsage: 12, currentUsageWithPrecision: 12.375, usageLimit: 100, usageLimitWithPrecision: 100.5, bonuses: [] }] }));
          return;
        }
        assert.equal(target, "AmazonCodeWhispererStreamingService.GenerateAssistantResponse", "Unexpected upstream operation");
        const state = body.conversationState, current = state.currentMessage.userInputMessage;
        observedModels.push(current.modelId);
        assert.equal(current.modelId, "fixture-named", "Selected model changed");
        generations++;
        if (generations === 6) {
          assert.ok(JSON.stringify(state).includes(resumeMarker), "Resumed prompt missing");
          assert.ok(JSON.stringify(state).includes(finalText), "OMP lost completed history after daemon restart");
          assert.equal(await readFile(outputFile, "utf8"), guardedText);
          sequence.push("resume");
          response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
          response.end(frame("assistantResponseEvent", { content: "KIRO_PORTABLE_RESUME_OK" }));
          return;
        }
        assert.ok(generations <= 5, "Unexpected generation");
        conversationId ??= state.conversationId;
        assert.equal(state.conversationId, conversationId, "Retry changed conversation");
        assert.equal(JSON.stringify(state).split(promptMarker).length - 1, 1, "Retry duplicated the original prompt");
        const offered = current.userInputMessageContext.tools.map((tool) => tool.toolSpecification);
        const write = offered.find((tool) => tool.name === "write");
        const search = offered.find((tool) => tool.name === "web_search");
        assert.ok(write?.inputSchema.json.properties.path && write.inputSchema.json.properties.content, "OMP write tool missing");
        assert.ok(search?.inputSchema.json.properties.query, "Kiro search tool missing");
        if (generations === 1) {
          sequence.push("503"); failedAt = performance.now();
          response.writeHead(503, { "content-type": "application/x-amz-json-1.0", "x-amzn-errortype": "ServiceUnavailableException", "retry-after": "0" });
          response.end(JSON.stringify({ __type: "ServiceUnavailableException", message: "Controlled temporary failure" }));
          return;
        }
        if (generations === 2) {
          retryObserved("503"); sequence.push("write");
          response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
          response.end(frame("toolUseEvent", { toolUseId: toolId, name: "write", input: JSON.stringify({ path: outputFile, content: fileText, i: "Writing qualification fixture" }), stop: true }));
          return;
        }
        completedResult(state, toolId);
        if (generations === 3) {
          assert.equal(await readFile(outputFile, "utf8"), fileText, "Actual OMP write did not produce the expected bytes");
          await writeFile(outputFile, guardedText);
          sequence.push("partial-disconnect");
          const partial = frame("assistantResponseEvent", { content: partialText });
          response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "content-length": partial.length + 1024 });
          response.flushHeaders(); response.write(partial);
          await delay(300); failedAt = performance.now(); response.destroy();
          return;
        }
        assert.equal(await readFile(outputFile, "utf8"), guardedText, "Completed write was replayed");
        if (generations === 4) {
          retryObserved("partial-disconnect"); sequence.push("search-tool");
          assert.equal(JSON.stringify(state).split(partialText).length - 1, 1, "Continuation lost/duplicated accepted text");
          response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
          response.end(frame("toolUseEvent", { toolUseId: searchId, name: "web_search", input: JSON.stringify({ query: searchQuery }), stop: true }));
          return;
        }
        const searchResult = completedResult(state, searchId);
        const text = JSON.stringify(searchResult.content);
        for (const expected of [citation.url, citation.citationId, "maxVerbatimWordLimit", "17"]) assert.ok(text.includes(expected), "Search citation/quotation limit lost");
        sequence.push("final");
        response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
        response.end(frame("assistantResponseEvent", { content: finalText }));
      } catch (error) {
        fixtureFailure ??= error;
        console.error(safe(error.message));
        if (!response.headersSent) response.writeHead(400, { "content-type": "application/json", "x-amzn-errortype": "ValidationException" }).end(JSON.stringify({ __type: "ValidationException", message: "Fixture invariant failed" }));
        else response.destroy();
      }
    });
    const tlsPort = await listen(tlsServer);
    function rejectedDestination(method, target) {
      let destination = "invalid destination";
      try {
        const url = new URL(method === "CONNECT" ? `http://${target}` : target);
        destination = url.host;
      } catch {}
      const observation = { method, destination, phase: report.phase };
      violations.push(observation);
      console.error(`Rejected outbound destination: ${JSON.stringify(observation)}`);
    }
    const proxyServer = http.createServer((request, response) => {
      rejectedDestination(request.method, request.url);
      response.writeHead(403).end();
    });
    proxyServer.on("connect", (request, client, head) => {
      if (!/^(runtime|management)\.us-east-1\.kiro\.dev:443$/.test(request.url)) {
        rejectedDestination("CONNECT", request.url); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
      }
      const upstream = net.connect(tlsPort, "127.0.0.1");
      sockets.add(upstream); upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.once("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy()); client.on("close", () => upstream.destroy());
    });
    const proxyPort = await listen(proxyServer);
    const reserve = net.createServer(), port = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    assert.notEqual(port, 6767);
    const neighbor = http.createServer((_request, response) => response.end("UNRELATED_SERVICE_UNCHANGED"));
    const neighborPort = await listen(neighbor);
    const networkArgs = ["--mode", "manual", "--proxy", `http://127.0.0.1:${proxyPort}`];
    report.phase = "setup and explicit credential import";
    await checked(cmd("setup", ["--accept-plugin-code", "--password-stdin", "--port", String(port)], { stdin: `${password}\n` }), "Setup");
    await checked(cmd("network", networkArgs), "Network without CA");
    const sourceDb = path.join(callerHome, ".local/share/kiro-cli/data.sqlite3");
    await mkdir(path.dirname(sourceDb), { recursive: true });
    await checked(launch(node, ["--input-type=module", "-e", "import{DatabaseSync}from'node:sqlite';let s='';for await(const b of process.stdin)s+=b;const d=new DatabaseSync(process.argv[1]);d.exec('CREATE TABLE auth_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');d.prepare('INSERT INTO auth_kv VALUES(?,?)').run('kirocli:social:token',s);d.close();", sourceDb], { stdin: JSON.stringify({ kind: "social", provider: "google", access_token: accessToken, refresh_token: randomBytes(32).toString("base64url"), expires_at: new Date(Date.now() + 3600000).toISOString(), profile_arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/portable-fixture" }) }), "Synthetic credential source");
    const sourceHash = await digest(sourceDb);
    await checked(cmd("auth", ["import-cli"]), "Explicit credential import");
    assert.equal(await digest(sourceDb), sourceHash, "Import modified the original store");
    report.phase = "strict TLS and account catalog";
    assert.notEqual((await cmd("models").done).code, 0, "Untrusted certificate accepted");
    assert.equal(catalogs, 0, "Authenticated request crossed an untrusted connection");
    await checked(cmd("network", [...networkArgs, "--ca", ca]), "Approved fixture CA");
    await checked(cmd("models"), "Models");
    const quota = JSON.parse(await checked(cmd("usage"), "Usage"));
    const balance = quota.balances.find((item) => item.id === "credits-base");
    assert.equal(balance.used, 12.375); assert.equal(balance.limit, 100.5); assert.equal(balance.remaining, 88.125);
    const catalog = JSON.parse(await readFile(path.join(data, "models.json"), "utf8"));
    assert.deepEqual(catalog.models.map((item) => item.id).sort(), ["auto", "fixture-named"]);
    report.phase = "real OMP generation and recovery";
    await start();
    const result = JSON.parse(await checked(cmd("paseo", ["--", "run", `${promptMarker}: write the requested file and perform the requested Kiro search.`, "--provider", "kiro-http", "--model", "kiro-http/fixture-named", "--mode", "full", "--cwd", workspace, "--wait-timeout", "240s", "--json"], { timeout: 270000 }), "Passession OMP run"));
    if (fixtureFailure) throw fixtureFailure;
    assert.equal(result.status, "completed", "Real OMP session did not complete");
    assert.equal(result.provider, "kiro-http");
    const logs = () => checked(cmd("paseo", ["--", "agent", "logs", result.agentId, "--filter", "text"]), "Persisted transcript");
    const transcript = await logs();
    assert.equal(transcript.split(finalText).length - 1, 1, "Final response missing or duplicated");
    assert.equal(transcript.split(partialText).length - 1, 1, "Partial text missing or duplicated");
    assert.equal(await readFile(outputFile, "utf8"), guardedText);
    assert.deepEqual(sequence, ["503", "write", "partial-disconnect", "search-tool", "search", "final"]);
    report.phase = "restart and persisted session resume";
    await stop();
    await start();
    assert.ok((await logs()).includes(finalText), "Daemon restart lost persisted history");
    const resumed = JSON.parse(await checked(cmd("paseo", ["--", "send", result.agentId, resumeMarker, "--json"], { timeout: 90000 }), "Resume OMP conversation"));
    assert.equal(resumed.status, "completed");
    assert.ok((await logs()).includes("KIRO_PORTABLE_RESUME_OK"), "Resumed response not persisted");
    assert.equal(generations, 6); assert.equal(searches, 1);
    report.phase = "owned cleanup and bundle integrity";
    await stop(); cleanStop = true;
    await checked(cmd("stop"), "Idempotent stop");
    assert.equal(await (await fetch(`http://127.0.0.1:${neighborPort}`)).text(), "UNRELATED_SERVICE_UNCHANGED");
    await checked(cmd("doctor", ["--verify-all"]), "Doctor");
    assert.deepEqual(await inventory(bundle), pristine, "Runtime modified or added bundle files");
    assert.equal(violations.length, 0, "Unapproved proxy destination attempted");
    report.chain = { provider: "kiro-http", engine: "omp", generations, requestedModel: "fixture-named", selectedModels: observedModels, sequence, retryCadence: cadence, realTools: ["write", "web_search"], completedWriteNotRepeated: true, persistedResume: true, fileSHA256: createHash("sha256").update(guardedText).digest("hex") };
    report.transport = { backend: "WinHTTP/SSPI", mode: "manual", untrustedTlsRejected: true, approvedCaAccepted: true, upstreamSockets: "loopback only" };
    report.quota = { used: balance.used, limit: balance.limit, remaining: balance.remaining, requests: quotaRequests };
    report.catalog = { requests: catalogs, models: catalog.models.map((item) => item.id) };
    report.webSearch = { requests: searches, citationAndQuotationLimitPreserved: true, returnedSourcesFetched: 0 };
    report.applicationProxyViolations = { count: violations.length };
    report.cleanup = { foregroundLauncherExited: true, unrelatedServicePreserved: true, bundleUnchanged: true };
    report.versions = Object.fromEntries(Object.entries(manifest.inputs).filter(([, value]) => value.version).map(([key, value]) => [key, value.version]));
    report.result = "passed"; report.phase = "complete";
  } catch (error) {
    console.error(safe(error.stack ?? error.message));
    report.failure = { type: error.name, message: safe(error.message.split("\n")[0]) };
    process.exitCode = 1;
  } finally {
    report.applicationProxyViolations = { count: violations.length, destinations: violations };
    if (daemon && !cleanStop) {
      try { await stop(); } catch { report.cleanupFailed = true; }
    }
    for (const child of children) child.kill();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    try { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); report.privateFixturesRemoved = true; }
    catch { report.privateFixturesRemoved = false; report.result = "failed"; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ result: report.result, phase: report.phase, privateFixturesRemoved: report.privateFixturesRemoved }));
  }
}
