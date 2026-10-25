import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32", "The native proxy probe requires Windows");
assert.equal(process.arch, "x64");
const root = path.resolve(process.argv[2]);
const executable = path.join(root, "runtime/proxy/kiro-proxy.exe");
const budgetBytes = 32 * 1024 * 1024;
const timeoutMs = 30000;
const sockets = new Set();
const helpers = new Set();
let upstreamRequests = 0;
let upstreamConnects = 0;
let nonceForwarded = false;
let pacRequests = 0;
const activeNonces = new Set();
const track = (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.setTimeout(timeoutMs, () => socket.destroy());
  return socket;
};
function checkUpstream(request) {
  if (
    request.headers["proxy-authorization"] ||
    [...activeNonces].some((nonce) => request.rawHeaders.join("\n").includes(nonce))
  )
    nonceForwarded = true;
}
const upstream = http.createServer((request, response) => {
  checkUpstream(request);
  upstreamRequests++;
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "X-Kiro-Fixture": "metadata-preserved",
  });
  response.write('{"metadata":"native-proxy-fixture"}\n');
  setTimeout(() => response.end('{"generation":"stream-complete"}\n'), 25);
});
upstream.on("connection", track);
upstream.on("connect", (request, socket, head) => {
  checkUpstream(request);
  upstreamConnects++;
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) socket.write(head);
  socket.on("data", (data) => {
    if (!socket.write(data)) socket.pause();
  });
  socket.on("drain", () => socket.resume());
});
const pacPath = `/${randomBytes(24).toString("hex")}.pac`;
const pac = http.createServer((request, response) => {
  if (request.url !== pacPath) {
    response.writeHead(404).end();
    return;
  }
  pacRequests++;
  response.writeHead(200, {
    "Content-Type": "application/x-ns-proxy-autoconfig",
    "Cache-Control": "max-age=300",
  });
  response.end(
    `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${upstream.address().port}"; }\n`,
  );
});
pac.on("connection", track);
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
async function command(file, args, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Native probe command timed out"));
    }, timeoutMs);
    child.stdout.on("data", (data) => {
      text += data;
      if (text.length > 65536) child.kill();
    });
    child.stderr.resume(); // Never echo command diagnostics that could contain private machine paths.
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(text.trim()) : reject(new Error("Native probe command failed"));
    });
  });
}
async function startHelper({ upstreamAddress = "", pacUrl = "" }) {
  const nonce = randomBytes(32).toString("hex");
  activeNonces.add(nonce);
  const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  helpers.add(child);
  const exited = new Promise((resolve) =>
    child.once("close", (code) => {
      helpers.delete(child);
      resolve(code);
    }),
  );
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const port = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("Native helper readiness timed out")),
      timeoutMs,
    );
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("Native helper failed before readiness"));
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdout.on("data", (data) => {
      text += data;
      if (text.length > 4096) {
        fail();
        child.kill();
        return;
      }
      const line = text.split(/\r?\n/)[0];
      if (!text.includes("\n")) return;
      const match = /^KIRO_PROXY_READY ([0-9]{1,5})$/.exec(line);
      clearTimeout(timer);
      child.off("exit", fail);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535)
        reject(new Error("Native helper returned an invalid readiness marker"));
      else resolve(Number(match[1]));
    });
    child.stdin.write(`KIRO_PROXY_V1\n${nonce}\nmanual\n${upstreamAddress}\n${pacUrl}\n`);
  });
  return {
    child,
    exited,
    port,
    authorization: `Basic ${Buffer.from(`kiro:${nonce}`).toString("base64")}`,
    async close() {
      child.stdin.end();
      let timer;
      const code = await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(new Error("Native helper did not stop on owner stdin EOF"));
          }, 5000);
        }),
      ]).finally(() => clearTimeout(timer));
      activeNonces.delete(nonce);
      assert.equal(code, 0, "Owner EOF must stop the native helper cleanly");
    },
  };
}
async function memory(helper, phase) {
  assert.equal(helper.child.exitCode, null, "Memory samples must target the live owned child");
  assert.equal(helper.child.signalCode, null);
  const powershell = path.join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  // A live child reference prevents PID reuse. Check its image too; never select a process by name.
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${helper.child.pid}; if ($p.Path -ine $env:KIRO_MEMORY_IMAGE) { throw 'image mismatch' }; $p.Refresh(); [ordered]@{privateBytes=[long]$p.PrivateMemorySize64;workingSetBytes=[long]$p.WorkingSet64;peakWorkingSetBytes=[long]$p.PeakWorkingSet64;peakPagedBytes=[long]$p.PeakPagedMemorySize64} | ConvertTo-Json -Compress`;
  const value = JSON.parse(
    await command(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      ...process.env,
      KIRO_MEMORY_IMAGE: executable,
    }),
  );
  assert.equal(helper.child.exitCode, null);
  for (const field of ["privateBytes", "workingSetBytes", "peakWorkingSetBytes", "peakPagedBytes"])
    assert.ok(
      Number.isSafeInteger(value[field]) && value[field] > 0,
      "Invalid process memory observation",
    );
  return { phase, ...value };
}
async function httpFixture(helper, authenticated = true) {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: helper.port,
        path: "http://metadata.fixture.invalid/generate",
        method: "GET",
        agent: false,
        headers: {
          Host: "metadata.fixture.invalid",
          ...(authenticated ? { "Proxy-Authorization": helper.authorization } : {}),
          Connection: "close",
        },
      },
      (response) => {
        let body = "";
        response.on("data", (data) => {
          body += data;
          if (body.length > 65536) response.destroy(new Error("Fixture response exceeded bound"));
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, body }),
        );
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("HTTP fixture timed out")));
    request.once("error", reject);
    request.end();
  });
}
async function tunnel(helper, destination) {
  const socket = track(net.connect({ host: "127.0.0.1", port: helper.port }));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    const onData = (data) => {
      header = Buffer.concat([header, data]);
      if (header.length > 32768) {
        cleanup();
        reject(new Error("CONNECT response exceeded bound"));
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      cleanup();
      if (!/^HTTP\/1\.[01] 200\b/.test(header.subarray(0, end).toString("ascii")))
        reject(new Error("Native CONNECT fixture failed"));
      else if (header.length !== end + 4) reject(new Error("Unexpected CONNECT fixture preface"));
      else resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Native CONNECT fixture closed early"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.write(
      `CONNECT ${destination}:443 HTTP/1.1\r\nHost: ${destination}:443\r\nProxy-Authorization: ${helper.authorization}\r\n\r\n`,
    );
  });
  return socket;
}
async function echo(socket, pattern) {
  const payload = Buffer.alloc(64 * 1024, pattern);
  await new Promise((resolve, reject) => {
    let received = 0;
    const onData = (data) => {
      if (
        received + data.length > payload.length ||
        !data.equals(payload.subarray(received, received + data.length))
      ) {
        cleanup();
        reject(new Error("Opaque CONNECT stream was changed"));
        return;
      }
      received += data.length;
      if (received === payload.length) {
        cleanup();
        resolve();
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Opaque CONNECT stream closed early"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.write(payload);
  });
}
async function checkHttp(helper) {
  const denied = await httpFixture(helper, false);
  assert.equal(denied.status, 407, "Local proxy must reject missing per-launch authentication");
  const response = await httpFixture(helper);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-kiro-fixture"], "metadata-preserved");
  assert.equal(
    response.body,
    '{"metadata":"native-proxy-fixture"}\n{"generation":"stream-complete"}\n',
  );
}
try {
  const version = await command(executable, ["--version"]);
  assert.match(version, /^kiro-proxy 1 winhttp-sspi workers=8 queue=16 buffer=16384 routes=32$/);
  await listen(upstream);
  await listen(pac);
  const manual = await startHelper({ upstreamAddress: `127.0.0.1:${upstream.address().port}` });
  await checkHttp(manual);
  const manualTunnel = await tunnel(manual, "manual.fixture.invalid");
  await echo(manualTunnel, 0x17);
  manualTunnel.destroy();
  await manual.close();
  const helper = await startHelper({ pacUrl: `http://127.0.0.1:${pac.address().port}${pacPath}` });
  await delay(250);
  const samples = [await memory(helper, "idle-after-startup-pac")];
  await checkHttp(helper);
  for (let i = 0; i < 40; i++) {
    const socket = await tunnel(helper, `warm-${i}.fixture.invalid`);
    await echo(socket, i);
    socket.destroy();
  }
  await delay(250);
  samples.push(await memory(helper, "warm-after-40-destinations"));
  const load = await Promise.all(
    Array.from({ length: 8 }, (_, i) => tunnel(helper, `load-${i}.fixture.invalid`)),
  );
  await Promise.all(
    load.map(async (socket, i) => {
      for (let j = 0; j < 4; j++) await echo(socket, i + j);
    }),
  );
  samples.push(await memory(helper, "eight-live-tunnels"));
  for (const socket of load) socket.destroy();
  await delay(250);
  samples.push(await memory(helper, "warm-after-load"));
  assert.ok(pacRequests > 0, "The actual WinHTTP PAC engine must retrieve the fixture");
  assert.equal(nonceForwarded, false, "Local proxy authentication must never reach the upstream");
  // Keep a live tunnel open: EOF must close it as well as exit the owned helper.
  const ownerTunnel = await tunnel(helper, "owner-eof.fixture.invalid");
  const closed = new Promise((resolve) => ownerTunnel.once("close", resolve));
  await helper.close();
  let ownerTimer;
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      ownerTimer = setTimeout(
        () => reject(new Error("Owner EOF did not close active tunnel")),
        5000,
      );
    }),
  ]).finally(() => clearTimeout(ownerTimer));
  const budgetSamples = samples.filter((sample) => sample.phase !== "eight-live-tunnels");
  const budgetPassed = budgetSamples.every(
    (sample) => sample.privateBytes <= budgetBytes && sample.workingSetBytes <= budgetBytes,
  );
  const report = {
    schemaVersion: 1,
    backend: "winhttp-sspi",
    version,
    platform: process.platform,
    architecture: process.arch,
    windowsRelease: os.release(),
    server2019Verified: false,
    ownership:
      "Only children spawned by this probe; exact live child PID and executable image checked for every memory sample",
    metrics:
      "Get-Process PrivateMemorySize64, WorkingSet64, PeakWorkingSet64, PeakPagedMemorySize64; bytes. PeakPaged is reported separately, not mislabeled peak-private.",
    fixture: {
      externalNetwork: false,
      manualUpstream: true,
      winHttpPac: true,
      pacFetches: pacRequests,
      routeDestinations: 40,
      concurrency: 8,
      opaqueBytesPerLoadTunnel: 262144,
      httpMetadataAndGeneration: true,
      upstreamRequests,
      upstreamConnects,
      nonceForwarded,
      missingLocalAuthRejected: true,
      ownerEofClosesActiveTunnels: true,
      corporateSspiExchange: "Not exercised by this unauthenticated upstream fixture",
      tls: "Opaque CONNECT bytes only; no TLS interception or certificate-validation claim",
    },
    memory: {
      budgetBytes,
      budgetScope:
        "Private and working set at idle and warmed after actual PAC cache use; load peaks also reported without trimming the working set",
      budgetPassed,
      samples,
    },
    comparison:
      "No Python/Px comparison was run; this report measures only the native helper, not the necessary Node owner, PAC service process, OMP or Paseo",
  };
  console.log(JSON.stringify(report));
  if (!budgetPassed)
    throw new Error(
      "Native helper exceeded the 32 MiB idle/warm private or working-set budget; inspect the safe JSON report",
    );
} finally {
  for (const child of helpers) {
    child.stdin.destroy();
    child.kill();
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [upstream, pac].map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
}
