#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { startProxy, validateNetwork } from "./proxy.mjs";
import {
  accountOmpArgs,
  bundleRoot,
  command,
  configurePaseo,
  ensureOmpSettings,
  initialize,
  json,
  ompArgs,
  pluginPin,
  pluginRoot,
  runtimeEnv,
  save,
} from "./state.mjs";

const node = path.join(bundleRoot, "runtime/node/node.exe");
const omp = path.join(bundleRoot, "runtime/omp/omp.exe");
const supervisor = path.join(
  bundleRoot,
  "app/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js",
);
const cli = path.join(bundleRoot, "app/node_modules/@getpaseo/cli/dist/index.js");
const usage = `Kiro Internal: offline-installed Paseo -> OMP -> Kiro HTTP

start.cmd                 Start isolated loopback Paseo and open its web UI
setup.cmd                 Set private state, plugin consent and Paseo password
omp.cmd [--console] -- ... Run OMP directly (no Paseo daemon required)
auth.cmd login [options]  Managed Google/GitHub/Builder ID/Identity Center login
auth.cmd status|logout    Local status/logout, no network required
models.cmd                Refresh account model metadata and this daemon's catalog
usage.cmd                 Read account quota (not a model generation)
network.cmd               Show network mode (addresses/secrets are not printed)
network.cmd --mode direct|system|manual [--proxy URL|--pac PATH_OR_URL] [--ca FILE]
doctor.cmd [--verify-all]  Verify runtime integrity and private configuration offline
stop.cmd                  Stop only this data directory's Paseo daemon
paseo.cmd ...             Bundled Paseo CLI, always bound to this private home

Common options before --: --data-dir ABSOLUTE_PATH, --accept-plugin-code
start/setup: --password-stdin, --port NUMBER; start: --no-browser
No runtime downloads. Cloud login/catalog/generation still require allowed HTTPS.
Memory: no Electron, no Python PAC; Node heap default 256 MiB per Node process.
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
      [
        "--accept-plugin-code",
        "--password-stdin",
        "--no-browser",
        "--console",
        "--verify-all",
      ].includes(value)
    )
      flags[value.slice(2)] = true;
    else rest.push(value);
  }
  if (flags["data-dir"] && !path.isAbsolute(flags["data-dir"]))
    throw new Error("--data-dir must be absolute.");
  if (
    flags.port &&
    (!/^\d+$/.test(flags.port) || Number(flags.port) < 1024 || Number(flags.port) > 65535)
  )
    throw new Error("--port must be 1024..65535.");
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
        "Trust the bundled omp-kiro plugin? It is unsandboxed and can access this user account, files and network. Only the pinned bundled version is enabled.",
      initialValue: false,
    });
    accepted = !isCancel(answer) && answer;
  }
  if (!accepted)
    throw new Error(
      "Plugin code was not enabled. Review the bundled source, then use --accept-plugin-code or accept the interactive prompt.",
    );
  await save(file, { pluginCommit: pluginPin, acceptedAt: new Date().toISOString() });
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
        "First start needs a Paseo password. Run setup.cmd interactively or pass --password-stdin (one line; never an argument).",
      );
    const { password: prompt, isCancel } = await import("@clack/prompts");
    value = await prompt({
      message: "Create this private Paseo daemon password",
      validate: (input) => (input.length ? undefined : "Password is required."),
    });
    if (isCancel(value)) throw new Error("Password setup cancelled.");
    const repeated = await prompt({ message: "Repeat Paseo password" });
    if (isCancel(repeated) || repeated !== value)
      throw new Error("Passwords do not match; no password saved.");
  }
  if (typeof value !== "string" || !value.length)
    throw new Error("A nonempty Paseo password is required.");
  const { hashDaemonPassword } = await import("@getpaseo/server/auth");
  return hashDaemonPassword(value);
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
const control = () => import("@getpaseo/server/daemon-control");
async function stop(state) {
  return child(node, [cli, "daemon", "stop", "--home", state.home, "--json"], runtimeEnv(state), {
    relaySignals: true,
  });
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
        "--resume",
      ].includes(value)
    ) {
      index++;
      continue;
    }
    if (!value.startsWith("-")) commands.push(value);
  }
  if (
    ["start", "restart", "onboard"].includes(commands[0]) ||
    (commands[0] === "daemon" && ["start", "run", "restart"].includes(commands[1]))
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
  try {
    process.kill(owner.pid, 0);
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
      timeout: { type: "string" },
      database: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals.length) return "help";
  const operation = positionals.join(" ");
  if (!["login", "auth status", "auth logout", "auth import-cli"].includes(operation))
    throw new Error("Unknown authentication command; use auth.cmd --help.");
  return operation;
}
async function reload(state, env) {
  if (await (await control()).readDaemonInstance(state.home)) {
    const code = await child(node, [cli, "daemon", "reload", "--home", state.home, "--json"], env);
    if (code)
      throw new Error(
        "Model metadata saved, but this daemon reload failed. Use stop.cmd then start.cmd; do not restart another Paseo instance.",
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
  if (code) return code;
  const existing = await json(path.join(state.home, "config.json"));
  if (existing) {
    await configurePaseo(state);
    await reload(state, env);
  }
  return 0;
}
async function openBrowser(url) {
  if (process.platform !== "win32") {
    console.log(`Open ${url} in an approved modern browser.`);
    return;
  }
  await command("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
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
async function start(state, flags) {
  const { readDaemonInstance, startDaemonInstance } = await control();
  const existing = await readDaemonInstance(state.home);
  if (existing) {
    const owner = await json(path.join(state.root, "runtime-owner.json"));
    if (!hasLiveOwner(owner, existing))
      throw new Error(
        "This private daemon outlived its launcher/proxy. Run stop.cmd, then start.cmd. Other Paseo instances are not affected.",
      );
    if (!existing.listen)
      throw new Error(
        "This private daemon is still starting. Wait for its launcher to report readiness.",
      );
    const url = `http://${existing.listen}`;
    console.log(`Private Paseo is already running: ${url}`);
    if (!flags["no-browser"]) await openBrowser(url);
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
  await configurePaseo(state, { passwordHash, port });
  await ensureOmpSettings(state);
  return transport(state, async (env, proxy) => {
    console.log(proxy.diagnostic);
    const controller = new AbortController();
    let acquired, shutdown;
    const interrupt = () => {
      if (shutdown) return;
      if (!acquired?.listen) {
        controller.abort(new DOMException("Shutdown requested", "AbortError"));
        return;
      }
      // On Windows SIGTERM terminates a process rather than requesting orderly
      // shutdown. Use Paseo's authenticated local lifecycle channel instead.
      shutdown = stop(state)
        .then((code) => {
          if (code)
            console.error(
              "Private daemon shutdown was not confirmed. Keep this launcher open and retry stop.cmd.",
            );
        })
        .catch((error) =>
          console.error(`Private daemon shutdown was not confirmed: ${error.message}`),
        );
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    let browserTask;
    try {
      const result = await startDaemonInstance({
        home: state.home,
        command: node,
        args: [supervisor],
        env,
        mode: "managed",
        foreground: true,
        signal: controller.signal,
        onAcquired(instance) {
          acquired = instance;
          browserTask = save(path.join(state.root, "runtime-owner.json"), {
            pid: process.pid,
            daemonPid: instance.pid,
            daemonStartedAt: instance.startedAt,
          });
          browserTask.catch((error) => {
            console.error(`Cannot record private launcher ownership: ${error.message}`);
            controller.abort();
          });
        },
        onReady(instance) {
          acquired = instance;
          const url = `http://${instance.listen}`;
          console.log(
            `Paseo -> OMP -> Kiro HTTP ready: ${url}\nKeep this window open. stop.cmd stops only this private daemon.\nUse auth.cmd login then models.cmd if the account model list is empty.`,
          );
          browserTask = Promise.resolve(browserTask)
            .then(() => (flags["no-browser"] ? undefined : openBrowser(url)))
            .catch((error) =>
              console.error(`Browser launch failed: ${error.message}. Open ${url} manually.`),
            );
        },
      });
      await browserTask;
      await shutdown;
      if (!result.spawned)
        throw new Error(
          "Another launcher acquired this private home during startup. Use its window; this launcher did not adopt its proxy or daemon.",
        );
      return result.exitCode ?? 0;
    } catch (error) {
      if (controller.signal.aborted) return 130;
      throw error;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      const ownerFile = path.join(state.root, "runtime-owner.json");
      const owner = await json(ownerFile);
      if (owner?.pid === process.pid) await rm(ownerFile, { force: true });
    }
  });
}
async function doctor(state, flags) {
  const manifest = await json(path.join(bundleRoot, "bundle-manifest.json"));
  if (!manifest)
    throw new Error(
      "bundle-manifest.json is missing; use the complete release ZIP, not a source checkout.",
    );
  const critical = new Set([
    "runtime/node/node.exe",
    "runtime/omp/omp.exe",
    "runtime/proxy/kiro-proxy.exe",
    "app/lib/run.mjs",
    "app/lib/proxy.mjs",
    "app/plugin/omp-kiro/index.js",
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
  validateNetwork(state.config.network);
  console.log(
    JSON.stringify(
      {
        integrity: "verified",
        filesChecked: checked,
        node: process.version,
        proxy: "native-winhttp-sspi",
        networkMode: state.config.network.mode,
        nodeHeapMb: state.config.nodeHeapMb,
        loopbackOnly: true,
        server2019Verified: manifest.compatibility.server2019Verified,
        speech: "disabled; models not bundled",
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
  if (await (await control()).readDaemonInstance(state.home))
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
export async function main(argv = process.argv.slice(2)) {
  const { action, flags, rest } = argumentsFor(argv);
  if (action === "help" || (!["auth", "omp", "paseo"].includes(action) && rest.includes("--help"))) {
    console.log(usage);
    return 0;
  }
  if (
    ![
      "start",
      "setup",
      "omp",
      "auth",
      "models",
      "usage",
      "stop",
      "doctor",
      "network",
      "paseo",
    ].includes(action)
  )
    throw new Error("Unknown command. Use help.");
  const state = await initialize(flags["data-dir"]);
  if (action === "network") return network(state, rest);
  if (action === "stop") return stop(state);
  if (action === "doctor") return doctor(state, flags);
  if (action === "start") return start(state, flags);
  if (action === "setup") {
    await trust(state, flags);
    const port = Number(flags.port ?? state.config.port);
    await configurePaseo(state, { passwordHash: await password(state, flags), port });
    if (port !== state.config.port) {
      state.config.port = port;
      await save(state.configFile, state.config);
    }
    await ensureOmpSettings(state);
    console.log("Private setup complete. Run auth.cmd login, then start.cmd.");
    return 0;
  }
  if (action === "paseo")
    return child(node, [cli, ...privatePaseoArgs(rest, state.home)], runtimeEnv(state), {
      relaySignals: true,
    });
  if (action === "auth") {
    if (rest.some((value) => value === "--auth-file" || value.startsWith("--auth-file=")))
      throw new Error(
        "Use --data-dir to choose the shared authentication store; --auth-file cannot split OMP/Paseo stores.",
      );
    let args = ["status", "logout", "import-cli"].includes(rest[0]) ? ["auth", ...rest] : rest;
    const operation = authOperation(args);
    if (
      operation === "auth import-cli" &&
      !args.some((value) => value === "--database" || value.startsWith("--database="))
    )
      args = [...args, "--database", path.join(homedir(), ".local/share/kiro-cli/data.sqlite3")];
    const perform = async (env) => {
      const code = await child(node, [path.join(pluginRoot, "auth-cli.mjs"), ...args], env, {
        relaySignals: true,
      });
      if (code || !["login", "auth import-cli", "auth logout"].includes(operation)) return code;
      // Credentials changed successfully. Invalidate the previous account's
      // metadata before any refresh; a failed request cannot leave it trusted.
      try {
        await rm(path.join(state.root, "models.json"), { force: true });
        if (await json(path.join(state.home, "config.json"))) {
          await configurePaseo(state);
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
  if (action === "omp") {
    const info = rest.some((value) => ["--version", "-v", "--help", "-h"].includes(value));
    if (
      process.platform === "win32" &&
      process.stdin.isTTY &&
      !flags.console &&
      !process.env.WT_SESSION &&
      !process.env.WEZTERM_PANE &&
      !info &&
      !rest.includes("--mode")
    ) {
      const terminal = spawn(
        path.join(bundleRoot, "runtime/terminal/wezterm-gui.exe"),
        [
          "--config-file",
          path.join(bundleRoot, "runtime/terminal/wezterm.lua"),
          "start",
          "--always-new-process",
          "--cwd",
          process.cwd(),
          "--",
          node,
          path.join(bundleRoot, "app/lib/run.mjs"),
          "omp",
          "--console",
          "--data-dir",
          state.root,
          ...(flags["accept-plugin-code"] ? ["--accept-plugin-code"] : []),
          "--",
          ...rest,
        ],
        { detached: true, stdio: "ignore" },
      );
      await new Promise((resolve, reject) => {
        terminal.once("spawn", resolve);
        terminal.once("error", reject);
      });
      terminal.unref();
      return 0;
    }
    await ensureOmpSettings(state);
    if (info)
      return child(omp, [...ompArgs(), ...rest], { ...runtimeEnv(state), NODE_OPTIONS: "" });
    await trust(state, flags);
    const catalog = await json(path.join(state.root, "models.json"));
    const args = accountOmpArgs(rest, catalog?.models);
    return transport(state, (env) =>
      child(omp, [...ompArgs(), "--approval-mode", "yolo", ...args], { ...env, NODE_OPTIONS: "" }, { relaySignals: true }),
    );
  }
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
