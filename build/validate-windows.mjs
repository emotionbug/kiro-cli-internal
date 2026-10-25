import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.argv[2], "The bundle root is required");
const root = path.resolve(process.argv[2]);
assert.equal(process.platform, "win32", "Native validation must run on Windows");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v22.23.4");
assert.equal(process.versions.modules, "127");
const app = path.join(root, "app");
const cleanupTimeoutMs = 10000;

function checkpoint(event, phase, timeoutMs = 15000) {
  console.error(`[native-qualifier] ${event} ${phase}`);
  if (process.connected) process.send({ type: "checkpoint", event, phase, timeoutMs });
}

async function supervise() {
  // The producer owns a kill-on-close Windows Job Object containing this process
  // and every descendant. A failed worker cannot leave esbuild or ConPTY behind.
  const child = fork(fileURLToPath(import.meta.url), [root, "--worker"], {
    cwd: app,
    env: process.env,
    execArgv: [],
    stdio: ["ignore", process.stderr, process.stderr, "ipc"],
    windowsHide: true,
  });
  let phase = "worker-startup";
  let evidence;
  let failure;
  let timer;
  function arm(timeoutMs) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      failure = new Error(`Native qualification timed out in ${phase} after ${timeoutMs}ms`);
      console.error(`[native-qualifier] timeout ${phase}; requesting resource cleanup`);
      if (child.connected) child.send({ type: "abort" }, () => {});
      // Cooperative cleanup is attempted first. Killing a stuck worker is a
      // failure, never a substitute for the required natural successful exit.
      timer = setTimeout(() => child.kill(), cleanupTimeoutMs);
    }, timeoutMs);
  }
  const result = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (failure) return;
      if (message?.type === "checkpoint") {
        phase = message.phase;
        arm(message.event === "begin" ? message.timeoutMs : cleanupTimeoutMs);
      } else if (message?.type === "result") {
        evidence = message.evidence;
        phase = "worker-natural-exit";
        arm(cleanupTimeoutMs);
      }
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || signal)
        reject(
          new Error(`Native qualifier worker failed in ${phase} (exit=${code}, signal=${signal})`),
        );
      else if (!evidence) reject(new Error("Native qualifier worker exited without evidence"));
      else resolve({ ...evidence, validatorWorkerExit: "natural exit after resource cleanup" });
    });
  });
  arm(15000);
  return result;
}

