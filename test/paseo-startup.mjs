// Real published OMP runtime/process transport; controlled delayed-ready child,
// not a model or Kiro cloud fixture. No user daemon or OMP process is selected.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.argv[2] === "--fixture") {
  const marker = process.argv[3];
  const timer = setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "ready", protocolVersions: [1] }) + "\n");
  }, 35000);
  const finish = () => { clearTimeout(timer); process.stdin.destroy(); };
  process.once("SIGTERM", finish);
  process.stdin.once("end", finish);
  process.stdin.resume();
  await writeFile(marker, JSON.stringify({ pid: process.pid }));
} else {
  assert.equal(process.argv[2], "--app");
  assert.equal(process.argv.length, 4);
  const app = path.resolve(process.argv[3]);
  const require = createRequire(path.join(app, "package.json"));
  const server = path.dirname(require.resolve("@getpaseo/server"));
  const { OmpCliRuntime } = await import(pathToFileURL(path.join(server, "agent/providers/omp/cli-runtime.js")));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "kiro-startup-"));
  const script = fileURLToPath(import.meta.url);
  const logger = require("pino")({ level: "silent" });
  const sessions = [];
  const controllers = [];
  const observedPids = [];
  const report = { qualification: "owned Kiro HTTP startup waits beyond first30s retry; cancel/exit remain active", scope: "real published OMP runtime and process transport, controlled delayed-ready Node child; not real OMP generation", result: "failed", scenarios: [] };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  async function markerPid(marker) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const { pid } = JSON.parse(await readFile(marker, "utf8"));
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        observedPids.push(pid);
        return pid;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(20);
    }
    throw new Error("Controlled child did not start");
  }
  async function exited(pid) {
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await delay(20);
    assert.equal(alive(pid), false, "Owned startup fixture child leaked");
  }
  function start(name, scoped, readyTimeoutMs) {
    const controller = new AbortController();
    controllers.push(controller);
    const marker = path.join(scratch, name + ".json");
    const runtime = new OmpCliRuntime({
      logger, readyTimeoutMs,
      runtimeSettings: {
        command: { mode: "replace", argv: [process.execPath, script, "--fixture", marker] },
        env: { KIRO_INTERNAL_DATA_DIR: scoped ? scratch : undefined, OMP_KIRO_TRANSPORT: "http", NODE_OPTIONS: "" },
      },
    });
    const at = Date.now();
    const pending = runtime.startSession({ cwd: scratch, signal: controller.signal, noSession: true });
    pending.catch(() => {});
    const deadline = setTimeout(() => controller.abort(new Error("Startup qualification deadline")), 50000);
    pending.finally(() => clearTimeout(deadline)).catch(() => {});
    return { controller, marker, pending, at };
  }
  try {
    const slow = start("delayed-ready", true, 20000);
    const slowPid = await markerPid(slow.marker);
    const session = await slow.pending;
    sessions.push(session);
    const waitedMs = Date.now() - slow.at;
    assert.ok(waitedMs >= 34000 && waitedMs < 50000, "HTTP startup did not wait through first30s retry");
    assert.equal(alive(slowPid), true, "Host killed delayed owned child");
    await session.close();
    await exited(slowPid);
    report.scenarios.push({ name: "delayed-ready", waitedMs, childClosed: true });

    const canceled = start("cancellation", true, 20000);
    const canceledPid = await markerPid(canceled.marker);
    const canceledAt = Date.now();
    canceled.controller.abort(new Error("Controlled startup cancellation"));
    await assert.rejects(canceled.pending);
    await exited(canceledPid);
    assert.ok(Date.now() - canceledAt < 5000, "Cancellation waited for network/readiness");
    report.scenarios.push({ name: "cancellation", childClosed: true, elapsedMs: Date.now() - canceledAt });

    const ordinary = start("ordinary-deadline", false, 1000);
    const ordinaryPid = await markerPid(ordinary.marker);
    await assert.rejects(ordinary.pending);
    await exited(ordinaryPid);
    assert.ok(Date.now() - ordinary.at < 5000, "Unrelated startup deadline was disabled");
    report.scenarios.push({ name: "ordinary-deadline-retained", childClosed: true });
    report.result = "passed";
  } finally {
    for (const controller of controllers) controller.abort();
    for (const session of sessions) await session.close().catch(() => {});
    for (const pid of observedPids) await exited(pid);
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
