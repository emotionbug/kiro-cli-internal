#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { helperEnvironment, startProxy, validateNetwork } from "./proxy.mjs";
import {
  appExecutable,
  bundleRoot,
  command,
  configureDaemon,
  daemonExecutable,
  initialize,
  json,
  ompMachineRoot,
  ompExecutable,
  ompNetworkPolicy,
  pluginExtension,
  pluginPin,
  pluginRoot,
  runtimeEnv,
  save,
} from "./state.mjs";

const node = path.join(bundleRoot, "runtime/node/node.exe");
const usage = `Kiro Internal: offline-installed Passession -> OMP -> Kiro HTTP

start.cmd                 Start the isolated loopback Passession daemon and its desktop app
app.cmd                   Open the Passession desktop app for this running private daemon
setup.cmd                 Set private state, extension consent and daemon password
auth.cmd login [options]  Managed Google/GitHub/Builder ID/Identity Center login
auth.cmd profile [--profile ARN]  Resolve or select the Kiro profile of this login
auth.cmd status|logout    Local status/logout, no network required
models.cmd                Refresh account model metadata and this daemon's catalog
usage.cmd                 Read account quota (not a model generation)
network.cmd               Show network mode (addresses/secrets are not printed)
network.cmd --mode direct|system|manual [--proxy URL|--pac PATH_OR_URL] [--ca FILE]
doctor.cmd [--verify-all]  Verify runtime integrity and private configuration offline
stop.cmd                  Stop only this data directory's Passession daemon
paseo.cmd ...             Bundled Passession CLI, always bound to this private home
omp.cmd ...               Bundled OMP with only the pinned Kiro extension and private config

Common options before --: --data-dir ABSOLUTE_PATH, --accept-plugin-code
start/setup: --password-stdin, --port NUMBER; start: --no-app
No runtime downloads. Cloud login/catalog/generation still require allowed HTTPS.
`;

export function argumentsFor(argv) {
  const [action = "start", ...input] = argv;
  const flags = {},
    rest = [];
  let passthrough = false;
  for (let index = 0; index < input.length; index++) {
    const value = input[index];
    if (!passthrough && value === "--") {
      passthrough = true;
      continue;
    }
    if (!passthrough && ["--data-dir", "--port"].includes(value)) {
      if (!input[index + 1] || input[index + 1].startsWith("--"))
        throw new Error(`Missing ${value} value.`);
      flags[value.slice(2)] = input[++index];
    } else if (
      !passthrough &&
      ["--accept-plugin-code", "--password-stdin", "--no-app", "--verify-all"].includes(value)
    )
      flags[value.slice(2)] = true;
    else rest.push(value);
  }
  if (flags["data-dir"] && !path.isAbsolute(flags["data-dir"]))
    throw new Error("--data-dir must be absolute.");
  if (
    flags.port &&
    (!/^\d+$/.test(flags.port) ||
      Number(flags.port) < 1024 ||
      Number(flags.port) > 65535 ||
      Number(flags.port) === 6767)
  )
    throw new Error("--port must be 1024..65535, excluding the main Paseo port 6767.");
  return { action, flags, rest };
}
async function trust(state, flags) {
  const file = path.join(state.root, "trust.json");
  if ((await json(file))?.pluginCommit === pluginPin) return;
  let accepted = flags["accept-plugin-code"];
  if (!accepted && process.stdin.isTTY) {
    const { confirm, isCancel } = await import("@clack/prompts");
    const answer = await confirm({
      message:
        "Trust the bundled omp-kiro OMP extension? It runs unsandboxed inside OMP and can access this user account, files and network. Only the pinned bundled version is loaded.",
      initialValue: false,
    });
    accepted = !isCancel(answer) && answer;
  }
  if (!accepted)
    throw new Error(
      "Extension code was not enabled. Review the bundled source, then use --accept-plugin-code or accept the interactive prompt.",
    );
  await save(file, { pluginCommit: pluginPin, acceptedAt: new Date().toISOString() });
}
// Passession stores a cost-12 bcrypt hash (daemon.auth.password). Bun, which
// the compiled OMP binary embeds, provides the same bcrypt; Passession's own
// set-password requires a terminal and cannot read --password-stdin.
const BCRYPT_SCRIPT =
  'const p=await Bun.stdin.text();process.stdout.write(await Bun.password.hash(p,{algorithm:"bcrypt",cost:12}))';