async function qualify() {
  const require = createRequire(path.join(app, "package.json"));
  const cancellation = new AbortController();
  const esbuildServices = new Set();
  const ptySubscriptions = [];
  let ptyChild;
  function abort() {
    cancellation.abort(new Error("Native qualification cancelled by phase watchdog"));
  }
  function onMessage(message) {
    if (message?.type === "abort") abort();
  }
  process.on("message", onMessage);
  process.on("disconnect", abort);

  async function stage(name, operation, timeoutMs = 15000) {
    cancellation.signal.throwIfAborted();
    checkpoint("begin", name, timeoutMs);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(cancellation.signal.reason);
      cancellation.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([operation(), aborted]);
      checkpoint("complete", name);
      return result;
    } catch (error) {
      checkpoint("failed", name);
      throw error;
    } finally {
      cancellation.signal.removeEventListener("abort", onAbort);
    }
  }

  function cleanupPty() {
    if (!ptyChild) return;
    checkpoint("begin", "node-pty-cleanup", cleanupTimeoutMs);
    for (const subscription of ptySubscriptions.splice(0)) subscription.dispose();
    const child = ptyChild;
    ptyChild = undefined;
    // node-pty's Windows natural-exit callback closes its output socket but
    // does not dispose the referenced ConoutConnection worker. Public kill()
    // also disposes that worker, even after the shell has exited successfully.
    child.kill();
    checkpoint("complete", "node-pty-cleanup");
  }

  let evidence;
  try {
    const esbuild = await stage("esbuild-load", () => {
      const service = require("esbuild");
      esbuildServices.add(service);
      return service;
    });
    await stage("esbuild-transform", () => {
      assert.match(
        esbuild.transformSync("const value: number = 1", { loader: "ts" }).code,
        /value/,
      );
    });
    for (const dependency of [
      "sherpa-onnx-node",
      "undici",
      "proxy-agent",
      "@getpaseo/plugin/server",
    ])
      await stage(`load:${dependency}`, () => require(dependency));
    const pty = await stage("node-pty-load", () => require("node-pty"));
    let ptyExit;
    let output = "";
    try {
      await stage("node-pty-spawn", () => {
        ptyChild = pty.spawn(process.execPath, ["-e", 'console.log("KIRO_PTY_MATERIALIZED")'], {
          name: "xterm-color",
          cols: 80,
          rows: 24,
          cwd: app,
          env: process.env,
        });
        ptyExit = new Promise((resolve, reject) => {
          ptySubscriptions.push(
            ptyChild.onData((data) => {
              output = (output + data).slice(-4096);
            }),
            ptyChild.onExit(({ exitCode }) => {
              if (exitCode !== 0 || !output.includes("KIRO_PTY_MATERIALIZED"))
                reject(new Error("node-pty Windows spawn did not complete"));
              else resolve();
            }),
          );
        });
      });
      await stage("node-pty-exit", () => ptyExit);
    } finally {
      cleanupPty();
    }

    const serverRoot = path.join(app, "node_modules", "@getpaseo", "server");
    const compilerPath = path.join(serverRoot, "dist/server/server/plugins/compiler.js");
    const compiler = await stage("paseo-compiler-load", async () => {
      // Account for a nested esbuild install too: the published compiler resolves
      // from its own package, not necessarily from the application's require().
      esbuildServices.add(createRequire(compilerPath)("esbuild"));
      return import(pathToFileURL(compilerPath));
    });
    const pluginRoot = path.join(app, "plugin/omp-kiro");
    await stage(
      "compile:omp-kiro",
      async () => {
        const compiled = await compiler.compilePlugin({
          client: null,
          server: path.join(pluginRoot, "index.server.ts"),
        });
        assert.ok(compiled.serverBundle?.length, "Kiro native plugin did not compile");
      },
      60000,
    );

    const builtinRoot = path.join(serverRoot, "dist/server/builtin-plugins");
    const builtinServers = await stage("builtin-resource-inventory", async () => {
      const servers = [];
      const entries = await readdir(builtinRoot, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(builtinRoot, entry.name);
        const manifest = JSON.parse(
          await readFile(path.join(directory, "paseo-plugin.json"), "utf8"),
        );
        // Resolve conventional entry names like the published server plugin loader.
        if ((await readdir(directory)).includes("index.server.ts"))
          servers.push({ id: manifest.id, server: path.join(directory, "index.server.ts") });
      }
      assert.ok(servers.length > 0, "Published built-in plugin resources missing");
      return servers;
    });
    for (const { id, server } of builtinServers) {
      await stage(
        `compile:builtin:${id}`,
        async () => {
          assert.ok(
            (await compiler.compilePlugin({ client: null, server })).serverBundle?.length,
            `Built-in ${id} did not compile`,
          );
        },
        60000,
      );
    }
    await stage("web-ui-resource", async () => {
      assert.match(
        await readFile(path.join(serverRoot, "dist/server/web-ui/index.html"), "utf8"),
        /html/i,
      );
    });
    evidence = {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      nodeABI: process.versions.modules,
      nodePty: "published win32-x64 N-API prebuild loaded and spawned bundled Node",
      sherpa:
        "published win32-x64 addon and DLLs loaded; speech models not downloaded or exercised",
      esbuild: esbuild.version,
      pluginCompilation: true,
      builtinPluginCompilations: builtinServers.length,
      server2019Verified: false,
    };
  } finally {
    checkpoint("begin", "resource-cleanup", cleanupTimeoutMs);
    try {
      cleanupPty();
    } finally {
      try {
        // stop() destroys the async service pipes/process and terminates the
        // separate worker created by transformSync(). Natural worker exit below
        // qualifies completion of those asynchronous disposal operations.
        await Promise.all([...esbuildServices].map((service) => service.stop()));
      } finally {
        process.off("message", onMessage);
        process.off("disconnect", abort);
      }
    }
    checkpoint("complete", "resource-cleanup");
  }
  await new Promise((resolve, reject) => {
    process.send({ type: "result", evidence }, (error) => (error ? reject(error) : resolve()));
  });
}

if (process.argv[3] === "--worker") {
  try {
    await qualify();
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
} else {
  console.log(JSON.stringify(await supervise()));
}
