// Windows-only qualification of the assembled release, not a real Kiro service test.
// Run: node test/windows-smoke.mjs <absolute bundle root> [safe evidence directory]
// Only report.json and web-ui.png are retained. Credentials, keys, browser profiles,
// daemon logs and workspace contents live in a temporary directory outside the ZIP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
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
    qualification: "assembled Windows ZIP: Paseo -> native pinned Kiro HTTP provider",
    startedAt: new Date().toISOString(),
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
  const upstreamRequests = (report.upstreamRequests = {
    management: { total: 0, catalog: 0, usage: 0, other: 0, clients: { Node: 0, other: 0 } },
    runtime: { total: 0, generation: 0, search: 0, other: 0, clients: { Node: 0, other: 0 } },
  });
  const commands = new Set();
  const sockets = new Set();
  const servers = [];
  const knownOwned = new Map();
  const browserOwned = new Map();
  const violations = [];
  const nativeLogCheckpoint = new Map();
  let nativeLogCheckpointTaken = false;
  const models = [];
  let daemon,
    browser,
    browserCdp,
    uiOrigin,
    fixtureFailure,
    pristine,
    stopComplete = false;
  const password = randomBytes(32).toString("base64url");
  const accessToken = randomBytes(32).toString("base64url");
  const fileText = "KIRO_PORTABLE_NATIVE_WRITE\nUnicode: 한글 ✓\n";
  const outputFile = path.join(workspace, "chain result 한글.txt");
  const canonicalWorkspace = await realpath(workspace);
  const relativeOutput = path.relative(canonicalWorkspace, outputFile);
  report.workspaceIdentity = {
    callerUsesFilesystemAlias: workspace !== canonicalWorkspace,
    outputParentIsCanonicalWorkspace: await realpath(path.dirname(outputFile)) === canonicalWorkspace,
    lexicalAbsoluteTargetAppearsOutsideCanonicalRoot:
      relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput),
  };
  const toolId = "portable-smoke-write-1";
  const searchToolId = "portable-smoke-search-1";
  const promptMarker = "KIRO_PORTABLE_RECOVERY_REQUEST";
  const partialText = "KIRO_PORTABLE_INTERRUPTED_TEXT";
  // The write tool is idempotent, so change its output after its first completed
  // result. Re-executing that write during recovery would erase this sentinel.
  const guardedFileText = `${fileText}RECOVERY_SENTINEL_MUST_SURVIVE\n`;
  const searchQuery = "portable Kiro Windows 검색 qualification";
  const searchResult = {
    results: [
      {
        title: "Controlled Kiro citation",
        url: "https://kiro-portable-source.invalid/qualification",
        snippet: "KIRO_PORTABLE_CITATION_ONLY_NO_FETCH",
        citationId: "portable-source-1",
        maxVerbatimWordLimit: 17,
      },
    ],
  };
  const expectedGenerations = 5;
  const callerHome = path.join(scratch, "original caller 홈");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HOME|USERPROFILE)$/i.test(key))),
    HOME: callerHome,
    USERPROFILE: callerHome,
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
    return { child, done, output: () => ({ stdout, stderr }) };
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
  function privateTlsCodes(text) {
    // Emit only known identifiers, never the surrounding private message.
    return [
      "KIRO_TLS_CA_INVALID",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "CERT_UNTRUSTED",
      "CERT_REJECTED",
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "CERT_REVOKED",
      "CERT_SIGNATURE_FAILURE",
      "INVALID_CA",
      "INVALID_PURPOSE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_TLS_CERT_ALTNAME_FORMAT",
      "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
      "ERR_TLS_HANDSHAKE_TIMEOUT",
      "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
      "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
      "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
      "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_PROXY_CONNECTION_FAILED",
      "ERR_TUNNEL_CONNECTION_FAILED",
      "ERR_HTTP_PROXY_CONNECT",
    ].filter((code) => new RegExp(`\\b${code}\\b`).test(text));
  }
  function classifyPrivateOutput(text) {
    // Export only fixed whitelist classifications, never raw log fragments,
    // paths, credentials, headers or arguments from any child or private log.
    const signatures = [
      ["ERR_MODULE_NOT_FOUND", /\bERR_MODULE_NOT_FOUND\b/],
      ["MODULE_NOT_FOUND", /\bMODULE_NOT_FOUND\b/],
      ["ERR_PACKAGE_PATH_NOT_EXPORTED", /\bERR_PACKAGE_PATH_NOT_EXPORTED\b/],
      ["ERR_DLOPEN_FAILED", /\bERR_DLOPEN_FAILED\b/],
      ["ENOENT", /\bENOENT\b/],
      ["EACCES", /\bEACCES\b/],
      ["EADDRINUSE", /\bEADDRINUSE\b/],
      ["ECONNREFUSED", /\bECONNREFUSED\b/],
      ["ECONNRESET", /\bECONNRESET\b/],
      ["ETIMEDOUT", /\bETIMEDOUT\b/],
      ["ABORT_ERR", /\bABORT_ERR\b/],
      [
        "TLS_CA_CONFIGURATION_INVALID",
        /\bKIRO_TLS_CA_INVALID\b|Kiro TLS CA configuration is unreadable or malformed/i,
      ],
      [
        "TLS_HOSTNAME_MISMATCH",
        /ERR_TLS_CERT_ALTNAME_(?:INVALID|FORMAT)|hostname.{0,60}(?:mismatch|does not match)|certificate.{0,60}(?:hostname mismatch|not valid for)/i,
      ],
      [
        "TLS_TRUST_CHAIN_REJECTED",
        /UNABLE_TO_(?:GET_ISSUER_CERT(?:_LOCALLY)?|VERIFY_LEAF_SIGNATURE)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_UNTRUSTED|CERT_AUTHORITY_INVALID|unknown ca|unable to get (?:local )?issuer certificate/i,
      ],
      ["TLS_CERTIFICATE_EXPIRED", /CERT_HAS_EXPIRED|certificate has expired/i],
      ["TLS_CERTIFICATE_NOT_YET_VALID", /CERT_NOT_YET_VALID|certificate is not yet valid/i],
      [
        "TLS_CERTIFICATE_REJECTED",
        /CERT_(?:AUTHORITY_INVALID|HAS_EXPIRED|NOT_YET_VALID|UNTRUSTED|REJECTED|REVOKED|SIGNATURE_FAILURE)|SELF_SIGNED_CERT|UNABLE_TO_(?:VERIFY|GET_ISSUER_CERT)|unable to verify|certificate verify failed|self.signed certificate/i,
      ],
      [
        "TLS_HANDSHAKE_FAILED",
        /ERR_(?:TLS|SSL)_|TLS.{0,60}(?:handshake|failed|error)|SSL.{0,60}(?:handshake|failed|error)/i,
      ],
      [
        "EXTENSION_LOAD_FAILED",
        /(?:extension|plugin).{0,120}(?:failed to load|load failed|error loading|failed to import)|(?:failed to load|error loading|failed to import).{0,120}(?:extension|plugin)|ExtensionLoadError/i,
      ],
      [
        "MODEL_DISCOVERY_FAILED",
        /(?:model discovery|discover.{0,20}models|fetchDynamicModels|ListAvailableModels).{0,120}(?:failed|error|rejected|timeout)|(?:failed|error).{0,120}(?:model discovery|fetchDynamicModels|ListAvailableModels)/i,
      ],
      [
        "MODEL_CATALOG_REJECTED",
        /models\.cmd|model catalog.{0,100}(?:invalid|malformed|mismatch|account|failed|missing)|OMP_KIRO_MODEL_CATALOG_FILE/i,
      ],
      [
        "MANAGED_AUTH_FAILED",
        /KiroAuthError|managed (?:Kiro )?(?:credential|login|auth)|Cannot open authentication storage|login expired|invalid_grant|login_expired|UnauthorizedException|AccessDeniedException|Kiro HTTP (?:401|403)/i,
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
      ["PROXY_FAILURE", /ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|HTTP_PROXY_CONNECT)|proxy.{0,40}(?:failed|error|refused)|WinHTTP.{0,40}(?:failed|error)/i],
      ["AUTH_REQUIRED", /\bAUTH_REQUIRED\b|Password required|not logged in/i],
      ["AUTH_FAILED", /\bAUTH_FAILED\b|Incorrect password/i],
      ["DAEMON_UNREACHABLE", /\bDAEMON_UNREACHABLE\b|Cannot connect to daemon/i],
      ["SYNTAX_ERROR", /\bSyntaxError\b/],
      ["TYPE_ERROR", /\bTypeError\b/],
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
    return classes.length ? classes : ["UNCLASSIFIED_PRIVATE_OUTPUT"];
  }
  function recordCommandFailure(label, result) {
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    (report.commandFailures ??= []).push({
      command: label,
      exitCode: result.code,
      classifications: classifyPrivateOutput(text),
      tlsAndProxyCodes: privateTlsCodes(text),
      operationTokens: ["spawn", "open", "stat", "lstat", "mkdir", "realpath"].filter(
        (operation) => new RegExp(`\\b${operation}\\b`, "i").test(text),
      ),
      referencedRuntimeRoles: [
        ["bundled-node", path.join(bundle, "runtime/node/node.exe")],
        ["workspace", workspace],
        ["managed-auth", path.join(data, "auth.sqlite3")],
      ].filter(([, value]) =>
        text.toLowerCase().includes(value.toLowerCase()) ||
        text.toLowerCase().includes(JSON.stringify(value).slice(1, -1).toLowerCase()),
      ).map(([role]) => role),
    });
  }
  async function recordOwnedNativeLogFailures(checkpoint = false) {
    const roots = [["private-paseo", path.join(data, "paseo/logs")]];
    if (!checkpoint) {
      report.nativeLogFailureScope = nativeLogCheckpointTaken
        ? "Only bytes appended after the actual-agent launch checkpoint"
        : "Not collected: no actual-agent launch checkpoint";
      report.nativeLogFailures = [];
      if (!nativeLogCheckpointTaken) return;
    }
    for (const [role, root] of roots) {
      const counts = { role, filesRead: 0, bytesRead: 0, truncatedFiles: 0, unreadableEntries: 0 };
      const classifications = new Set();
      const tlsAndProxyCodes = new Set();
      async function visit(directory) {
        let entries;
        try {
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            counts.unreadableEntries++;
            return;
          }
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error.code !== "ENOENT") counts.unreadableEntries++;
          return;
        }
        for (const entry of entries) {
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            counts.unreadableEntries++;
            continue;
          }
          if (entry.isDirectory()) {
            await visit(file);
            continue;
          }
          if (!entry.isFile()) continue;
          let handle;
          try {
            handle = await open(file, "r");
            const { size, birthtimeMs } = await handle.stat();
            if (checkpoint) {
              nativeLogCheckpoint.set(file, { size, birthtimeMs });
              continue;
            }
            const prior = nativeLogCheckpoint.get(file);
            const start = prior?.birthtimeMs === birthtimeMs && size >= prior.size ? prior.size : 0;
            const length = Math.min(size - start, 4 * 1024 * 1024);
            if (!length) continue;
            const bytes = Buffer.alloc(length);
            const { bytesRead } = await handle.read(bytes, 0, length, Math.max(start, size - length));
            counts.filesRead++;
            counts.bytesRead += bytesRead;
            if (size - start > length) counts.truncatedFiles++;
            const text = bytes.subarray(0, bytesRead).toString("utf8");
            for (const value of classifyPrivateOutput(text))
              if (value !== "UNCLASSIFIED_PRIVATE_OUTPUT") classifications.add(value);
            for (const code of privateTlsCodes(text)) tlsAndProxyCodes.add(code);
          } catch {
            counts.unreadableEntries++;
          } finally {
            await handle?.close().catch(() => {});
          }
        }
      }
      await visit(root);
      if (!checkpoint)
        report.nativeLogFailures.push({
          ...counts,
          classifications: [...classifications].sort(),
          tlsAndProxyCodes: [...tlsAndProxyCodes].sort(),
        });
    }
    if (checkpoint) nativeLogCheckpointTaken = true;
  }
  async function recordPublishedCaBundles(approvedCa) {
    // Inspect only the owned wrapper's immutable exports. File presence does
    // not prove that a running provider loaded the trust bundle.
    const observation = (report.approvedCaBundle = {
      scope: "Owned wrapper-exported CA files; not a child environment or trust-store observation",
      actualProviderEnvironment: "Not exposed by public process/session inspection",
      candidateFiles: 0,
      readableFiles: 0,
      contentAddressMatches: 0,
      includesApprovedCa: 0,
      privateKeyFiles: 0,
      inspectionFailed: false,
    });
    try {
      const approved = new X509Certificate(await readFile(approvedCa));
      const root = path.join(data, "proxy");
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^trust-[a-f0-9]{64}\.pem$/.test(entry.name))
          continue;
        observation.candidateFiles++;
        const file = path.join(root, entry.name);
        if ((await lstat(file)).size > 4 * 1024 * 1024) {
          observation.inspectionFailed = true;
          continue;
        }
        const pem = await readFile(file, "utf8");
        observation.readableFiles++;
        if (entry.name === `trust-${createHash("sha256").update(pem).digest("hex")}.pem`)
          observation.contentAddressMatches++;
        if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(pem)) observation.privateKeyFiles++;
        const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
        if (blocks.some((block) => new X509Certificate(block).raw.equals(approved.raw)))
          observation.includesApprovedCa++;
      }
    } catch {
      observation.inspectionFailed = true;
    }
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
      !rows.some((row) => /^(?:kiro(?:-cli)?|omp|claude(?:-code)?|codex|copilot|opencode|pi|bun|wezterm(?:-gui|-mux-server)?)(?:\.exe)?$/i.test(row.name)),
      "A disallowed provider CLI or WezTerm process was observed",
    );
    const safeRows = rows.map(({ name, role, workingSet, privateBytes }) => ({
      process:
        role ||
        (/kiro-proxy/i.test(name)
          ? "native proxy"
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
    const disallowed = /(?:^|\/)(?:runtime\/(?:omp|wezterm|claude|codex|kiro-cli|bun)(?:\/|$)|(?:omp|wezterm|claude|kiro(?:-cli)?)(?:\.exe|\.cmd)$|node_modules\/(?:@oh-my-pi\/|@mariozechner\/pi-|@anthropic-ai\/claude|@openai\/codex))/i;
    assert.ok(!manifest.files.some((entry) => disallowed.test(entry.path)),
      "Bundle manifest contains a disallowed provider runtime");
    assert.ok(!pristine.some(([name]) => disallowed.test(name)),
      "Bundle inventory contains a disallowed provider runtime");
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
    const openssl = path.join(bundle, "runtime/git/usr/bin/openssl.exe");
    await access(openssl);
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
      quotaRequests = 0,
      searchRequests = 0,
      toolResultSeen = false,
      recoverySeen = false,
      searchResultSeen = false,
      provisionalTextDiscarded = false,
      conversationId,
      finalSent = false;
    const requestSequence = [];
    let beforeOutputFailureAt, partialFailureAt;
    const retryCadence = [];
    function observeRetry(kind, failedAt) {
      const elapsedMs = performance.now() - failedAt;
      assert.ok(elapsedMs >= 29000 && elapsedMs < 60000, "Transient retry must wait the requested 30-second period");
      retryCadence.push({ kind, elapsedMs });
    }
    // Inspect semantic records anywhere in current/history, rather than assuming
    // the host retries with one exact internal message arrangement.
    function records(value, predicate) {
      if (!value || typeof value !== "object") return [];
      return [
        ...(predicate(value) ? [value] : []),
        ...Object.values(value).flatMap((child) => records(child, predicate)),
      ];
    }
    function completedResult(state, id) {
      const results = records(state, (item) => item.toolUseId === id && "status" in item);
      assert.equal(results.length, 1, "A completed tool result must occur exactly once in history");
      if (results[0].status !== "success") {
        let text = (results[0].content ?? []).map((item) => item.text ?? "").join("\n");
        for (const value of [accessToken, outputFile, workspace, data, scratch, bundle])
          text = text.replaceAll(value, "[fixture]");
        report.nativeToolFailure = { status: results[0].status, text: text.slice(0, 2048) };
      }
      assert.equal(results[0].status, "success", "Actual native tool result was not successful");
      return results[0];
    }
    const connections = (report.connectionObservations = {
      scope: "Fixture-side observations grouped by operation window, not proof of client environment or TLS trust loading",
      phases: {},
    });
    function connectionPhase(name) {
      return (connections.phases[name] = {
        connectRequests: { management: 0, runtime: 0 },
        rejectedProxyRequests: 0,
        completedTlsHandshakes: { management: 0, runtime: 0, other: 0 },
        tlsClientErrors: 0,
        serverTlsClassifications: [],
        serverTlsAndProxyCodes: [],
        tunnelSocketErrors: 0,
      });
    }
    let currentConnections = connectionPhase("initialSetup");
    const socketConnections = new Map();
    function serviceRole(servername) {
      return servername === "management.us-east-1.kiro.dev"
        ? "management"
        : servername === "runtime.us-east-1.kiro.dev"
          ? "runtime"
          : "other";
    }
    const tlsServer = https.createServer(
      { key: await readFile(leafKey), cert: await readFile(leaf) },
      async (request, response) => {
        try {
          const host = request.headers.host?.replace(/:443$/, "");
          if (fixtureFailure) throw fixtureFailure;
          (report.upstreamTimeline ??= []).push({
            at: new Date().toISOString(),
            role: serviceRole(host),
            operation: request.headers["x-amz-target"] === "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
              ? "generation" : request.url.split("?")[0] === "/mcp" ? "search" : "management",
          });
          const target = request.headers["x-amz-target"];
          const group = host === "management.us-east-1.kiro.dev"
            ? upstreamRequests.management
            : host === "runtime.us-east-1.kiro.dev" ? upstreamRequests.runtime : null;
          if (group) {
            group.total++;
            const agent = request.headers["user-agent"] ?? "";
            const client = /^(?:node|undici|Node\.js)(?:[ /]|$)/i.test(agent) ? "Node" : "other";
            group.clients[client]++;
            const operation = host === "management.us-east-1.kiro.dev"
              ? target === "KiroControlPlaneBearerService.ListAvailableModels" ? "catalog"
                : target === "AmazonCodeWhispererService.GetUsageLimits" ? "usage" : "other"
              : request.url.split("?")[0] === "/mcp" ? "search"
                : target === "AmazonCodeWhispererStreamingService.GenerateAssistantResponse" ? "generation" : "other";
            group[operation]++;
          }
          assert.ok(
            ["runtime.us-east-1.kiro.dev", "management.us-east-1.kiro.dev"].includes(host),
            "Unexpected upstream HTTPS host",
          );
          assert.equal(request.method, "POST", "Unexpected upstream method");
          const requestPath = request.url.split("?")[0];
          assert.ok(
            requestPath === "/" || requestPath === "/mcp",
            "Unexpected upstream URL path",
          );
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
          if (requestPath === "/mcp") {
            assert.equal(host, "runtime.us-east-1.kiro.dev", "Search must use the Kiro origin");
            assert.equal(
              request.headers["x-amzn-kiro-profile-arn"],
              "arn:aws:codewhisperer:us-east-1:000000000000:profile/portable-fixture",
              "Search must authenticate the selected Kiro profile in its header",
            );
            assert.equal(body.jsonrpc, "2.0");
            assert.ok(typeof body.id === "string" && body.id.length > 0);
            assert.equal(body.method, "tools/call", "Default search must invoke Kiro MCP");
            assert.equal(body.params?.name, "web_search");
            assert.deepEqual(body.params.arguments, { query: searchQuery });
            assert.equal(generations, 4, "Kiro search must follow the recovered model tool call");
            assert.equal(++searchRequests, 1, "Search must execute exactly once");
            requestSequence.push("mcp:web_search");
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
            }));
            return;
          }
          if (host === "management.us-east-1.kiro.dev") {
            if (request.headers["x-amz-target"] === "AmazonCodeWhispererService.GetUsageLimits") {
              assert.equal(body.origin, "KIRO_CLI");
              assert.equal(body.isEmailRequired, false);
              quotaRequests++;
              const reset = Math.floor(Date.now() / 1000) + 86400;
              response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
              response.end(
                JSON.stringify({
                  nextDateReset: reset,
                  subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO_PLUS" },
                  overageConfiguration: { overageStatus: "DISABLED" },
                  usageBreakdownList: [
                    {
                      resourceType: "CREDIT",
                      unit: "INVOCATIONS",
                      currency: "USD",
                      currentUsage: 12,
                      currentUsageWithPrecision: 12.375,
                      usageLimit: 100,
                      usageLimitWithPrecision: 100.5,
                      nextDateReset: reset,
                      currentOverages: 0,
                      currentOveragesWithPrecision: 0,
                      overageCharges: 0,
                      overageRate: 0.04,
                      overageCap: 10000,
                      overageCapWithPrecision: 10000,
                      bonuses: [],
                    },
                  ],
                }),
              );
              return;
            }
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
          const state = body.conversationState;
          const current = state.currentMessage.userInputMessage;
          models.push(current.modelId);
          assert.equal(
            current.modelId,
            "fixture-named",
            "Explicit non-default model must remain unchanged on every attempt and turn",
          );
          conversationId ??= state.conversationId;
          assert.ok(conversationId, "Generation must identify its conversation");
          assert.equal(state.conversationId, conversationId, "Recovery must continue the same conversation");
          assert.equal(
            JSON.stringify(state).split(promptMarker).length - 1,
            1,
            "Recovery must retain the original request exactly once, not replay an ambiguous prompt",
          );
          generations++;
          assert.ok(generations <= expectedGenerations, "Unexpected extra generation");
          const offered = current.userInputMessageContext.tools.map(
            (tool) => tool.toolSpecification,
          );
          assert.equal(
            new Set(offered.map((tool) => tool.name)).size,
            offered.length,
            "Native provider must not offer duplicate tools",
          );
          const search = offered.find((tool) => tool.name === "web_search");
          assert.ok(search?.inputSchema.json.properties.query, "Native Kiro web_search was not offered");
          if (generations === 1) {
            beforeOutputFailureAt = performance.now();
            requestSequence.push("generation:503-before-output");
            response.writeHead(503, {
              "content-type": "application/x-amz-json-1.0",
              "x-amzn-errortype": "ServiceUnavailableException",
              "retry-after": "0",
            });
            response.end(JSON.stringify({
              __type: "ServiceUnavailableException",
              message: "Controlled transient service unavailable; retry the same model",
            }));
            return;
          }
          if (generations === 2) {
            observeRetry("503-before-output", beforeOutputFailureAt);
            requestSequence.push("generation:write-tool");
            await sample("native provider pre-output retry recovered", daemon.child.pid);
            const write = offered.find((tool) => tool.name === "write_file");
            assert.ok(write, "Native provider did not offer write_file");
            const schema = write.inputSchema.json;
            assert.deepEqual(schema.required, ["path", "content"]);
            assert.equal(schema.additionalProperties, false);
            assert.ok(schema.properties.path && schema.properties.content,
              "Native write_file schema must declare path and content");
            const input = { path: outputFile, content: fileText };
            response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
            response.end(frame("toolUseEvent", {
              toolUseId: toolId,
              name: write.name,
              input: JSON.stringify(input),
              stop: true,
            }));
            return;
          }
          completedResult(state, toolId);
          assert.equal(
            records(state, (item) => item.toolUseId === toolId && item.name === "write_file").length,
            1,
            "Recovery must retain exactly one completed write call",
          );
          if (generations === 3) {
            requestSequence.push("generation:partial-text-disconnect");
            assert.equal(
              await readFile(outputFile, "utf8"),
              fileText,
              "Actual native write_file did not create the exact file",
            );
            toolResultSeen = true;
            await sample("real write result before transport disconnect", daemon.child.pid);
            await writeFile(outputFile, guardedFileText);
            const partial = frame("assistantResponseEvent", { content: partialText });
            // An intentionally incomplete HTTP body makes this a transport
            // failure, not a valid completed assistant response or error event.
            response.writeHead(200, {
              "content-type": "application/vnd.amazon.eventstream",
              "content-length": partial.length + 1024,
            });
            response.flushHeaders();
            response.write(partial);
            await delay(300);
            partialFailureAt = performance.now();
            response.destroy();
            return;
          }
          assert.equal(
            await readFile(outputFile, "utf8"),
            guardedFileText,
            "Recovery repeated the completed write side effect",
          );
          if (generations === 4) {
            observeRetry("partial-response-disconnect", partialFailureAt);
            requestSequence.push("generation:recovered-search-tool");
            recoverySeen = true;
            provisionalTextDiscarded = !JSON.stringify(state).includes(partialText);
            assert.ok(provisionalTextDiscarded,
              "Native onRestart must discard provisional text from the retried request history");
            response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
            response.end(frame("toolUseEvent", {
              toolUseId: searchToolId,
              name: search.name,
              input: JSON.stringify({ query: searchQuery }),
              stop: true,
            }));
            return;
          }
          requestSequence.push("generation:final-with-citations");
          assert.equal(searchRequests, 1, "Actual native search must reach Kiro MCP");
          const result = completedResult(state, searchToolId);
          const resultText = JSON.stringify(result.content);
          for (const value of [
            searchResult.results[0].url,
            searchResult.results[0].snippet,
            searchResult.results[0].citationId,
            "maxVerbatimWordLimit",
          ])
            assert.ok(resultText.includes(value), "Model continuation lost Kiro citation data");
          const payloads = records(result.content, (item) => typeof item.text === "string")
            .map((item) => {
              try { return JSON.parse(item.text); } catch { return undefined; }
            });
          assert.ok(
            payloads.some((item) => item?.results?.some((source) =>
              source.url === searchResult.results[0].url && source.maxVerbatimWordLimit === 17)),
            "Model must receive the source-specific numeric quotation limit unchanged",
          );
          searchResultSeen = true;
          finalSent = true;
          response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
          response.end(Buffer.concat([
            frame("assistantResponseEvent", { content: "KIRO_PORTABLE_CHAIN_OK" }),
            frame("metadataEvent", {
              tokenUsage: { uncachedInputTokens: 42, outputTokens: 8, totalTokens: 50 },
            }),
          ]));
        } catch (error) {
          if (!fixtureFailure) {
            report.firstFixtureFailureAt = new Date().toISOString();
            fixtureFailure = error;
            report.fixtureProgress = {
              generations, catalogs, searchRequests, requestSequence: [...requestSequence],
              retryCadence: [...retryCadence], toolResultSeen, recoverySeen,
              searchResultSeen, provisionalTextDiscarded,
            };
          }
          if (!response.headersSent) {
            // A broken fixture is terminal, not another transient network fault.
            response.writeHead(400, {
              "content-type": "application/x-amz-json-1.0",
              "x-amzn-errortype": "ValidationException",
            });
            response.end(JSON.stringify({
              __type: "ValidationException", message: "Controlled fixture invariant failed",
            }));
          } else response.destroy();
        }
      },
    );
    tlsServer.on("connection", (socket) => socketConnections.set(socket.remotePort, currentConnections));
    tlsServer.on("secureConnection", (socket) => {
      const window = socketConnections.get(socket.remotePort) ?? currentConnections;
      window.completedTlsHandshakes[serviceRole(socket.servername)]++;
    });
    tlsServer.on("tlsClientError", (error, socket) => {
      const window = socketConnections.get(socket.remotePort) ?? currentConnections;
      window.tlsClientErrors++;
      const text = `${error?.code ?? ""}\n${error?.message ?? ""}`;
      window.serverTlsClassifications = [...new Set([
        ...window.serverTlsClassifications,
        ...classifyPrivateOutput(text).filter((value) => /^(?:TLS_|ECONNRESET$)/.test(value)),
      ])].sort();
      window.serverTlsAndProxyCodes = [...new Set([
        ...window.serverTlsAndProxyCodes,
        ...privateTlsCodes(text),
      ])].sort();
    });
    const tlsPort = await listen(tlsServer);
    const connects = new Map();
    const proxyServer = http.createServer((_request, response) => {
      currentConnections.rejectedProxyRequests++;
      violations.push("non-CONNECT proxy request");
      response.writeHead(403).end();
    });
    proxyServer.on("connect", (request, client, head) => {
      const window = currentConnections;
      const allowed = /^(runtime|management)\.us-east-1\.kiro\.dev:443$/;
      if (!allowed.test(request.url)) {
        window.rejectedProxyRequests++;
        violations.push("unapproved CONNECT target");
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const host = request.url.split(":")[0];
      connects.set(host, (connects.get(host) ?? 0) + 1);
      window.connectRequests[serviceRole(host)]++;
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
      upstream.on("error", () => {
        window.tunnelSocketErrors++;
        client.destroy();
      });
      client.on("error", () => {
        window.tunnelSocketErrors++;
        upstream.destroy();
      });
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
    const sourceDatabase = path.join(callerHome, ".local/share/kiro-cli/data.sqlite3");
    await mkdir(path.dirname(sourceDatabase), { recursive: true });
    const authCode = `import { DatabaseSync } from 'node:sqlite'; let raw=''; for await (const b of process.stdin) raw+=b; const db=new DatabaseSync(process.argv[1]); try { db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); db.prepare('INSERT INTO auth_kv (key,value) VALUES (?,?)').run('kirocli:social:token',raw); } finally { db.close(); }`;
    await checked(
      launch(node, ["--input-type=module", "-e", authCode, sourceDatabase], {
        stdin: JSON.stringify({
          kind: "social",
          provider: "google",
          access_token: accessToken,
          refresh_token: randomBytes(32).toString("base64url"),
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          profile_arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/portable-fixture",
        }),
      }),
      "Controlled original-home CLI authentication database",
    );
    const sourceHash = createHash("sha256").update(await readFile(sourceDatabase)).digest("hex");
    await checked(
      cmd("auth", ["--data-dir", data, "import-cli"]),
      "Root auth.cmd import-cli from original caller home",
    );
    assert.equal(
      createHash("sha256").update(await readFile(sourceDatabase)).digest("hex"),
      sourceHash,
      "Import modified the source CLI credential database",
    );
    report.cliAuthImport = {
      source: "original caller home, not isolated portable home",
      explicitDatabaseArgument: false,
      sourceDatabaseUnchanged: true,
      destination: "private managed store used by the subsequent native provider",
    };
    report.phase = "real model discovery through strict TLS proxy";
    currentConnections = connectionPhase("untrustedDiscovery");
    const untrusted = await cmd("models", ["--data-dir", data]).done;
    const untrustedOutput = `${untrusted.stdout}\n${untrusted.stderr}`;
    report.expectedUntrustedDiscovery = {
      classifications: classifyPrivateOutput(untrustedOutput),
      tlsAndProxyCodes: privateTlsCodes(untrustedOutput),
    };
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
    currentConnections = connectionPhase("approvedManagement");
    await checked(cmd("models", ["--data-dir", data]), "Root models.cmd");
    await recordPublishedCaBundles(ca);
    const directQuota = JSON.parse(
      await checked(cmd("usage", ["--data-dir", data]), "Root usage.cmd"),
    );
    const directBalance = directQuota.balances.find((balance) => balance.id === "credits-base");
    assert.equal(directBalance.used, 12.375);
    assert.equal(directBalance.limit, 100.5);
    assert.equal(directBalance.remaining, 88.125);
    const catalog = JSON.parse(await readFile(path.join(data, "models.json"), "utf8"));
    assert.deepEqual(catalog.models.map((model) => model.id).sort(), ["auto", "fixture-named"]);
    assert.match(catalog.accountId, /^[a-f0-9]{64}$/, "models.cmd must save only a safe account hash");
    assert.deepEqual(Object.keys(catalog).sort(), ["accountId", "fetchedAt", "models", "version"]);
    assert.equal(catalog.version, 1);
    const { readKiroAuth } = await import(pathToFileURL(path.join(plugin, "server/auth.mjs")).href);
    const { kiroCatalogAccountId, readKiroModelCatalog } = await import(
      pathToFileURL(path.join(plugin, "server/model-catalog.mjs")).href
    );
    const managedAuth = await readKiroAuth({ authFile: path.join(data, "auth.sqlite3") });
    assert.equal(catalog.accountId, kiroCatalogAccountId(managedAuth));
    assert.deepEqual(
      await readKiroModelCatalog(path.join(data, "models.json"), { auth: managedAuth }),
      catalog.models,
      "The shared reader must preserve exact account rows without aliases",
    );
    const config = JSON.parse(await readFile(path.join(data, "paseo/config.json"), "utf8"));
    assert.deepEqual(
      config.agents.providers["kiro-http"].models.map((model) => model.id).sort(),
      ["auto", "fixture-named"],
    );
    assert.equal(
      config.daemon.agentProfiles.find((profile) => profile.id === "kiro-http").model,
      "auto",
    );
    assert.equal(
      config.agents.providers["kiro-http"].env.OMP_KIRO_MODEL_CATALOG_FILE,
      path.join(data, "models.json"),
    );
    assert.equal(config.daemon.agentProfiles.find((profile) => profile.id === "kiro-http").modeId, "full");
    assert.equal(config.agents.providers["kiro-http"].enabled, true);
    assert.ok(!("kiro-omp-http" in config.agents.providers), "Obsolete profile must be absent");
    const catalogsBeforeColdStart = catalogs;
    assert.equal(catalogsBeforeColdStart, 1, "Only models.cmd may fetch catalog metadata before cold start");
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
    await recordOwnedNativeLogFailures(true);
    currentConnections = connectionPhase("actualAgent");
    report.phase = "actual native recovery, completed-tool replay protection and Kiro search";
    const prompt =
      `${promptMarker}: Execute the tools requested by the model to create the fixture file ` +
      "and search using default web_search, then report the final model response.";
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
          "--model",
          "fixture-named",
          "--cwd",
          workspace,
          // No mode override: qualify the packaged default Full access policy.
          "--wait-timeout",
          "240s",
          "--json",
        ],
        { timeout: 270000 },
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
    currentConnections = connectionPhase("remainingAcceptance");
    assert.equal(
      catalogs,
      catalogsBeforeColdStart,
      "Cold native startup must use the account snapshot without live discovery or a warm-up CLI",
    );
    assert.equal(
      cliResult.provider,
      "kiro-http",
      "Default Paseo provider must be the native Kiro HTTP profile",
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
    assert.ok(!transcript.includes(partialText),
      "Native onRestart must replace provisional text rather than publish a duplicated interrupted response");
    assert.equal(transcript.split("KIRO_PORTABLE_CHAIN_OK").length - 1, 1,
      "Completed native response must be published exactly once");
    assert.ok(
      toolResultSeen && recoverySeen && searchResultSeen && finalSent &&
        generations === expectedGenerations,
      "Actual native recovery and Kiro-only tool chain was not observed",
    );
    assert.deepEqual(requestSequence, [
      "generation:503-before-output",
      "generation:write-tool",
      "generation:partial-text-disconnect",
      "generation:recovered-search-tool",
      "mcp:web_search",
      "generation:final-with-citations",
    ], "Actual native provider must complete the full controlled recovery sequence");
    assert.equal(await readFile(outputFile, "utf8"), guardedFileText);
    await delay(2000);
    const nativeStateRoot = path.join(data, ".local", "state", "omp-kiro", "paseo");
    const persistedConversations = [];
    for (const entry of await readdir(nativeStateRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const bytes = await readFile(path.join(nativeStateRoot, entry.name), "utf8");
      const saved = JSON.parse(bytes);
      if (saved.model === "fixture-named" && bytes.includes(promptMarker))
        persistedConversations.push(saved);
    }
    assert.equal(persistedConversations.length, 1, "Completed native conversation must persist under this package's private data root");
    assert.equal(await realpath(persistedConversations[0].cwd), canonicalWorkspace);
    report.nativePersistence = {
      withinManagedPrivateData: true,
      completedConversations: persistedConversations.length,
      workspaceIdentityMatched: true,
      containsActualPrompt: true,
    };
    const idle = await sample("completed agent after two seconds idle", daemon.child.pid);
    assert.ok(
      idle.some((row) => /kiro-proxy/i.test(row.name)),
      "Native proxy child was not observed",
    );
    report.chain = {
      cliStatus: cliResult.status,
      provider: cliResult.provider,
      permissionMode: "full",
      generations,
      requestSequence,
      retryCadence,
      requestedModel: "fixture-named",
      selectedModelEveryTurn: models,
      catalogRequests: catalogs,
      discoveredModels: catalog.models.map((model) => model.id),
      coldStartCatalog: {
        source: "models.cmd account-bound snapshot",
        accountIdFormat: "sha256 lowercase hex",
        accountIdentityMatched: true,
        rawRowsPreserved: true,
        warmUpCli: false,
        liveDiscoveryRequests: catalogs - catalogsBeforeColdStart,
      },
      realTools: ["write_file", "web_search"],
      realToolResults: "success",
      recovery: {
        preOutputFailure: "HTTP 503 ServiceUnavailableException",
        postToolFailure: "partial assistant event followed by incomplete-body TLS disconnect",
        originalRequestOccursOnceEveryAttempt: true,
        completedWriteCallAndResultOccurOnceInHistory: true,
        completedWriteNotReexecuted: "post-write sentinel survived recovery and final completion",
        provisionalTextDiscardedOnRestart: provisionalTextDiscarded,
        noDuplicatePublishedText: true,
      },
      fileSHA256: createHash("sha256").update(guardedFileText).digest("hex"),
      finalResponseInPaseoTranscript: "KIRO_PORTABLE_CHAIN_OK",
      noDisallowedProviderRuntimeInBundleOrObservedChildren: true,
    };
    report.webSearch = {
      surface: "native Kiro web_search called by controlled model",
      backend: "authenticated Kiro POST /mcp tools/call web_search through strict TLS proxy",
      requests: searchRequests,
      citationUrl: searchResult.results[0].url,
      maxVerbatimWordLimit: searchResult.results[0].maxVerbatimWordLimit,
      citationAndLimitReceivedByNextModelRequest: searchResultSeen,
      returnedSourcesFetched: 0,
      externalProviderRequests: violations.length,
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
    const sdkQuota = JSON.parse(
      await checked(
        cmd("paseo", ["--data-dir", data, "--", "usage", "--refresh", "--json"]),
        "Paseo installed Kiro usage source",
      ),
    );
    const accountQuota = sdkQuota.find((entry) =>
      entry.report?.balances?.some((balance) => balance.id === "credits-base"),
    );
    assert.equal(
      accountQuota?.report.status,
      "available",
      "Paseo did not expose this managed Kiro account quota",
    );
    const sdkBalance = accountQuota.report.balances.find(
      (balance) => balance.id === "credits-base",
    );
    assert.equal(sdkBalance.used, 12.375);
    assert.equal(sdkBalance.remaining, 88.125);
    report.quota = {
      direct: "available",
      paseoSdk: "available",
      unit: "credits",
      used: sdkBalance.used,
      remaining: sdkBalance.remaining,
      requests: quotaRequests,
    };

    report.phase = "approved browser bundled web UI";
    uiOrigin = `http://127.0.0.1:${port}`;
    report.webUiDiagnostics = {
      stage: "launch",
      uncaughtExceptionTypes: [],
      assetStatuses: { Document: [], Script: [], Stylesheet: [] },
      failedRequests: 0,
    };
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
    // Browser-vendor background traffic is not application-provider traffic.
    // Deny it on a separate loopback sink; keep the application proxy strict.
    report.browserNetwork = {
      scope: "Browser-only denial proxy; foreground page HTTP and WebSocket requests are checked separately by CDP",
      rejectedHttpRequests: 0,
      rejectedConnectRequests: 0,
      upstreamSockets: 0,
    };
    const browserProxy = http.createServer((_request, response) => {
      report.browserNetwork.rejectedHttpRequests++;
      response.writeHead(403).end();
    });
    browserProxy.on("connect", (_request, socket) => {
      report.browserNetwork.rejectedConnectRequests++;
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    browserProxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    servers.push(browserProxy);
    const browserProxyPort = await listen(browserProxy);
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
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
        `--proxy-server=http://127.0.0.1:${browserProxyPort}`,
        "--proxy-bypass-list=127.0.0.1;localhost",
        `--remote-debugging-port=${browserPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${path.join(scratch, "browser profile")}`,
        "--window-size=1280,900",
        "about:blank",
      ],
      {
        timeout: 0,
        // The imported-CLI fixture's synthetic home is not a Windows user profile.
        // Keep the browser's real OS profile variables; its browsing state still
        // lives only in the explicitly owned --user-data-dir above.
        environment: Object.fromEntries([
          ...Object.entries(env).filter(([key]) => !/^(HOME|USERPROFILE)$/i.test(key)),
          ...Object.entries(process.env).filter(([key]) => /^(HOME|USERPROFILE)$/i.test(key)),
        ]),
      },
    );
    let pageTarget;
    report.webUiDiagnostics.stage = "browser startup";
    await waitFor(async () => {
      if (browser.child.exitCode !== null) {
        recordCommandFailure("Approved browser exited before CDP readiness", {
          code: browser.child.exitCode, ...browser.output(),
        });
        throw new Error("Approved browser exited before CDP readiness");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${browserPort}/json/list`, {
          signal: AbortSignal.timeout(1500),
        });
        report.webUiDiagnostics.debugEndpointStatus = response.status;
        const targets = await response.json();
        report.webUiDiagnostics.debugEndpointIsTargetList = Array.isArray(targets);
        pageTarget = targets.find((target) => target.type === "page");
        return Boolean(pageTarget?.webSocketDebuggerUrl);
      } catch {
        return false;
      }
    }, "Headless browser startup");
    report.webUiDiagnostics.stage = "CDP connection";
    browserCdp = await cdp(pageTarget.webSocketDebuggerUrl);
    const uiViolations = [];
    browserCdp.on("Runtime.exceptionThrown", (event) => {
      const name = event.exceptionDetails?.exception?.className;
      const safe = ["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError"].includes(name)
        ? name : "other";
      if (!report.webUiDiagnostics.uncaughtExceptionTypes.includes(safe))
        report.webUiDiagnostics.uncaughtExceptionTypes.push(safe);
    });
    browserCdp.on("Network.responseReceived", (event) => {
      const statuses = report.webUiDiagnostics.assetStatuses[event.type];
      const status = event.response?.status;
      if (statuses && Number.isInteger(status) && status >= 100 && status < 600 &&
        !statuses.includes(status)) statuses.push(status);
    });
    browserCdp.on("Network.loadingFailed", (event) => {
      report.webUiDiagnostics.failedRequests++;
      const known = [
        "net::ERR_NAME_NOT_RESOLVED", "net::ERR_CONNECTION_REFUSED",
        "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_PROXY_CONNECTION_FAILED",
        "net::ERR_TUNNEL_CONNECTION_FAILED", "net::ERR_CONNECTION_CLOSED",
        "net::ERR_CONNECTION_RESET", "net::ERR_ABORTED",
      ];
      const kind = known.includes(event.errorText) ? event.errorText : "other";
      const kinds = report.webUiDiagnostics.networkFailureKinds ??= [];
      if (!kinds.includes(kind)) kinds.push(kind);
    });
    browserCdp.on("Network.webSocketCreated", (event) => {
      const url = new URL(event.url);
      if (url.protocol !== "ws:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") ||
        url.port !== String(port))
        uiViolations.push("non-loopback page WebSocket denied");
    });
    browserCdp.on("Fetch.requestPaused", (event) => {
      const url = new URL(event.request.url);
      const allowed =
        ["data:", "blob:", "about:"].includes(url.protocol) ||
        (["http:", "ws:"].includes(url.protocol) &&
          (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
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
    await browserCdp.send("Network.enable");
    await browserCdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    report.webUiDiagnostics.stage = "navigation";
    const navigation = await browserCdp.send("Page.navigate", { url: `${uiOrigin}/` });
    assert.equal(Boolean(navigation.errorText), false, "Loopback browser navigation failed");
    let dom;
    report.webUiDiagnostics.stage = "render";
    await waitFor(
      async () => {
        const result = await browserCdp.send("Runtime.evaluate", {
          expression:
            `JSON.stringify({title:document.title,sameOrigin:location.origin===${JSON.stringify(uiOrigin)},passwordInputs:document.querySelectorAll("input[type=password]").length,controls:document.querySelectorAll("input,button,[role=button]").length})`,
          returnByValue: true,
        });
        try {
          dom = JSON.parse(result.result.value);
        } catch {
          return false;
        }
        return dom.sameOrigin && dom.controls > 0 &&
          report.webUiDiagnostics.assetStatuses.Document.includes(200) &&
          report.webUiDiagnostics.assetStatuses.Script.includes(200);
      },
      "Bundled web UI render",
      60000,
    );
    assert.deepEqual(report.webUiDiagnostics.uncaughtExceptionTypes, [], "Bundled UI raised an uncaught exception");
    report.webUiDiagnostics.stage = "real browser queue delivery";
    const queueModule = manifest.paseoFork.webUi.composerQueue;
    const queueEvaluation = await browserCdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const send = globalThis.__r(${JSON.stringify(queueModule.moduleId)})[${JSON.stringify(queueModule.exportName)}];
        if (typeof send !== "function") throw new Error("Missing production queue export");
        const cases = [];
        for (const [name, properties] of [
          ["ambiguous-disconnect", {code:"DAEMON_CONNECTION_LOST",outcome:"unknown"}],
          ["request-timeout", {code:"DAEMON_REQUEST_TIMEOUT"}],
          ["known-not-submitted", {code:"DAEMON_CONNECTION_LOST"}],
        ]) {
          let queue = new Map([["fixture-agent", [{id:"queued",text:"fixture",attachments:[]}]]]);
          let sends = 0;
          const input = {
            agentId:"fixture-agent",messageId:"queued",
            queue:{read:id=>queue.get(id)??[],write:update=>{queue=update(queue)}},
            submitMessage:async()=>{sends++;throw Object.assign(new Error("controlled delivery failure"),properties)},
          };
          const result = await send(input);
          const queuedCopies = queue.get("fixture-agent").length;
          const next = queuedCopies === 0 ? await send(input) : null;
          cases.push({name,status:result.status,
            queuedCopies,nextStatus:next?.status??null,sends});
        }
        return cases;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    report.browserQueue = {
      scope: "Actual rendered production Metro module export; controlled submission failures, not copied source or a replacement implementation",
      assetSha256: queueModule.assetSha256,
      moduleId: queueModule.moduleId,
      cases: queueEvaluation.result?.value,
      exceptionType: queueEvaluation.exceptionDetails?.exception?.className ?? null,
    };
    assert.equal(Boolean(queueEvaluation.exceptionDetails), false, "Compiled browser queue module could not be exercised");
    assert.deepEqual(report.browserQueue.cases, [
      { name: "ambiguous-disconnect", status: "failed", queuedCopies: 0, nextStatus: "missing", sends: 1 },
      { name: "request-timeout", status: "failed", queuedCopies: 0, nextStatus: "missing", sends: 1 },
      { name: "known-not-submitted", status: "failed", queuedCopies: 1, nextStatus: null, sends: 1 },
    ]);
    report.webUiDiagnostics.stage = "screenshot";
    await delay(1000);
    // Do not inject the password into the browser or publish arbitrary DOM text.
    // This is explicitly UI-shell/login rendering, not authenticated UI retrieval.
    const screenshot = await browserCdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const png = Buffer.from(screenshot.data, "base64");
    assert.ok(
      png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
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
    report.webUiDiagnostics.stage = "browser shutdown";
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
    report.applicationProxyViolations = { count: violations.length, categories: [...new Set(violations)] };
    assert.equal(violations.length, 0, "Application stack attempted a non-Kiro upstream request");
    if (fixtureFailure) throw fixtureFailure;
    assert.equal(generations, expectedGenerations, "A qualification surface generated unsolicited output");
    assert.equal(searchRequests, 1, "A qualification surface repeated the completed Kiro search");
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
    await recordOwnedNativeLogFailures();
    if (report.phase === "approved browser bundled web UI") {
      const messages = new Set([
        "Headless browser startup exceeded its deadline",
        "Bundled web UI render exceeded its deadline",
        "Browser CDP connection deadline exceeded", "Browser CDP connection failed",
        "Browser CDP command failed", "Browser CDP deadline exceeded", "Browser CDP closed",
      ]);
      report.webUiDiagnostics.failure = messages.has(error?.message)
        ? error.message : "other recorded failure";
      if (browser) {
        const output = browser.output();
        const text = `${output.stdout}\n${output.stderr}`;
        report.webUiDiagnostics.browserProcessExitCode = browser.child.exitCode;
        report.webUiDiagnostics.devToolsAnnouncement = /DevTools listening on ws:/i.test(text);
        report.webUiDiagnostics.browserOutputClassifications = classifyPrivateOutput(text);
        report.webUiDiagnostics.browserProfileFailure =
          /(?:user data|profile|data directory).{0,80}(?:failed|error|cannot|denied)|(?:failed|cannot).{0,80}(?:profile|data directory)/i.test(text);
        report.webUiDiagnostics.browserSandboxFailure = /sandbox.{0,80}(?:failed|error|denied)/i.test(text);
      }
      if (browserCdp) {
        try {
          const snapshot = await browserCdp.send("Runtime.evaluate", {
            expression: `JSON.stringify({sameOrigin:location.origin===${JSON.stringify(uiOrigin)},titleContainsPaseo:/paseo/i.test(document.title),bodyCharacters:(document.body?.innerText||"").length,passwordInputs:document.querySelectorAll("input[type=password]").length,controls:document.querySelectorAll("input,button,[role=button]").length})`,
            returnByValue: true,
          });
          report.webUiDiagnostics.lastSurface = JSON.parse(snapshot.result.value);
          if (report.webUiDiagnostics.lastSurface.sameOrigin) {
            const screenshot = await browserCdp.send("Page.captureScreenshot", {
              format: "png", captureBeyondViewport: false,
            });
            await writeFile(path.join(evidence, "web-ui.png"), Buffer.from(screenshot.data, "base64"));
            report.webUiDiagnostics.failureScreenshot = "web-ui.png";
          }
        } catch {
          report.webUiDiagnostics.surfaceUnavailable = true;
        }
      }
    }
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
    for (const target of [browserOwned, knownOwned]) {
      try {
        const entries = [...target.values()]
          .map((row) => `@{id=${row.pid};created='${row.created}'}`)
          .join(",");
        if (entries)
          await ps(
            `foreach($r in @(${entries})) {$p=Get-Process -Id $r.id -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $r.created) {Stop-Process -Id $r.id -Force -ErrorAction SilentlyContinue}}; 'owned cleanup checked'`,
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
          !(await liveOwned(browserOwned)).length,
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
    report.finishedAt = new Date().toISOString();
    const reportFile = path.join(evidence, "report.json");
    const reportTemporary = `${reportFile}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(reportTemporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await rename(reportTemporary, reportFile);
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