export function validatePassword(value) {
  if (typeof value !== "string" || !value.length)
    throw new Error("A nonempty daemon password is required.");
  if (/[\r\n\0]/.test(value)) throw new Error("The daemon password cannot contain line breaks.");
  // bcrypt only uses 72 bytes; longer values would not mean what was typed.
  if (Buffer.byteLength(value, "utf8") > 72)
    throw new Error("The daemon password must be at most 72 UTF-8 bytes.");
  return value;
}
async function hashPassword(value) {
  const hash = (
    await command(ompExecutable, ["-e", BCRYPT_SCRIPT], {
      env: { ...helperEnvironment(process.env), BUN_BE_BUN: "1" },
      input: validatePassword(value),
    })
  ).trim();
  if (!/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(hash))
    throw new Error("Password hashing returned an unexpected format; no password saved.");
  return hash;
}
async function password(state, flags) {
  if ((await json(path.join(state.home, "config.json")))?.daemon?.auth?.password) return undefined;
  let value;
  if (flags["password-stdin"]) {
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      value = (await reader[Symbol.asyncIterator]().next()).value;
    } finally {
      reader.close();
    }
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        "First start needs a daemon password. Run setup.cmd interactively or pass --password-stdin (one line; never an argument).",
      );
    const { password: prompt, isCancel } = await import("@clack/prompts");
    value = await prompt({
      message: "Create this private Passession daemon password",
      validate: (input) => {
        try {
          validatePassword(input);
        } catch (error) {
          return error.message;
        }
      },
    });
    if (isCancel(value)) throw new Error("Password setup cancelled.");
    const repeated = await prompt({ message: "Repeat daemon password" });
    if (isCancel(repeated) || repeated !== value)
      throw new Error("Passwords do not match; no password saved.");
  }
  return hashPassword(value);
}
async function child(executable, args, env, { relaySignals = false } = {}) {
  const processChild = spawn(executable, args, { env, stdio: "inherit", windowsHide: false });
  const ignore = () => {};
  const stop = () => processChild.kill("SIGTERM");
  // Ctrl+C is delivered to console children by Windows. On POSIX terminals it
  // reaches the process group. Never destroy the proxy on a turn cancellation.
  process.on("SIGINT", ignore);
  if (relaySignals) process.on("SIGTERM", stop);
  try {
    return await new Promise((resolve, reject) => {
      processChild.once("error", reject);
      processChild.once("close", (code, signal) =>
        resolve(code ?? (signal === "SIGINT" ? 130 : 1)),
      );
    });
  } finally {
    process.removeListener("SIGINT", ignore);
    if (relaySignals) process.removeListener("SIGTERM", stop);
  }
}
async function transport(state, callback) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Startup cancelled", "AbortError"));
  process.once("SIGINT", abort);
  let proxy;
  try {
    proxy = await startProxy({
      bundleRoot,
      dataDir: state.root,
      config: state.config,
      env: runtimeEnv(state),
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", abort);
  }
  const env = {
    ...proxy.env,
    NODE_OPTIONS:
      `${proxy.env.NODE_OPTIONS ?? ""} --max-old-space-size=${state.config.nodeHeapMb}`.trim(),
  };
  try {
    return await callback(env, proxy);
  } finally {
    await proxy.close();
  }
}
// Native processes (Passession, compiled Bun OMP, desktop app) never receive the
// Node-only bootstrap; proxy, CA and NO_PROXY variables remain.
export function nativeEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_USE_ENV_PROXY)$/i.test(key)),
  );
}
const ownerFile = (state) => path.join(state.root, "passession-owner.json");
const appOwnerFile = (state) => path.join(state.root, "gui-owner.json");
export async function daemonStatus(state) {
  return JSON.parse(
    await command(daemonExecutable, ["daemon", "status", "--home", state.home, "--json"], {
      env: runtimeEnv(state),
    }),
  );
}
// `--force` only terminates the process tree recorded in this home's lock.
async function stop(state, { force = false } = {}) {
  return child(
    daemonExecutable,
    ["daemon", "stop", "--home", state.home, "--json", ...(force ? ["--force"] : [])],
    runtimeEnv(state),
    { relaySignals: true },
  );
}
export function privatePaseoArgs(args, home) {
  if (args.some((value) => /^--(?:home|host|daemon)(?:=|$)/.test(value)))
    throw new Error(
      "paseo.cmd is bound to this private home. Use --data-dir, not --home, --host or --daemon.",
    );
  const commands = [];
  for (let index = 0; index < args.length && commands.length < 2; index++) {
    const value = args[index];
    if (value === "--") break;
    if (
      [
        "--format",
        "-o",
        "--provider",
        "--model",
        "--thinking",
        "--mode",
        "--cwd",
        "--title",
        "--name",
        "--workspace",
        "--new-workspace",
        "--worktree",
        "--worktree-mode",
        "--worktree-slug",
        "--new-branch",
        "--base",
        "--branch",
        "--pr-number",
        "--forge",
        "--wait-timeout",
        "--output-schema",
        "--image",
        "--env",
        "--label",
        "--agent",
        "--timeout",
        "--kill-timeout",
      ].includes(value)
    ) {
      index++;
      continue;
    }
    if (!value.startsWith("-")) commands.push(value);
  }
  if (
    ["start", "restart", "onboard"].includes(commands[0]) ||
    (commands[0] === "daemon" && ["start", "run", "restart", "update"].includes(commands[1]))
  ) {
    throw new Error(
      "Use start.cmd for the owned proxy-backed launcher; use stop.cmd then start.cmd to restart. paseo.cmd cannot create or replace this runtime lifecycle.",
    );
  }
  return ["--home", home, ...args];
}
export function hasLiveOwner(owner, instance) {
  if (
    !Number.isInteger(owner?.pid) ||
    owner.pid <= 1 ||
    owner.daemonPid !== instance.pid ||
    typeof owner.daemonStartedAt !== "string" ||
    owner.daemonStartedAt !== instance.startedAt
  )
    return false;
  return alive(owner.pid);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function authOperation(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      flow: { type: "string" },
      "start-url": { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      timeout: { type: "string" },
      database: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals.length) return "help";
  const operation = positionals.join(" ");
  if (
    !["login", "auth status", "auth logout", "auth import-cli", "auth profile"].includes(operation)
  )
    throw new Error("Unknown authentication command; use auth.cmd --help.");
  return operation;
}
async function reload(state, env) {
  if ((await daemonStatus(state)).localDaemon !== "stopped") {
    const code = await child(
      daemonExecutable,
      ["daemon", "reload", "--home", state.home, "--json"],
      nativeEnv(env),
    );
    if (code)
      throw new Error(
        "Configuration saved, but this daemon reload failed. Use stop.cmd then start.cmd; no other Passession/Paseo instance was changed.",
      );
  }
}
async function refreshModels(state, env) {
  const code = await child(
    node,
    [path.join(bundleRoot, "app/lib/action-worker.mjs"), "models"],
    env,
    { relaySignals: true },
  );
  if (await json(path.join(state.home, "config.json"))) {
    await configureDaemon(state);
    await reload(state, env);
  }
  return code;
}
async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `127.0.0.1:${port} is already in use. No unrelated process was stopped. Choose --port or stop the owning application.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
// One launcher owns one data directory. The file is created exclusively; a
// record of a dead launcher is stale and removed, never a live one.
async function acquireOwner(state) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(ownerFile(state), "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await json(ownerFile(state)).catch(() => null);
      if (Number.isInteger(owner?.pid) && owner.pid > 1 && alive(owner.pid))
        throw new Error(
          `Another launcher (PID ${owner.pid}) owns this data directory. Use its window, or stop.cmd then start.cmd.`,
        );
      await rm(ownerFile(state), { force: true });
    }
  }
  throw new Error("Cannot acquire this data directory's launcher ownership; retry start.cmd.");
}
export function listenMatches(listen, port) {
  return typeof listen === "string" && listen.replace(/^tcp:\/\//, "") === `127.0.0.1:${port}`;
}
async function waitReady(state, port, exited) {
  const deadline = Date.now() + 600000;
  let finished = false;
  exited.then(() => (finished = true));
  while (!finished) {
    const status = await daemonStatus(state).catch(() => null);
    if (
      status?.localDaemon === "running" &&
      listenMatches(status.listen, port) &&
      Number.isInteger(status.pid) &&
      typeof status.startedAt === "string" &&
      status.connectedDaemon === "reachable"
    )
      return status;
    if (status?.listen && !listenMatches(status.listen, port))
      throw new Error(`The private daemon reported an unexpected endpoint ${status.listen}.`);
    if (["auth_required", "auth_failed"].includes(status?.connectedDaemon))
      throw new Error(
        "The private daemon rejected this home's local credential; it was stopped. Run start.cmd again.",
      );
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the private Passession daemon to become reachable.");
    await Promise.race([delay(250), exited]);
  }
  return null;
}
async function start(state, flags) {
  const existing = await daemonStatus(state);
  if (existing.localDaemon !== "stopped") {
    const owner = await json(ownerFile(state));
    if (!hasLiveOwner(owner, existing))
      throw new Error(
        "This private daemon outlived its launcher/proxy or is still starting. Run stop.cmd, then start.cmd. Other Passession/Paseo instances are not affected.",
      );
    console.log(`Private Passession is already running: ${existing.listen}`);
    if (!flags["no-app"]) await launchApp(state);
    return 0;
  }
  await trust(state, flags);
  const passwordHash = await password(state, flags);
  const port = Number(flags.port ?? state.config.port);
  await freePort(port);
  if (port !== state.config.port) {
    state.config.port = port;
    await save(state.configFile, state.config);
  }
  await configureDaemon(state, { passwordHash, port });
  await acquireOwner(state);
  try {
    return await transport(state, async (env, proxy) => {
      console.log(proxy.diagnostic);
      // Foreground `daemon run` keeps the proxy environment and ties the
      // supervisor to this launcher; the proxy closes only after it exits.
      const daemon = spawn(daemonExecutable, ["daemon", "run", "--home", state.home], {
        env: nativeEnv(env),
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: false,
      });
      const exited = new Promise((resolve) => {
        daemon.once("error", (error) => resolve({ error }));
        daemon.once("close", (code, signal) => resolve({ code, signal }));
      });
      // Windows delivers console Ctrl+C to the daemon CLI, which stops its own
      // supervisor. SIGTERM requests the authenticated orderly shutdown.
      const ignore = () => {};
      let stopping;
      const terminate = () => {
        stopping ??= stop(state).catch((error) =>
          console.error(`Private daemon shutdown was not confirmed: ${error.message}`),
        );
      };
      process.on("SIGINT", ignore);
      process.on("SIGTERM", terminate);
      try {
        let ready;
        try {
          ready = await waitReady(state, port, exited);
        } catch (error) {
          // Readiness failed; this home's verified lock PID is ours to end.
          stopping ??= stop(state, { force: true }).catch((stopError) =>
            console.error(`Private daemon shutdown was not confirmed: ${stopError.message}`),
          );
          await stopping;
          // Last resort ends only our own `daemon run` child; its Windows job
          // object (KILL_ON_JOB_CLOSE) takes the supervisor with it.
          const timer = setTimeout(() => daemon.kill(), 15000);
          await exited;
          clearTimeout(timer);
          throw error;
        }
        if (ready) {
          await save(ownerFile(state), {
            pid: process.pid,
            daemonPid: ready.pid,
            daemonStartedAt: ready.startedAt,
          });
          console.log(
            `Passession -> OMP -> Kiro HTTP ready: ${ready.listen}\nKeep this window open. stop.cmd stops only this private daemon.\nUse auth.cmd login then models.cmd if the account model list is empty.`,
          );
          if (!flags["no-app"])
            await launchApp(state).catch((error) =>
              console.error(
                `Desktop app launch failed: ${error.message}\nThe daemon keeps running; run app.cmd after resolving this.`,
              ),
            );
        }
        const result = await exited;
        await stopping;
        if (result.error) throw result.error;
        return result.code ?? (result.signal === "SIGINT" ? 130 : 1);
      } finally {
        process.removeListener("SIGINT", ignore);
        process.removeListener("SIGTERM", terminate);
      }
    });
  } finally {
    const owner = await json(ownerFile(state)).catch(() => null);
    if (owner?.pid === process.pid) await rm(ownerFile(state), { force: true });
  }
}
export function tasklistPids(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^"[^"]*","(\d+)"/)?.[1])
    .filter(Boolean)
    .map(Number);
}
async function runningAppPids() {
  if (process.platform !== "win32") return [];
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  return tasklistPids(
    await command(path.join(system, "tasklist.exe"), [
      "/FI",
      `IMAGENAME eq ${path.basename(appExecutable)}`,
      "/FO",
      "CSV",
      "/NH",
    ]),
  );
}
// The desktop app may only observe this daemon, never start or replace one.
export function desktopSettings(document) {
  const value = document && typeof document === "object" && !Array.isArray(document) ? document : {};
  const settings = value.settings && typeof value.settings === "object" ? value.settings : {};
  return {
    ...value,
    version: 1,
    settings: {
      ...settings,
      daemon: {
        keepRunningAfterQuit: true,
        ...settings.daemon,
        manageBuiltInDaemon: false,
      },
    },
  };
}
async function launchApp(state) {
  await access(appExecutable);
  const status = await daemonStatus(state);
  if (status.localDaemon !== "running" || !hasLiveOwner(await json(ownerFile(state)), status))
    throw new Error(
      "This data directory's private daemon is not running under its launcher. Run start.cmd first; the desktop app connects only to that daemon.",
    );
  const settingsFile = path.join(state.guiDir, "desktop-settings.json");
  await save(settingsFile, desktopSettings(await json(settingsFile)));
  const owned = (await json(appOwnerFile(state)))?.pid;
  const running = await runningAppPids();
  const foreign = running.filter((pid) => pid !== owned);
  // The desktop app's single-instance lock is per Windows session: a second
  // launch would be forwarded to that other window and its daemon.
  if (foreign.length)
    throw new Error(
      `Another Paseo Sessions desktop app is open (PID ${foreign.join(", ")}). Close it, then run app.cmd. No process was stopped.`,
    );
  const app = spawn(appExecutable, [], {
    cwd: path.dirname(appExecutable),
    env: { ...nativeEnv(runtimeEnv(state)), PASEO_GUI_STATE_DIR: state.guiDir },
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    app.once("spawn", resolve);
    app.once("error", reject);
  });
  app.unref();
  if (!running.length) await save(appOwnerFile(state), { pid: app.pid });
  console.log(
    running.length
      ? "Activated the open private desktop app."
      : "Opened the Passession desktop app for this private daemon.",
  );
  return 0;
}
async function doctor(state, flags) {
  const manifest = await json(path.join(bundleRoot, "bundle-manifest.json"));
  if (!manifest)
    throw new Error(
      "bundle-manifest.json is missing; use the complete release ZIP, not a source checkout.",
    );
  const native = manifest.native ?? {};
  const relative = (file) => path.relative(bundleRoot, file).split(path.sep).join("/");
  for (const [entry, file] of [
    [native.passessionDaemon?.executable, daemonExecutable],
    [native.passessionApp?.executable, appExecutable],
    [native.omp?.executable, ompExecutable],
    [native.omp?.networkPolicy, ompNetworkPolicy],
    [native.plugin?.extension, pluginExtension],
  ])
    if (entry !== relative(file)) throw new Error(`Bundle layout mismatch: ${relative(file)}`);
  if (native.plugin.commit !== pluginPin)
    throw new Error("Bundled extension commit does not match this runtime's trust pin.");
  const critical = new Set([
    "runtime/node/node.exe",
    "runtime/proxy/kiro-proxy.exe",
    native.passessionDaemon.executable,
    native.passessionApp.executable,
    native.omp.executable,
    native.plugin.extension,
    "app/lib/run.mjs",
    "app/lib/proxy.mjs",
    "app/lib/state.mjs",
  ]);
  let checked = 0;
  for (const entry of manifest.files) {
    if (!flags["verify-all"] && !critical.has(entry.path)) continue;
    const file = path.resolve(bundleRoot, entry.path);
    if (!file.startsWith(`${path.resolve(bundleRoot)}${path.sep}`))
      throw new Error("Unsafe manifest path.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== entry.sha256) throw new Error(`Integrity mismatch: ${entry.path}`);
    checked++;
  }
  if (checked < critical.size && !flags["verify-all"])
    throw new Error("bundle-manifest.json does not list every critical runtime file.");
  validateNetwork(state.config.network);
  const status = await daemonStatus(state);
  const legacy = await lstat(path.join(state.root, "paseo")).catch(() => null);
  console.log(
    JSON.stringify(
      {
        integrity: "verified",
        filesChecked: checked,
        node: process.version,
        passession: {
          version: native.passessionDaemon.version,
          commit: native.passessionDaemon.commit,
        },
        desktopApp: { version: native.passessionApp.version, path: native.passessionApp.executable },
        omp: native.omp.version,
        plugin: { version: native.plugin.version, commit: native.plugin.commit },
        pluginTrusted: (await json(path.join(state.root, "trust.json")))?.pluginCommit === pluginPin,
        proxy: "native-winhttp-sspi",
        networkMode: state.config.network.mode,
        nodeHeapMb: state.config.nodeHeapMb,
        endpoint: `127.0.0.1:${state.config.port}`,
        loopbackOnly: true,
        daemon: status.localDaemon,
        server2019Verified: manifest.compatibility?.server2019Verified,
        legacyNodePaseoDataIgnored: Boolean(legacy),
        // OMP logs/caches/stats/run state; private, outside data dir on another drive.
        ompMachineRoot: ompMachineRoot(state),
        userData: state.root,
      },
      null,
      2,
    ),
  );
  return child(node, [path.join(pluginRoot, "auth-cli.mjs"), "auth", "status"], runtimeEnv(state), {
    relaySignals: true,
  });
}
async function network(state, rest) {
  if (!rest.length) {
    console.log(
      JSON.stringify(
        {
          mode: state.config.network.mode,
          customProxy: Boolean(state.config.network.proxy),
          customPac: Boolean(state.config.network.pacUrl),
          customCa: Boolean(state.config.network.caFile),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if ((await daemonStatus(state)).localDaemon !== "stopped")
    throw new Error("Stop this private daemon before changing network configuration.");
  const next = {};
  const names = { "--mode": "mode", "--proxy": "proxy", "--pac": "pacUrl", "--ca": "caFile" };
  for (let index = 0; index < rest.length; index += 2) {
    if (!names[rest[index]] || !rest[index + 1])
      throw new Error(
        "network options: --mode system|direct|manual [--proxy URL|--pac PATH_OR_URL] [--ca PEM_FILE]",
      );
    next[names[rest[index]]] = rest[index + 1];
  }
  validateNetwork(next);
  if (next.caFile) {
    if (!path.isAbsolute(next.caFile)) throw new Error("--ca must be absolute.");
    await access(next.caFile);
  }
  state.config.network = next;
  await save(state.configFile, state.config);
  console.log(
    "Network configuration saved locally; no machine-wide proxy or certificate setting was changed.",
  );
  return 0;
}
// OMP must load exactly the trusted bundled extension with private config.
export function privateOmpArgs(args) {
  const end = args.indexOf("--");
  if (
    (end === -1 ? args : args.slice(0, end)).some((value) =>
      /^(?:--extension|-e|--hook|--trusted-extension|--plugin-dir)(?:=|$)/.test(value),
    )
  )
    throw new Error(
      "omp.cmd loads only the pinned Kiro extension; --extension, -e, --hook, --trusted-extension and --plugin-dir are not accepted.",
    );
  return ["--trusted-extension", pluginExtension, "--config", ompNetworkPolicy, ...args];
}
export async function main(argv = process.argv.slice(2)) {
  const { action, flags, rest } = argumentsFor(argv);
  if (action === "help" || (!["auth", "paseo", "omp"].includes(action) && rest.includes("--help"))) {
    console.log(usage);
    return 0;
  }
  if (
    ![
      "start",
      "app",
      "setup",
      "auth",
      "models",
      "usage",
      "stop",
      "doctor",
      "network",
      "paseo",
      "omp",
    ].includes(action)
  )
    throw new Error("Unknown command. Use help.");
  const state = await initialize(flags["data-dir"]);
  if (action === "network") return network(state, rest);
  if (action === "stop") return stop(state);
  if (action === "doctor") return doctor(state, flags);
  if (action === "start") return start(state, flags);
  if (action === "app") return launchApp(state);
  if (action === "setup") {
    await trust(state, flags);
    const port = Number(flags.port ?? state.config.port);
    await configureDaemon(state, { passwordHash: await password(state, flags), port });
    if (port !== state.config.port) {
      state.config.port = port;
      await save(state.configFile, state.config);
    }
    await reload(state, runtimeEnv(state));
    const machineRoot = ompMachineRoot(state);
    const inside = path.relative(state.root, machineRoot);
    if (inside.startsWith("..") || path.isAbsolute(inside))
      console.log(`OMP machine-level logs/caches/run state for this data directory: ${machineRoot}`);
    console.log("Private setup complete. Run auth.cmd login, models.cmd, then start.cmd.");
    return 0;
  }
  if (action === "paseo")
    return child(daemonExecutable, privatePaseoArgs(rest, state.home), runtimeEnv(state), {
      relaySignals: true,
    });
  if (action === "omp") {
    const args = privateOmpArgs(rest);
    await trust(state, flags);
    if (!(await json(path.join(state.root, "models.json"))))
      throw new Error("No account model catalog. Run auth.cmd login, then models.cmd.");
    return transport(state, (env) =>
      child(ompExecutable, args, nativeEnv(env), { relaySignals: true }),
    );
  }
  if (action === "auth") {
    if (rest.some((value) => value === "--auth-file" || value.startsWith("--auth-file=")))
      throw new Error(
        "Use --data-dir to choose the private authentication store; --auth-file cannot split runtime stores.",
      );
    let args = ["status", "logout", "import-cli", "profile"].includes(rest[0])
      ? ["auth", ...rest]
      : rest;
    const operation = authOperation(args);
    if (
      operation === "auth import-cli" &&
      !args.some((value) => value === "--database" || value.startsWith("--database="))
    )
      args = [...args, "--database", path.join(homedir(), ".local/share/kiro-cli/data.sqlite3")];
    const changesAccount = ["login", "auth import-cli", "auth logout", "auth profile"];
    const perform = async (env) => {
      const code = await child(node, [path.join(pluginRoot, "auth-cli.mjs"), ...args], env, {
        relaySignals: true,
      });
      if (code || !changesAccount.includes(operation)) return code;
      // Credentials or profile changed successfully. Invalidate the previous
      // account's metadata before any refresh; a failed request cannot leave it trusted.
      try {
        await rm(path.join(state.root, "models.json"), { force: true });
        if (await json(path.join(state.home, "config.json"))) {
          await configureDaemon(state);
          await reload(state, env);
        }
        if (operation !== "auth logout") {
          const metadataCode = await (operation === "auth import-cli"
            ? transport(state, (proxyEnv) => refreshModels(state, proxyEnv))
            : refreshModels(state, env));
          if (metadataCode)
            console.error(
              "Authentication succeeded, but account model metadata is unavailable. Run models.cmd; the previous account catalog was removed.",
            );
        }
      } catch (error) {
        console.error(
          `${operation === "auth logout" ? "Logout" : "Authentication"} succeeded, but the daemon catalog update failed: ${error.message}. Run models.cmd after login, or stop.cmd then start.cmd.`,
        );
      }
      return 0;
    };
    return ["help", "auth status", "auth logout", "auth import-cli"].includes(operation)
      ? perform(runtimeEnv(state))
      : transport(state, perform);
  }
  if (action === "models" || action === "usage")
    return transport(state, (env) =>
      action === "models"
        ? refreshModels(state, env)
        : child(node, [path.join(bundleRoot, "app/lib/action-worker.mjs"), "usage"], env, {
            relaySignals: true,
          }),
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Kiro Internal: ${error.message}`);
      process.exitCode = error.name === "AbortError" ? 130 : 1;
    });
}
