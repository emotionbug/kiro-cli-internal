// Windows-only qualification of the assembled release, not a real Kiro service test.
// Run: node test/windows-smoke.mjs <absolute bundle root> [safe evidence directory]
// Only report.json and web-ui.png are retained. Credentials, keys, browser profiles,
// daemon logs and workspace contents live in a temporary directory outside the ZIP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32", "This qualification requires Windows x64");
assert.equal(process.arch, "x64", "This qualification requires Windows x64");
const bundle = process.argv[2];
assert.ok(bundle && path.isAbsolute(bundle), "An absolute assembled bundle root is required");
const node = path.join(bundle, "runtime/node/node.exe");
// The fixture and every imported helper must use the shipped Node, including SQLite.
if (path.resolve(process.execPath).toLowerCase() !== path.resolve(node).toLowerCase()) {
  const child = spawn(node, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  await smoke();
}

async function smoke() {
  const evidence = path.resolve(
    process.argv[3] ?? path.join(process.cwd(), "windows-smoke-evidence"),
  );
  assert.ok(
    evidence !== path.resolve(bundle) && !evidence.startsWith(`${path.resolve(bundle)}${path.sep}`),
    "Evidence must be outside the bundle",
  );
  await mkdir(evidence, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "Kiro portable 공간 "));
  assert.ok(
    !scratch.startsWith(`${path.resolve(bundle)}${path.sep}`),
    "Fixtures must be outside the bundle",
  );
  const data = path.join(scratch, "private 사용자 state");
  const workspace = path.join(scratch, "workspace with spaces 작업");
  const tlsDir = path.join(scratch, "tls");
  await Promise.all([mkdir(workspace), mkdir(tlsDir)]);
  const report = {
    qualification: "assembled Windows ZIP: Paseo -> OMP -> pinned Kiro HTTP plugin",
    upstream: "controlled loopback HTTPS fixture; no real account or service generation",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    result: "failed",
    phase: "prerequisites",
    memory: {
      unit: "bytes",
      meaning: "observed WorkingSet64 and PrivateMemorySize64, NOT heap limits or a hard RSS cap",
      excluded:
        "test driver and build tools; browser reported separately; shared OS WinHTTPAutoProxySvc excluded",
      samples: [],
    },
  };
  const commands = new Set();
  const sockets = new Set();
  const servers = [];
  const knownOwned = new Map();
  const browserOwned = new Map();
  const tuiOwned = new Map();
  const violations = [];
  const models = [];
  let daemon,
    browser,
    browserCdp,
    tui,
    fixtureFailure,
    pristine,
    stopComplete = false;
  const password = randomBytes(32).toString("base64url");
  const accessToken = randomBytes(32).toString("base64url");
  const fileText = "KIRO_PORTABLE_REAL_OMP_WRITE\nUnicode: 한글 ✓\n";
  const outputFile = path.join(workspace, "chain result 한글.txt");
  const toolId = "portable-smoke-write-1";
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    NO_PROXY: "",
    no_proxy: "",
    DO_NOT_TRACK: "1",
  };
  // Do not inherit machine/user proxy selection, auth, runtime options or homes.
  for (const key of Object.keys(env))
    if (/^(?:PASEO_|OMP_|PI_|KIRO_|BUN_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key))
      delete env[key];

  function launch(executable, args, { stdin = "", timeout = 60000, environment = env } = {}) {
    const child = spawn(executable, args, {
      cwd: workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: /^cmd\.exe$/i.test(path.basename(executable)),
    });
    commands.add(child);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      if (stderr.length < 4 * 1024 * 1024) stderr += bytes;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const done = new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            void (async () => {
              if (/^cmd\.exe$/i.test(path.basename(executable))) {
                try {
                  await sample("timed-out fixture command", child.pid);
                } catch {}
              }
              child.kill();
              reject(new Error("Owned command exceeded its deadline"));
            })();
          }, timeout)
        : undefined;
      child.once("error", (error) => {
        clearTimeout(timer);
        commands.delete(child);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        commands.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
    // A foreground launcher may exit before its first awaited readiness probe.
    done.catch(() => {});
    return { child, done };
  }
  function cmd(name, args, options) {
    // cmd /s /c requires an outer quote around a quoted executable. All values
    // are fixture-controlled; reject expansion/metacharacters instead of escaping
    // arbitrary shell input. Unicode and spaces intentionally remain in paths.
    const values = [path.join(bundle, `${name}.cmd`), ...args];
    for (const value of values)
      assert.ok(!/["%\r\n&|<>^!]/.test(value), "Unsafe cmd fixture argument");
    return launch(
      process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `"${values.map((value) => `"${value}"`).join(" ")}"`],
      options,
    );
  }
  function recordCommandFailure(label, result) {
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // Emit only fixed classifications/code tokens, never raw output or argument
    // values: sanitizing arbitrary logs cannot reliably remove every credential.
    const signatures = [
      ["ERR_MODULE_NOT_FOUND", /\bERR_MODULE_NOT_FOUND\b/],
      ["MODULE_NOT_FOUND", /\bMODULE_NOT_FOUND\b/],
      ["ERR_PACKAGE_PATH_NOT_EXPORTED", /\bERR_PACKAGE_PATH_NOT_EXPORTED\b/],
      ["ERR_DLOPEN_FAILED", /\bERR_DLOPEN_FAILED\b/],
      ["ENOENT", /\bENOENT\b/],
      ["EACCES", /\bEACCES\b/],
      ["EADDRINUSE", /\bEADDRINUSE\b/],
      ["ECONNREFUSED", /\bECONNREFUSED\b/],
      ["ETIMEDOUT", /\bETIMEDOUT\b/],
      ["ABORT_ERR", /\bABORT_ERR\b/],
      [
        "TLS_CERTIFICATE_REJECTED",
        /CERT_(?:AUTHORITY_INVALID|HAS_EXPIRED)|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|unable to verify|certificate verify failed|self.signed certificate/i,
      ],
      ["CLI_UNKNOWN_OPTION", /unknown option|unrecognized option/i],
      ["CLI_UNKNOWN_COMMAND", /unknown command/i],
      ["CLI_MISSING_ARGUMENT", /missing required argument|argument missing|not enough arguments/i],
      [
        "PROVIDER_UNAVAILABLE",
        /unknown provider|provider.{0,60}(?:not found|not available|disabled)|no provider/i,
      ],
      [
        "MODEL_UNAVAILABLE",
        /unknown model|model.{0,60}(?:not found|not available|not supported)|no account model metadata/i,
      ],
      [
        "CONFIGURATION_REJECTED",
        /invalid config|configuration.{0,40}(?:invalid|error)|schema validation|ZodError/i,
      ],
      ["PROXY_FAILURE", /proxy.{0,40}(?:failed|error|refused)|WinHTTP.{0,40}(?:failed|error)/i],
      ["AUTH_REQUIRED", /\bAUTH_REQUIRED\b|Password required|not logged in/i],
      ["AUTH_FAILED", /\bAUTH_FAILED\b|Incorrect password/i],
      ["DAEMON_UNREACHABLE", /\bDAEMON_UNREACHABLE\b|Cannot connect to daemon/i],
      ["SYNTAX_ERROR", /\bSyntaxError\b/],
      ["TYPE_ERROR", /\bTypeError\b/],
      ["BUN_RUNTIME_CRASH", /Bun (?:has crashed|crashed)|panic:|Segmentation fault/i],
    ];
    const classes = signatures.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    const knownCliCodes = [
      "INVALID_OPTIONS",
      "MISSING_PROMPT",
      "INVALID_TIMEOUT",
      "INVALID_LABEL",
      "INVALID_ENV",
      "WORKSPACE_NOT_FOUND",
      "WORKSPACE_CREATE_FAILED",
      "INVALID_THINKING_OPTION",
      "INVALID_OUTPUT_SCHEMA",
      "OUTPUT_SCHEMA_FAILED",
    ];
    for (const code of knownCliCodes)
      if (new RegExp(`\\b${code}\\b`).test(text)) classes.push(code);
    const option = text.match(
      /(?:unknown|unrecognized) option ['"]?(--[a-z][a-z-]{0,50})(?:['"\s]|$)/i,
    )?.[1];
    (report.commandFailures ??= []).push({
      command: label,
      exitCode: result.code,
      classifications: classes.length ? classes : ["UNCLASSIFIED_PRIVATE_OUTPUT"],
      ...(option ? { rejectedOption: option } : {}),
    });
  }
  async function checked(job, label) {
    let result;
    try {
      result = await job.done;
    } catch (error) {
      const safeCode = ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ENOEXEC"].includes(error?.code)
        ? error.code
        : "COMMAND_LAUNCH_OR_DEADLINE";
      (report.commandFailures ??= []).push({ command: label, classifications: [safeCode] });
      throw error;
    }
    if (result.code !== 0) recordCommandFailure(label, result);
    assert.equal(result.code, 0, `${label} failed (see safe commandFailures classification)`);
    return result.stdout;
  }
  async function ps(source) {
    return checked(
      launch(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(source, "utf16le").toString("base64"),
        ],
        { timeout: 30000 },
      ),
      "Process inspection",
    );
  }
  async function sample(label, rootPid, target = knownOwned) {
    assert.ok(Number.isInteger(rootPid), "Owned process root missing");
    const raw = await ps(
      `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${rootPid}); do { $changed=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) {$changed=$true} } } while($changed); $out=@(foreach($p in $all) {if($ids.Contains([int]$p.ProcessId)) { $g=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if($g) { $role=''; if($p.Name -match '^node') { $role=switch -Regex ($p.CommandLine) {'run\\.mjs' {'wrapper Node';break} 'supervisor' {'Paseo supervisor';break} 'plugin' {'Paseo plugin Node';break} 'worker|daemon|server' {'Paseo daemon/worker Node';break} default {'owned Node'}} }; [pscustomobject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;name=[string]$p.Name;role=$role;created=$g.StartTime.ToUniversalTime().Ticks.ToString();workingSet=[long]$g.WorkingSet64;privateBytes=[long]$g.PrivateMemorySize64}}}}); ConvertTo-Json -InputObject $out -Compress`,
    );
    const rows = JSON.parse(raw.trim() || "[]");
    for (const row of rows) target.set(row.pid, row);
    assert.ok(
      !rows.some((row) => /^kiro(?:-cli)?(?:\.exe)?$/i.test(row.name)),
      "A forbidden Kiro CLI process was observed",
    );
    const safeRows = rows.map(({ name, role, workingSet, privateBytes }) => ({
      process:
        role ||
        (/kiro-proxy/i.test(name)
          ? "native proxy"
          : /^omp/i.test(name)
            ? "OMP"
            : /^cmd/i.test(name)
              ? "command launcher"
              : /chrome|msedge/i.test(name)
                ? "approved browser"
                : name),
      workingSet,
      privateBytes,
    }));
    const value = {
      phase: label,
      processes: safeRows,
      totalWorkingSet: rows.reduce((n, row) => n + row.workingSet, 0),
      totalPrivateBytes: rows.reduce((n, row) => n + row.privateBytes, 0),
    };
    if (target === browserOwned) report.browserMemory = value;
    else report.memory.samples.push(value);
    return rows;
  }
  async function liveOwned(target) {
    if (!target.size) return [];
    const entries = [...target.values()]
      .map((row) => `@{id=${row.pid};created='${row.created}'}`)
      .join(",");
    const raw = await ps(
      `$out=@(foreach($r in @(${entries})) {$p=Get-Process -Id $r.id -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $r.created) {[int]$r.id}}); ConvertTo-Json -InputObject $out -Compress`,
    );
    return JSON.parse(raw.trim() || "[]");
  }
  async function waitFor(probe, label, timeout = 45000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (fixtureFailure) throw fixtureFailure;
      if (await probe()) return;
      await delay(200);
    }
    throw new Error(`${label} exceeded its deadline`);
  }
  async function listen(server) {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server.address().port;
  }
  try {
    pristine = await inventory();
    const manifest = JSON.parse(await readFile(path.join(bundle, "bundle-manifest.json"), "utf8"));
    assert.ok(
      !manifest.files.some((entry) => /(?:^|\/)kiro(?:-cli)?\.exe$/i.test(entry.path)),
      "Bundle must not contain Kiro CLI",
    );
    const require = createRequire(path.join(bundle, "app/package.json"));
    const cliPackage = require.resolve("@getpaseo/cli/package.json");
    const cliMeta = JSON.parse(await readFile(cliPackage, "utf8"));
    const shim = await readFile(path.join(path.dirname(cliPackage), cliMeta.bin.paseo), "utf8");
    assert.match(
      shim,
      /import\s+['"]\.\.\/dist\/index\.js['"]/,
      "Published Paseo CLI shim must resolve to dist/index.js",
    );
    const control = await import(pathToFileURL(require.resolve("@getpaseo/server/daemon-control")));
    const plugin = path.join(bundle, "app/plugin/omp-kiro");
    const { crc32 } = await import(pathToFileURL(path.join(plugin, "server/eventstream.mjs")));
    function frame(type, body) {
      const headers = Buffer.concat(
        Object.entries({ ":message-type": "event", ":event-type": type }).map(([name, value]) => {
          const key = Buffer.from(name),
            text = Buffer.from(value),
            head = Buffer.alloc(1 + key.length + 3);
          head[0] = key.length;
          key.copy(head, 1);
          head[1 + key.length] = 7;
          head.writeUInt16BE(text.length, 2 + key.length);
          return Buffer.concat([head, text]);
        }),
      );
      const payload = Buffer.from(JSON.stringify(body));
      const bytes = Buffer.alloc(16 + headers.length + payload.length);
      bytes.writeUInt32BE(bytes.length, 0);
      bytes.writeUInt32BE(headers.length, 4);
      bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
      headers.copy(bytes, 12);
      payload.copy(bytes, 12 + headers.length);
      bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
      return bytes;
    }
    report.phase = "ephemeral strict TLS fixture";
    let openssl = path.join(bundle, "runtime/git/usr/bin/openssl.exe");
    try {
      await access(openssl);
    } catch {
      openssl = "openssl.exe";
    }
    const ca = path.join(tlsDir, "ca.pem"),
      caKey = path.join(tlsDir, "ca.key");
    const leaf = path.join(tlsDir, "leaf.pem"),
      leafKey = path.join(tlsDir, "leaf.key"),
      csr = path.join(tlsDir, "leaf.csr");
    const extensions = path.join(tlsDir, "leaf.ext");
    await writeFile(
      extensions,
      "subjectAltName=DNS:runtime.us-east-1.kiro.dev,DNS:management.us-east-1.kiro.dev\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    );
    await checked(
      launch(openssl, [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-keyout",
        caKey,
        "-out",
        ca,
        "-subj",
        "/CN=Portable Smoke Ephemeral CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ]),
      "Ephemeral CA",
    );
    await checked(
      launch(openssl, [
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-keyout",
        leafKey,
        "-out",
        csr,
        "-subj",
        "/CN=runtime.us-east-1.kiro.dev",
      ]),
      "Ephemeral leaf key",
    );
    await checked(
      launch(openssl, [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        ca,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-days",
        "1",
        "-sha256",
        "-extfile",
        extensions,
        "-out",
        leaf,
      ]),
      "Ephemeral leaf certificate",
    );
    let generations = 0,
      catalogs = 0,
      toolResultSeen = false,
      finalSent = false;
    const tlsServer = https.createServer(
      { key: await readFile(leafKey), cert: await readFile(leaf) },
      async (request, response) => {
        try {
          const host = request.headers.host?.replace(/:443$/, "");
          assert.ok(
            ["runtime.us-east-1.kiro.dev", "management.us-east-1.kiro.dev"].includes(host),
            "Unexpected upstream HTTPS host",
          );
          assert.equal(request.method, "POST", "Unexpected upstream method");
          assert.equal(request.url.split("?")[0], "/", "Unexpected upstream URL path");
          assert.equal(
            request.headers.authorization,
            `Bearer ${accessToken}`,
            "Fixture credential did not reach HTTPS upstream",
          );
          let raw = "";
          for await (const part of request) {
            raw += part;
            assert.ok(raw.length < 16 * 1024 * 1024, "Upstream request too large");
          }
          const body = JSON.parse(raw);
          if (host === "management.us-east-1.kiro.dev") {
            assert.equal(
              request.headers["x-amz-target"],
              "KiroControlPlaneBearerService.ListAvailableModels",
              "Unexpected catalog API",
            );
            catalogs++;
            response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
            response.end(
              JSON.stringify({
                models: [
                  {
                    modelId: "auto",
                    modelName: "Fixture Auto",
                    tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 8192 },
                  },
                  {
                    modelId: "fixture-named",
                    modelName: "Fixture Named",
                    tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 8192 },
                  },
                ],
              }),
            );
            return;
          }
          assert.equal(
            request.headers["x-amz-target"],
            "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
            "Unexpected generation API",
          );
          const current = body.conversationState.currentMessage.userInputMessage;
          models.push(current.modelId);
          assert.equal(
            current.modelId,
            "auto",
            "Selected auto model must remain unchanged on every turn",
          );
          generations++;
          response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
          if (generations === 1) {
            await sample("first real OMP model turn", daemon.child.pid);
            const offered = current.userInputMessageContext.tools.map(
              (tool) => tool.toolSpecification,
            );
            const write = offered.find((tool) => tool.name === "write");
            assert.ok(write, "Real OMP did not offer its write tool");
            const schema = write.inputSchema.json;
            assert.ok(
              schema.properties.path && schema.properties.content,
              "Offered write schema must declare path and content",
            );
            const input = { path: outputFile, content: fileText };
            if (schema.properties.ikey) input.ikey = "portable-smoke-write";
            for (const key of schema.required ?? [])
              assert.ok(key in input, "Write tool declares an unsupported required field");
            response.end(
              frame("toolUseEvent", {
                toolUseId: toolId,
                name: write.name,
                input: JSON.stringify(input),
                stop: true,
              }),
            );
          } else {
            assert.equal(
              generations,
              2,
              "Unexpected extra generation (no synthetic success fallback)",
            );
            const result = current.userInputMessageContext.toolResults?.find(
              (item) => item.toolUseId === toolId,
            );
            assert.equal(result?.status, "success", "Actual write tool result was not successful");
            assert.equal(
              await readFile(outputFile, "utf8"),
              fileText,
              "Actual OMP tool did not create the exact file",
            );
            toolResultSeen = true;
            await sample("real write result returned upstream", daemon.child.pid);
            finalSent = true;
            response.end(
              Buffer.concat([
                frame("assistantResponseEvent", { content: "KIRO_PORTABLE_CHAIN_OK" }),
                frame("metadataEvent", {
                  tokenUsage: { uncachedInputTokens: 42, outputTokens: 8, totalTokens: 50 },
                }),
              ]),
            );
          }
        } catch (error) {
          fixtureFailure = error;
          response.destroy();
        }
      },
    );
    const tlsPort = await listen(tlsServer);
    const connects = new Map();
    const proxyServer = http.createServer((_request, response) => {
      violations.push("non-CONNECT proxy request");
      response.writeHead(403).end();
    });
    proxyServer.on("connect", (request, client, head) => {
      const allowed = /^(runtime|management)\.us-east-1\.kiro\.dev:443$/;
      if (!allowed.test(request.url)) {
        violations.push("unapproved CONNECT target");
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const host = request.url.split(":")[0];
      connects.set(host, (connects.get(host) ?? 0) + 1);
      // Never resolve the original hostname. The only outbound socket is loopback.
      const upstream = net.connect(tlsPort, "127.0.0.1");
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    const proxyPort = await listen(proxyServer);
    // Defense against accidental environment-based egress before manual mode is set.
    Object.assign(env, {
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    const reserve = net.createServer();
    const port = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    assert.notEqual(port, 6767, "Never target the user daemon");
    report.phase = "root cmd setup and private auth";
    await checked(
      cmd(
        "setup",
        ["--data-dir", data, "--accept-plugin-code", "--password-stdin", "--port", String(port)],
        { stdin: `${password}\n` },
      ),
      "Root setup.cmd",
    );
    await checked(
      cmd("network", [
        "--data-dir",
        data,
        "--mode",
        "manual",
        "--proxy",
        `http://127.0.0.1:${proxyPort}`,
      ]),
      "Root network.cmd without extra CA",
    );
    const authCode = `import { saveKiroAuth } from ${JSON.stringify(pathToFileURL(path.join(plugin, "server/auth.mjs")).href)}; let raw=''; for await (const b of process.stdin) raw+=b; await saveKiroAuth(JSON.parse(raw), {authFile:process.argv[1]});`;
    await checked(
      launch(node, ["--input-type=module", "-e", authCode, path.join(data, "auth.sqlite3")], {
        stdin: JSON.stringify({
          kind: "social",
          provider: "google",
          access_token: accessToken,
          refresh_token: randomBytes(32).toString("base64url"),
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          profile_arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/portable-fixture",
        }),
      }),
      "Actual plugin saveKiroAuth",
    );
    report.phase = "real model discovery through strict TLS proxy";
    const untrusted = await cmd("models", ["--data-dir", data]).done;
    assert.notEqual(
      untrusted.code,
      0,
      "Actual discovery must reject the untrusted ephemeral certificate",
    );
    assert.equal(catalogs, 0, "Untrusted TLS must fail before any authenticated catalog request");
    await checked(
      cmd("network", [
        "--data-dir",
        data,
        "--mode",
        "manual",
        "--proxy",
        `http://127.0.0.1:${proxyPort}`,
        "--ca",
        ca,
      ]),
      "Root network.cmd with public extra CA",
    );
    await checked(cmd("models", ["--data-dir", data]), "Root models.cmd");
    const catalog = JSON.parse(await readFile(path.join(data, "models.json"), "utf8"));
    assert.deepEqual(catalog.models.map((model) => model.id).sort(), ["auto", "fixture-named"]);
    const config = JSON.parse(await readFile(path.join(data, "paseo/config.json"), "utf8"));
    assert.deepEqual(
      config.agents.providers["kiro-omp-http"].models.map((model) => model.id).sort(),
      ["kiro-http/auto", "kiro-http/fixture-named"],
    );
    assert.equal(
      config.daemon.agentProfiles.find((profile) => profile.id === "kiro-omp-http").model,
      "kiro-http/auto",
    );
    assert.notEqual(
      config.daemon.auth.password,
      password,
      "Paseo must persist a hash, not the plaintext password",
    );
    report.phase = "foreground owned Paseo startup";
    daemon = cmd("start", ["--data-dir", data, "--no-browser"], { timeout: 0 });
    let instance;
    await waitFor(
      async () => {
        if (daemon.child.exitCode !== null) {
          recordCommandFailure("Foreground start.cmd exited before readiness", await daemon.done);
          throw new Error("Foreground launcher exited before readiness");
        }
        instance = await control.readDaemonInstance(path.join(data, "paseo"));
        if (!instance || instance.listen !== `127.0.0.1:${port}`) return false;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1500),
          });
          return response.ok && /<html/i.test(await response.text());
        } catch {
          return false;
        }
      },
      "Owned daemon readiness",
      90000,
    );
    assert.ok(instance.pid > 0, "Owned daemon lock missing PID");
    const owner = JSON.parse(await readFile(path.join(data, "runtime-owner.json"), "utf8"));
    assert.equal(
      owner.daemonPid,
      instance.pid,
      "Readiness must correspond to the wrapper-owned daemon",
    );
    await sample("daemon ready before agent", daemon.child.pid);
    report.phase = "actual Paseo CLI OMP write tool chain";
    const prompt =
      "Use the write tool requested by the model to create the fixture file, then report the final model response.";
    const cliOutput = await checked(
      cmd(
        "paseo",
        [
          "--data-dir",
          data,
          "--",
          "agent",
          "run",
          prompt,
          "--provider",
          "kiro-omp-http",
          "--model",
          "kiro-http/auto",
          "--cwd",
          workspace,
          "--mode",
          "full",
          "--wait-timeout",
          "120s",
          "--json",
        ],
        { timeout: 150000 },
      ),
      "Root paseo.cmd agent run",
    );
    if (fixtureFailure) throw fixtureFailure;
    const cliResult = JSON.parse(cliOutput.trim());
    assert.match(
      cliResult.agentId,
      /^[a-zA-Z0-9_-]+$/,
      "CLI must return a safe actual agent identifier",
    );
    if (cliResult.status !== "completed") {
      report.agentFailureStatus = ["created", "running", "timeout", "permission", "error"].includes(
        cliResult.status,
      )
        ? cliResult.status
        : "unexpected";
      const failureTranscript = await cmd("paseo", [
        "--data-dir",
        data,
        "--",
        "agent",
        "logs",
        cliResult.agentId,
      ]).done;
      recordCommandFailure("Actual agent returned non-completed status", failureTranscript);
    }
    assert.equal(cliResult.status, "completed", "Actual Paseo CLI agent did not complete");
    assert.equal(
      cliResult.provider,
      "kiro-omp-http",
      "Actual Paseo provider differs from OMP profile",
    );
    const transcript = await checked(
      cmd("paseo", [
        "--data-dir",
        data,
        "--",
        "agent",
        "logs",
        cliResult.agentId,
        "--filter",
        "text",
      ]),
      "Actual completed agent transcript",
    );
    assert.ok(
      transcript.includes("KIRO_PORTABLE_CHAIN_OK"),
      "Final fixture response did not reach the actual Paseo transcript",
    );
    assert.ok(
      toolResultSeen && finalSent && generations === 2,
      "Two-turn actual tool chain was not observed",
    );
    assert.equal(await readFile(outputFile, "utf8"), fileText);
    await delay(2000);
    const idle = await sample("completed agent after two seconds idle", daemon.child.pid);
    assert.ok(
      idle.some((row) => /^omp(?:\.exe)?$/i.test(row.name)),
      "OMP child was not observed",
    );
    assert.ok(
      idle.some((row) => /kiro-proxy/i.test(row.name)),
      "Native proxy child was not observed",
    );
    report.chain = {
      cliStatus: cliResult.status,
      provider: cliResult.provider,
      permissionMode: "full",
      generations,
      selectedModelEveryTurn: models,
      catalogRequests: catalogs,
      discoveredModels: catalog.models.map((model) => model.id),
      realTool: "write",
      realToolResult: "success",
      fileSHA256: createHash("sha256").update(fileText).digest("hex"),
      finalResponseInPaseoTranscript: "KIRO_PORTABLE_CHAIN_OK",
      noKiroCliInBundleOrObservedChildren: true,
    };
    report.transport = {
      mode: "manual",
      backend: "native WinHTTP/SSPI proxy",
      strictTls: true,
      untrustedCertificateRejectedByActualDiscovery: true,
      extraEphemeralCA: true,
      allowedConnects: Object.fromEntries(connects),
      rejectedRequests: violations.length,
      upstreamSocketDestinations:
        "127.0.0.1 only; original service hostnames never resolved by fixture",
    };
    assert.equal(violations.length, 0, "An unexpected network destination was attempted");

    report.phase = "standalone OMP actual terminal surface";
    const pty = require("node-pty");
    let tuiOutput = "",
      tuiExit;
    tui = pty.spawn(
      process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `""${path.join(bundle, "omp.cmd")}" --console --data-dir "${data}""`],
      { name: "xterm-256color", cols: 100, rows: 30, cwd: workspace, env },
    );
    const tuiDone = new Promise((resolve) =>
      tui.onExit((event) => {
        tuiExit = event;
        resolve(event);
      }),
    );
    tui.onData((text) => {
      tuiOutput = (tuiOutput + text).slice(-1024 * 1024);
      if (text.includes("\x1b[6n")) tui.write("\x1b[1;1R");
    });
    await waitFor(
      async () => {
        if (tuiExit) {
          recordCommandFailure("Standalone OMP TUI exited before readiness", {
            code: tuiExit.exitCode,
            stdout: tuiOutput,
            stderr: "",
          });
          throw new Error("Standalone OMP exited before its terminal surface was ready");
        }
        const visible = tuiOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        return (
          tuiOutput.includes("\x1b[") && /Fixture Auto|kiro-http\/auto|\bauto\b/i.test(visible)
        );
      },
      "Standalone OMP TUI render",
      60000,
    );
    await sample("standalone OMP terminal (separate launcher)", tui.pid, tuiOwned);
    tui.write("\x04"); // Supported Ctrl+D shutdown with an empty editor.
    const tuiResult = await Promise.race([
      tuiDone,
      delay(15000, undefined, { ref: false }).then(() => {
        throw new Error("Standalone OMP did not handle terminal exit");
      }),
    ]);
    assert.equal(tuiResult.exitCode, 0, "Standalone OMP terminal did not exit cleanly");
    await waitFor(
      async () => !(await liveOwned(tuiOwned)).length,
      "Standalone OMP proxy cleanup",
      15000,
    );
    tui = undefined;
    assert.equal(generations, 2, "Opening the terminal must not send an unsolicited generation");
    report.standaloneOmp = {
      surface: "actual OMP TUI through Windows ConPTY and root omp.cmd --console",
      selectedModelRendered: "kiro-http/auto",
      terminalExit: "Ctrl+D",
      cleanExit: true,
      ownedProcessesRemaining: 0,
      unsolicitedGenerations: 0,
      wezTermGuiExercised: false,
    };

    report.phase = "approved browser bundled web UI";
    const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter(Boolean)
      .flatMap((base) => [
        path.join(base, "Google/Chrome/Application/chrome.exe"),
        path.join(base, "Microsoft/Edge/Application/msedge.exe"),
      ]);
    let browserExe;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        browserExe = candidate;
        break;
      } catch {}
    }
    assert.ok(
      browserExe,
      "An approved preinstalled Chrome or Edge is required; browsers are never downloaded",
    );
    const browserPortServer = net.createServer();
    const browserPort = await listen(browserPortServer);
    await new Promise((resolve) => browserPortServer.close(resolve));
    browser = launch(
      browserExe,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-client-side-phishing-detection",
        "--disable-domain-reliability",
        "--disable-features=OptimizationHints,MediaRouter",
        "--metrics-recording-only",
        "--password-store=basic",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        "--proxy-bypass-list=127.0.0.1;localhost",
        `--remote-debugging-port=${browserPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${path.join(scratch, "browser profile")}`,
        "--window-size=1280,900",
        "about:blank",
      ],
      { timeout: 0 },
    );
    let pageTarget;
    await waitFor(async () => {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${browserPort}/json/list`, {
            signal: AbortSignal.timeout(1500),
          })
        ).json();
        pageTarget = targets.find((target) => target.type === "page");
        return Boolean(pageTarget?.webSocketDebuggerUrl);
      } catch {
        return false;
      }
    }, "Headless browser startup");
    browserCdp = await cdp(pageTarget.webSocketDebuggerUrl);
    const uiViolations = [];
    browserCdp.on("Fetch.requestPaused", (event) => {
      const url = new URL(event.request.url);
      const allowed =
        ["data:", "blob:", "about:"].includes(url.protocol) ||
        (["http:", "ws:"].includes(url.protocol) &&
          url.hostname === "127.0.0.1" &&
          url.port === String(port));
      if (!allowed) uiViolations.push("non-loopback page request blocked");
      void browserCdp
        .send(
          allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
          allowed
            ? { requestId: event.requestId }
            : { requestId: event.requestId, errorReason: "BlockedByClient" },
        )
        .catch(() => {});
    });
    await browserCdp.send("Page.enable");
    await browserCdp.send("Runtime.enable");
    await browserCdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    await browserCdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    let dom;
    await waitFor(
      async () => {
        const result = await browserCdp.send("Runtime.evaluate", {
          expression:
            'JSON.stringify({title:document.title,text:document.body?.innerText||"",passwordInputs:document.querySelectorAll("input[type=password]").length,controls:document.querySelectorAll("input,button,[role=button]").length})',
          returnByValue: true,
        });
        try {
          dom = JSON.parse(result.result.value);
        } catch {
          return false;
        }
        return /paseo/i.test(dom.title) && dom.text.length > 20 && dom.controls > 0;
      },
      "Bundled web UI render",
      60000,
    );
    await delay(1000);
    // Do not inject the password into the browser or publish arbitrary DOM text.
    // This is explicitly UI-shell/login rendering, not authenticated UI retrieval.
    const screenshot = await browserCdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const png = Buffer.from(screenshot.data, "base64");
    assert.ok(
      png.length > 5000 && png.subarray(1, 4).toString() === "PNG",
      "Browser screenshot missing",
    );
    await writeFile(path.join(evidence, "web-ui.png"), png);
    await sample(
      "headless UI render (separate from application stack)",
      browser.child.pid,
      browserOwned,
    );
    report.webUi = {
      browser: /chrome/i.test(path.basename(browserExe))
        ? "preinstalled Chrome headless"
        : "preinstalled Edge headless",
      documentTitleContainsPaseo: /paseo/i.test(dom.title),
      renderedControls: dom.controls,
      passwordInputRendered: dom.passwordInputs > 0,
      screenshot: "web-ui.png",
      screenshotSHA256: createHash("sha256").update(png).digest("hex"),
      scope:
        "actual bundled unauthenticated web UI shell/login screen; completed agent proved via CLI, not authenticated browser",
      blockedExternalPageRequests: uiViolations.length,
    };
    assert.equal(uiViolations.length, 0, "Web UI attempted an external page request");
    await browserCdp.send("Browser.close").catch(() => {});
    await Promise.race([
      browser.done,
      delay(15000, undefined, { ref: false }).then(() => {
        throw new Error("Headless browser did not exit");
      }),
    ]);
    browserCdp.close();
    browserCdp = undefined;

    report.phase = "owned shutdown and pristine bundle";
    await checked(cmd("stop", ["--data-dir", data], { timeout: 45000 }), "Root stop.cmd");
    await Promise.race([
      daemon.done,
      delay(45000, undefined, { ref: false }).then(() => {
        throw new Error("Foreground launcher/native proxy did not exit");
      }),
    ]);
    await waitFor(
      async () => (await liveOwned(knownOwned)).length === 0,
      "Owned stack termination",
      30000,
    );
    assert.equal(
      await control.readDaemonInstance(path.join(data, "paseo")),
      null,
      "Owned daemon lock remains",
    );
    const stoppedAgain = JSON.parse(
      (await checked(cmd("stop", ["--data-dir", data]), "Repeated root stop.cmd")).trim(),
    );
    assert.equal(stoppedAgain.action, "not_running", "Repeated stop must report not_running");
    stopComplete = true;
    await checked(
      cmd("doctor", ["--data-dir", data, "--verify-all"]),
      "Root doctor.cmd --verify-all",
    );
    // Also detect additions/deletions: manifest verification alone only hashes
    // listed files. Snapshot all names and hashes before setup and after shutdown.
    await assertPristine();
    assert.equal(violations.length, 0);
    report.cleanup = {
      fixtureDaemonStopped: true,
      repeatedStop: "not_running",
      ownedStackProcessesRemaining: 0,
      integrity: "doctor --verify-all and complete file inventory unchanged",
      fixtureStateOutsideBundle: true,
    };
    report.result = "passed";
    report.phase = "complete";
  } catch (error) {
    // Never publish raw child output, error paths, stack traces or fixture secrets.
    report.failure = {
      type: error?.name ?? "Error",
      assertion:
        error?.code === "ERR_ASSERTION"
          ? String(error.message)
              .split("\n")[0]
              .replaceAll(bundle, "[bundle]")
              .replaceAll(scratch, "[fixture]")
              .replaceAll(password, "[secret]")
              .replaceAll(accessToken, "[secret]")
          : "Qualification failed in the recorded phase; private runtime output is intentionally not exported",
    };
    process.exitCode = 1;
  } finally {
    fixtureFailure = undefined;
    try {
      tui?.kill();
    } catch {}
    if (browser?.child.exitCode === null) {
      try {
        await sample("browser cleanup ownership capture", browser.child.pid, browserOwned);
      } catch {}
    }
    if (daemon && !stopComplete) {
      try {
        await sample("failure cleanup ownership capture", daemon.child.pid);
      } catch {}
      try {
        await checked(cmd("stop", ["--data-dir", data], { timeout: 30000 }), "Failure stop");
      } catch {}
    }
    if (browserCdp) {
      try {
        await browserCdp.send("Browser.close");
      } catch {}
      browserCdp.close();
    }
    // Stop only exact, previously observed owned identities. PID reuse is checked
    // by process creation time; no image-name/global taskkill is ever used.
    for (const target of [browserOwned, tuiOwned, knownOwned]) {
      try {
        const entries = [...target.values()]
          .map((row) => `@{id=${row.pid};created='${row.created}'}`)
          .join(",");
        if (entries)
          await ps(
            `foreach($r in @(${entries})) {$p=Get-Process -Id $r.id -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $r.created) {Stop-Process -Id $r.id -Force -ErrorAction SilentlyContinue}}`,
          );
      } catch {
        report.cleanupFailure = true;
        report.result = "failed";
        process.exitCode = 1;
      }
    }
    for (const child of commands) child.kill();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    try {
      await waitFor(
        async () =>
          !(await liveOwned(knownOwned)).length &&
          !(await liveOwned(browserOwned)).length &&
          !(await liveOwned(tuiOwned)).length,
        "Final fixture process cleanup",
        15000,
      );
      await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
      report.privateFixturesRemoved = true;
    } catch {
      report.privateFixturesRemoved = false;
      report.result = "failed";
      process.exitCode = 1;
    }
    await writeFile(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({
        result: report.result,
        phase: report.phase,
        evidence: ["report.json", ...(report.webUi ? ["web-ui.png"] : [])],
        privateFixturesRemoved: report.privateFixturesRemoved,
      }),
    );
  }

  async function inventory(root = bundle, prefix = "") {
    const result = [];
    for (const item of await readdir(root, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      assert.ok(!item.isSymbolicLink(), "Bundle cannot contain links");
      if (item.isDirectory())
        result.push(...(await inventory(path.join(root, item.name), relative)));
      else {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path.join(root, item.name))) hash.update(chunk);
        result.push([relative, hash.digest("hex")]);
      }
    }
    return result.sort((a, b) => a[0].localeCompare(b[0]));
  }
  async function assertPristine() {
    assert.deepEqual(
      await inventory(),
      pristine,
      "Bundle file inventory or bytes changed during smoke",
    );
  }
}

// Minimal build-only CDP client: uses bundled Node's WebSocket, never downloads a
// browser or adds a runtime dependency to the release ZIP.
async function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map(),
    handlers = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Browser CDP connection deadline exceeded"));
    }, 15000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Browser CDP connection failed"));
      },
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) item.reject(new Error("Browser CDP command failed"));
      else item.resolve(message.result);
    } else for (const handler of handlers.get(message.method) ?? []) handler(message.params);
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Browser CDP closed"));
    }
    pending.clear();
  });
  return {
    on(method, fn) {
      const list = handlers.get(method) ?? [];
      list.push(fn);
      handlers.set(method, list);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error("Browser CDP deadline exceeded"));
        }, 15000);
        pending.set(key, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}
