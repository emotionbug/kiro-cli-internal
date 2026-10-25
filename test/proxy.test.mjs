import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import { access, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  startProxy,
  validateNetwork,
  helperEnvironment,
  isLoopback,
} from "../payload/app/lib/proxy.mjs";

const bundleRoot = process.env.KIRO_TEST_BUNDLE_ROOT;
const bootstrap = bundleRoot
  ? pathToFileURL(join(bundleRoot, "app/lib/network-bootstrap.mjs")).href
  : new URL("../payload/app/lib/network-bootstrap.mjs", import.meta.url).href;
async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}
function stop(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}
async function child(code, env = {}) {
  const p = spawn(process.execPath, ["--import", bootstrap, "--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      OMP_INTERNAL_PROXY: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  p.stdout.on("data", (x) => {
    out += x;
  });
  p.stderr.on("data", (x) => {
    err += x;
  });
  const timer = setTimeout(() => p.kill(), 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      p.once("error", reject);
      p.once("exit", resolve);
    });
    assert.equal(code, 0, err);
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}
function requestThrough(proxy, target) {
  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const authorization = p.username
      ? {
          "proxy-authorization":
            "Basic " +
            Buffer.from(
              `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`,
            ).toString("base64"),
        }
      : {};
    const req = http.get(
      {
        hostname: p.hostname,
        port: p.port,
        path: target,
        headers: { host: new URL(target).host, ...authorization },
        agent: false,
      },
      (response) => {
        let body = "";
        response.on("data", (x) => {
          body += x;
        });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    req.on("error", reject);
  });
}

test("network configuration rejects stored credentials and ambiguous routing", () => {
  assert.equal(validateNetwork().mode, "system");
  for (const network of [
    { mode: "manual" },
    { mode: "other" },
    { mode: "manual", proxy: "http://user:password@proxy.invalid:8080" },
    { mode: "manual", proxy: "socks://proxy.invalid:8080" },
    { mode: "manual", pacUrl: "https://user:password@pac.invalid/file" },
    { mode: "manual", pacUrl: "relative.pac" },
    { mode: "direct", proxy: "http://proxy.invalid:8080" },
    { proxy: "http://proxy.invalid:8080", pacUrl: "https://pac.invalid/file" },
  ])
    assert.throws(() => validateNetwork(network));
  assert.equal(
    validateNetwork({ mode: "manual", proxy: "http://proxy.invalid:8080" }).proxy,
    "proxy.invalid:8080",
  );
});

test("loopback classification covers local MCP and WebSocket endpoints", () => {
  for (const host of [
    "localhost",
    "LOCALHOST.",
    "mcp.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
  ])
    assert.equal(isLoopback(host), true, host);
  for (const host of ["localhost.attacker.invalid", "127.0.0.1.attacker.invalid", "kiro.invalid"])
    assert.equal(isLoopback(host), false, host);
});

test("helper environment cannot inherit app credentials, proxy overrides or Python injection", () => {
  assert.deepEqual(
    helperEnvironment({
      SystemRoot: "C:\\Windows",
      PATH: "runtime",
      OMP_KIRO_TOKEN: "secret",
      PX_PASSWORD: "secret",
      HTTP_PROXY: "secret",
      PYTHONPATH: "injected",
      NODE_OPTIONS: "injected",
    }),
    { SystemRoot: "C:\\Windows", PATH: "runtime" },
  );
});

test("direct mode removes stale proxies, enforces loopback bypass and strict TLS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiro-proxy-direct-"));
  const result = await startProxy({
    config: { network: { mode: "direct" } },
    dataDir: dir,
    env: {
      HTTP_PROXY: "http://old.invalid",
      https_proxy: "http://old.invalid",
      NO_PROXY: "*",
      PX_PASSWORD: "secret",
    },
  });
  assert.equal(result.env.HTTP_PROXY, undefined);
  assert.equal(result.env.PX_PASSWORD, undefined);
  assert.match(result.env.NO_PROXY, /localhost,127\.0\.0\.1,::1/);
  assert.match(result.env.NODE_OPTIONS, /--use-system-ca --import=/);
  await result.close();
  await result.close();
  await assert.rejects(
    startProxy({
      config: { network: { mode: "direct" } },
      env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    }),
    /TLS verification/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    startProxy({ signal: controller.signal, config: { network: { mode: "direct" } } }),
    { name: "AbortError" },
  );
  await rm(dir, { recursive: true, force: true });
});

test("owned Node fetch and http route remote destinations, but local HTTP and WebSocket bypass", async () => {
  let proxyHits = 0;
  const privateToken = "Basic " + Buffer.from("kiro:" + "a".repeat(64)).toString("base64");
  const proxy = http.createServer((req, res) => {
    assert.equal(req.headers["proxy-authorization"], privateToken);
    proxyHits++;
    res.end("upstream:" + req.url);
  });
  // Undici uses CONNECT for HTTP as well as HTTPS.
  const tunnels = new Set();
  proxy.on("connect", (req, socket) => {
    assert.equal(req.headers["proxy-authorization"], privateToken);
    proxyHits++;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nupstream"),
    );
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
  });
  const local = http.createServer((req, res) => {
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.end("direct");
  });
  local.on("upgrade", (req, socket) =>
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    ),
  );
  const proxyPort = await listen(proxy),
    localPort = await listen(local);
  try {
    const out = await child(
      `
      import http from 'node:http';
      const remote = await (await fetch('http://remote.fixture.invalid/test')).text();
      if (remote !== 'upstream') throw new Error(remote);
      const local = await (await fetch('http://127.0.0.1:${localPort}/')).text();
      if (local !== 'direct') throw new Error(local);
      const body = await new Promise((resolve,reject) => http.get('http://another.fixture.invalid/',r => {let s='';r.on('data',x=>s+=x);r.on('end',()=>resolve(s));}).on('error',reject));
      if (!body.startsWith('upstream:')) throw new Error(body);
      await new Promise((resolve,reject) => {
        const r=http.get('http://127.0.0.1:${localPort}/',{headers:{Connection:'Upgrade',Upgrade:'websocket'}});
        r.on('upgrade',(_,s)=>{s.destroy();resolve();});r.on('error',reject);
      });
      console.log('ok');
    `,
      { OMP_INTERNAL_PROXY: `http://kiro:${"a".repeat(64)}@127.0.0.1:${proxyPort}` },
    );
    assert.equal(out, "ok");
    assert.equal(proxyHits, 2);
  } finally {
    for (const socket of tunnels) socket.destroy();
    await Promise.all([stop(proxy), stop(local)]);
  }
});

// Public test-only certificate/key, generated for localhost; never used by the
// product. The untrusted fixture MUST fail unless explicitly added as a CA.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCou5Gqz1iGKHpJ
e1WDmQfZ3sdMWUohfexy+m6UwntGTE0/0wzsaj0Zpa94YZ3KVvD70h7uTWQGi0EF
OYKxElK0s+/1NqqCLm9ExRXy0LD6w+jBhboCvCmJxvvTMMDvQLNGj6lzyJ81V8Se
X8YWZhUbPmcqd39nF3SqnK4/Y2cZ2ZbgNPSQeqe14CzVlIT8XoWw96IRF4De2IJ4
wX2GRfsmPJ6B8FYgdCY3SWylZLz2LOcK+EiJZ/N2jQL78geSupKXFEnoyd55cVZY
5Np5uLVnL6zkgSTA0MF3z0HT4QC/0Qs6pRciFhD8LwWDMzD+RUlyERvJYcQ/KbnO
Z9uIBelbAgMBAAECggEAQnPArj9D025MnvT6XD4gJ++DmS+PMPqJbUzw0Rh4+Voi
kFDbxZ4fmyK0JRp4zNAJz3tU4DBNhQBB5r9cF8WqGe3FwtK5O1TzUGe4Oa10Dgaq
+9BhTiNxzoe19No+Gdvm3xLEP0vTW+xJjMAWYQrqJBUjB0gRvnWv5mOXgnJxD+4L
8zEVSwfVHWmdIzOC8gtE0kwKfot/gdOX6W+gpwgQ/UTLJPEwGlyFMzuWV06MEdyF
XvsEEw+Xuo6ZYgXjRP2KZkC9iiVihLR/kYg3w8umINnC8FxFYwxD2aEApJ/HjkU+
RSfDkV08bJQtdE9CmF/QI106CW3Nfo6s6Gdkz/51lQKBgQDk7s/rnFMX4UQbtHXW
PqUmoZBmpDQpEr73ePJi9vMPOcO+seRgp6vdjBKwz8iNKvJlQZ0wCm11FodtvfnT
OAOHxYhRQeaTgm+p3kxVXth7OK9z6nByZbpyzlwYaNwPw9jO7yt7941QyVS5inKC
sKaDDhjPSj4c1dX52e2oHh16ZwKBgQC8rqh4ewTzMi2PYMy8JTTAzke1W1y7+ayN
QWJoGcX3JKMzvDnzQ7PcdgX2ySYQcAcNgLCCALCz2AvubrYH3IZHga/gzJavpCIA
DShk2Z5LkFAM/0pH3kRYQQy9wc0u2uI8a3i54yNhpJs5nN77j8RpDmKPoMoIGk9n
6H4tDVio7QKBgHl7hJf5j1p3rmWpQHKdMZQrXe4pqog1K2M1KiJ7+wUUWRwjWBY2
Q4xAHVb4G+tVY+V5iQkKL4VXnCwPCLgd3Dm7B5hfCRUzvT99+DHBL81LikdPm7YI
54Suns5RLp2rBqzg28lf1vyMqcn/fr59MQ8Qdvfg5M72ZiK8k1GIEYp3AoGBAI8h
Y1V55MhjsSIJyWWUR89W7BjMRK2n+dhx2CemHYGcfl05lTBPlHpR4bZS4pgnk4IP
tFX6FhFne62UuGuAQzCtVXEPYeO9e7lUQec3GhiyUbd6VavtFSVpuzObd33qtyIk
WMGSZ32js8jhkll8tv8G1Yek7n11D/V/7W9Zp38FAoGAWNf1ougxq3IHZsjeoPoK
x377yqLttZA0iRV0Qc8uwBVWt5qWBv1r1qzfrMWnV821qJgZl550MlxjNL26o+am
gcU7sTSiDtgLHkfYt5061bF9hVs9gyYNtf//b8u6Ne9OhMGVWdHpDYHGJTQcPygK
vEIwJ+UgBNmJWUjV+5w8MV8=
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUSascQnBu8xhJUmoThEZT7bPqJZcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyNTAxMjQ0NFoXDTM2MTAy
MjAxMjQ0NFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqLuRqs9Yhih6SXtVg5kH2d7HTFlKIX3scvpulMJ7RkxN
P9MM7Go9GaWveGGdylbw+9Ie7k1kBotBBTmCsRJStLPv9Taqgi5vRMUV8tCw+sPo
wYW6Arwpicb70zDA70CzRo+pc8ifNVfEnl/GFmYVGz5nKnd/Zxd0qpyuP2NnGdmW
4DT0kHqnteAs1ZSE/F6FsPeiEReA3tiCeMF9hkX7JjyegfBWIHQmN0lspWS89izn
CvhIiWfzdo0C+/IHkrqSlxRJ6MneeXFWWOTaebi1Zy+s5IEkwNDBd89B0+EAv9EL
OqUXIhYQ/C8FgzMw/kVJchEbyWHEPym5zmfbiAXpWwIDAQABo28wbTAdBgNVHQ4E
FgQUUvlJZkmdCcQTxqMS/Qxv1Ti7/vUwHwYDVR0jBBgwFoAUUvlJZkmdCcQTxqMS
/Qxv1Ti7/vUwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBABKTH4Nk8p6g1QEEoZfQ9RMvcIxdDUtB
NcE6hq6qXdqAjujqsmrPCxVd7cG9PjH/FVD0A0SJ7UAJVp7TFsYEHDHrJtohvRDg
74nKHVjoOo90sDJdH3U9BENlEf9mNihbJn+4CSFTnnqF9Awy5tydL6RPBoGFUWYR
O/aNOTfuextQLaLeDcog+zefHXSRZ1+jeJJ3wtclCFByN5VWjNoKwAomLhUZpvG/
H4E6Wtwq33a2YWiEfTytFDs4tzAEu8kA8/yHf1q67bXJ+O82MIWLjvodMmvZKCzd
0gSDxJZ4irRAPt3T+RCc0YdEnZ+Hmh1c49VeapiHQzChyrTYGUtadDk=
-----END CERTIFICATE-----`;

test("CA configuration rejects private keys before export and copies only canonical public certificates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiro-proxy-public-ca-"));
  const ca = join(dir, "input.pem");
  try {
    await writeFile(ca, cert + "\n" + key);
    for (const config of [
      { network: { mode: "direct", caFile: ca } },
      { network: { mode: "direct" } },
    ]) {
      await assert.rejects(
        startProxy({ dataDir: dir, config, env: { NODE_EXTRA_CA_CERTS: ca } }),
        /must not contain private keys/,
      );
    }
    await assert.rejects(access(join(dir, "proxy")), { code: "ENOENT" });
    await writeFile(
      ca,
      "private-comment-not-a-certificate\n" + cert + "\nunknown-payload-not-for-export",
    );
    const proxy = await startProxy({
      dataDir: dir,
      config: { network: { mode: "direct", caFile: ca } },
      env: {},
    });
    try {
      assert.notEqual(proxy.env.NODE_EXTRA_CA_CERTS, ca);
      const exported = await readFile(proxy.env.NODE_EXTRA_CA_CERTS, "utf8");
      assert.match(exported, /-----BEGIN CERTIFICATE-----/);
      assert.doesNotMatch(exported, /PRIVATE KEY|private-comment|unknown-payload/);
    } finally {
      await proxy.close();
    }
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----");
    await assert.rejects(
      startProxy({ dataDir: dir, config: { network: { mode: "direct", caFile: ca } }, env: {} }),
      /valid PEM certificates/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("strict end-to-end TLS rejects untrusted certificate, explicit PEM CA succeeds", async () => {
  const server = https.createServer({ key, cert }, (req, res) => res.end("verified"));
  const port = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), "kiro-proxy-ca-"));
  try {
    assert.equal(
      await child(
        `try { await fetch('https://127.0.0.1:${port}/'); throw new Error('accepted'); } catch(e) { if(e.message==='accepted') throw e; console.log('rejected'); }`,
        { NODE_EXTRA_CA_CERTS: "" },
      ),
      "rejected",
    );
    await writeFile(join(dir, "ca.pem"), cert);
    assert.equal(
      await child(`console.log(await (await fetch('https://127.0.0.1:${port}/')).text())`, {
        NODE_EXTRA_CA_CERTS: join(dir, "ca.pem"),
      }),
      "verified",
    );
  } finally {
    await stop(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "Windows native proxy evaluates each destination PAC and keeps helper alive after session cancellation",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    assert.ok(bundleRoot, "Set KIRO_TEST_BUNDLE_ROOT to the fully staged Windows bundle.");
    const a = http.createServer((req, res) => res.end("A"));
    const b = http.createServer((req, res) => res.end("B"));
    const direct = http.createServer((req, res) => res.end("DIRECT"));
    const ap = await listen(a),
      bp = await listen(b),
      dp = await listen(direct, "127.0.0.2");
    const pac = http.createServer((req, res) => {
      if (req.url === "/broken") {
        res.writeHead(404);
        res.end("not PAC");
        return;
      }
      if (req.url === "/slow") return;
      if (req.url === "/syntax") {
        res.end("function FindProxyForURL( { syntax error");
        return;
      }
      res.setHeader("content-type", "application/x-ns-proxy-autoconfig");
      res.end(
        `function FindProxyForURL(url,host){ if(host==='a.fixture.invalid')return 'PROXY 127.0.0.1:${ap}'; if(host==='b.fixture.invalid')return 'PROXY 127.0.0.1:${bp}';return 'DIRECT';}`,
      );
    });
    const pp = await listen(pac);
    const dir = await mkdtemp(join(tmpdir(), "kiro-proxy-process-"));
    const controller = new AbortController();
    let result;
    try {
      result = await startProxy({
        bundleRoot,
        dataDir: dir,
        config: { network: { mode: "manual", pacUrl: `http://127.0.0.1:${pp}/proxy.pac` } },
        signal: controller.signal,
      });
      assert.deepEqual(
        await requestThrough(result.env.HTTP_PROXY, "http://a.fixture.invalid/test"),
        { status: 200, body: "A" },
      );
      assert.deepEqual(
        await requestThrough(result.env.HTTP_PROXY, "http://b.fixture.invalid/test"),
        { status: 200, body: "B" },
      );
      assert.deepEqual(await requestThrough(result.env.HTTP_PROXY, `http://127.0.0.2:${dp}/test`), {
        status: 200,
        body: "DIRECT",
      });
      controller.abort(); // OMP cancellation is not application exit.
      assert.equal(
        (await requestThrough(result.env.HTTP_PROXY, "http://a.fixture.invalid/after-cancel")).body,
        "A",
      );
      await result.close();
      await result.close();
      await assert.rejects(
        requestThrough(result.env.HTTP_PROXY, "http://a.fixture.invalid/closed"),
      );
      await assert.rejects(
        startProxy({
          bundleRoot,
          dataDir: dir,
          config: { network: { mode: "manual", pacUrl: `http://127.0.0.1:${pp}/missing` } },
          signal: AbortSignal.abort(),
        }),
        { name: "AbortError" },
      );
      await assert.rejects(
        startProxy({
          bundleRoot,
          dataDir: dir,
          config: { network: { mode: "manual", pacUrl: `http://127.0.0.1:${pp}/broken` } },
        }),
        /startup failed|exited before startup/,
      );
      await assert.rejects(
        startProxy({
          bundleRoot,
          dataDir: dir,
          config: { network: { mode: "manual", pacUrl: `http://127.0.0.1:${pp}/syntax` } },
        }),
        /startup failed|exited before startup/,
      );
      const startup = new AbortController();
      const cancelling = startProxy({
        bundleRoot,
        dataDir: dir,
        config: { network: { mode: "manual", pacUrl: `http://127.0.0.1:${pp}/slow` } },
        signal: startup.signal,
      });
      const abortTimer = setTimeout(() => startup.abort(), 100);
      try {
        await assert.rejects(cancelling, { name: "AbortError" });
      } finally {
        clearTimeout(abortTimer);
      }
    } finally {
      await result?.close();
      await Promise.all([stop(a), stop(b), stop(direct), stop(pac)]);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

function tunnelThrough(proxy, authority) {
  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: p.hostname,
      port: p.port,
      method: "CONNECT",
      path: authority,
      headers: {
        host: authority,
        "proxy-authorization":
          "Basic " + Buffer.from(`${p.username}:${p.password}`).toString("base64"),
      },
      agent: false,
    });
    req.on("connect", (response, socket, head) => {
      if (head.length) socket.unshift(head);
      resolve({ response, socket });
    });
    req.on("error", reject);
    req.end();
  });
}

test(
  "Windows native proxy isolates local auth, streams HTTP and opaque CONNECT, preserves half-close, rejects SSPI challenges",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    assert.ok(bundleRoot, "Set KIRO_TEST_BUNDLE_ROOT to the fully staged Windows bundle.");
    const dir = await mkdtemp(join(tmpdir(), "kiro-native-stream-"));
    const seen = [];
    const sockets = new Set();
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers["proxy-authorization"]);
      if (req.url.includes("reject.fixture.invalid")) {
        // A malformed NTLM server token must fail closed, never fall back DIRECT.
        res.shouldKeepAlive = true;
        res.writeHead(407, {
          "proxy-authenticate": req.headers["proxy-authorization"] ? "NTLM invalid!" : "NTLM",
          "content-length": "0",
          connection: "keep-alive",
        });
        res.end();
        return;
      }
      let bytes = 0;
      req.on("data", (data) => {
        bytes += data.length;
      });
      req.on("end", () => {
        res.setHeader("x-fixture-metadata", "preserved");
        res.end(`${req.method}:${bytes}`);
      });
    });
    upstream.on("connect", (req, socket, head) => {
      seen.push(req.headers["proxy-authorization"]);
      socket.allowHalfOpen = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let bytes = head.length;
      socket.on("data", (data) => {
        bytes += data.length;
      });
      socket.on("end", () => socket.end("after-half-close:" + bytes));
    });
    upstream.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const port = await listen(upstream);
    let proxy;
    try {
      proxy = await startProxy({
        bundleRoot,
        dataDir: dir,
        config: { network: { mode: "manual", proxy: `http://127.0.0.1:${port}` } },
      });
      const address = new URL(proxy.env.HTTP_PROXY);
      assert.equal(address.username, "kiro");
      assert.match(address.password, /^[a-f0-9]{64}$/);
      const unauthenticated = new URL(address);
      unauthenticated.username = "";
      unauthenticated.password = "";
      assert.equal(
        (await requestThrough(unauthenticated.href, "http://plain.fixture.invalid/no-auth")).status,
        407,
      );
      assert.deepEqual(await requestThrough(address.href, "http://plain.fixture.invalid/get"), {
        status: 200,
        body: "GET:0",
      });
      const post = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: address.hostname,
            port: address.port,
            path: "http://plain.fixture.invalid/post",
            method: "POST",
            agent: false,
            headers: {
              "proxy-authorization":
                "Basic " +
                Buffer.from(`${address.username}:${address.password}`).toString("base64"),
              "content-type": "application/octet-stream",
            },
          },
          (res) => {
            let body = "";
            res.on("data", (data) => {
              body += data;
            });
            res.on("end", () => resolve({ body, metadata: res.headers["x-fixture-metadata"] }));
          },
        );
        req.on("error", reject);
        req.write(Buffer.alloc(70000, 0x5a));
        req.end(Buffer.alloc(17000, 0x2b));
      });
      assert.deepEqual(post, { body: "POST:87000", metadata: "preserved" });
      assert.equal(
        (await requestThrough(address.href, "http://reject.fixture.invalid/")).status,
        502,
      );
      assert.ok(seen.length >= 3);
      assert.ok(
        seen.every((value) => !value || !value.startsWith("Basic ")),
        "private nonce must not reach upstream",
      );
      assert.ok(
        seen.some((value) => value?.startsWith("NTLM ")),
        "SSPI must attempt current-user NTLM before rejecting the malformed challenge",
      );
      const { response, socket } = await tunnelThrough(address.href, "opaque.fixture.invalid:443");
      assert.equal(response.statusCode, 200);
      socket.end(Buffer.alloc(100000, 0xa7));
      const output = await new Promise((resolve, reject) => {
        let body = "";
        socket.on("data", (data) => {
          body += data;
        });
        socket.on("end", () => resolve(body));
        socket.on("error", reject);
      });
      assert.equal(output, "after-half-close:100000");
      const active = await tunnelThrough(address.href, "cleanup.fixture.invalid:443");
      assert.equal(active.response.statusCode, 200);
      const closed = new Promise((resolve) => active.socket.once("close", resolve));
      active.socket.on("error", () => {});
      active.socket.resume();
      await proxy.close();
      await closed;
      await proxy.close();
      await assert.rejects(requestThrough(address.href, "http://plain.fixture.invalid/closed"));
    } finally {
      await proxy?.close();
      for (const socket of sockets) socket.destroy();
      await stop(upstream);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows native proxy serves a bounded absolute PAC file privately and tunnels strict TLS",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    assert.ok(bundleRoot, "Set KIRO_TEST_BUNDLE_ROOT to the fully staged Windows bundle.");
    const dir = await mkdtemp(join(tmpdir(), "kiro-native-pac-file-"));
    const tls = https.createServer({ key, cert }, (req, res) =>
      res.end("verified-through-connect"),
    );
    const tlsPort = await listen(tls);
    const upstream = http.createServer();
    const sockets = new Set();
    upstream.on("connect", (req, socket, head) => {
      assert.equal(req.headers["proxy-authorization"], undefined);
      const remote = net.connect(tlsPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        socket.pipe(remote);
        remote.pipe(socket);
      });
      for (const s of [socket, remote]) {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
        s.on("error", () => {
          socket.destroy();
          remote.destroy();
        });
      }
    });
    const upstreamPort = await listen(upstream);
    let proxy;
    try {
      const pacPath = join(dir, "private.pac");
      await writeFile(
        pacPath,
        `function FindProxyForURL(url,host){return 'PROXY 127.0.0.1:${upstreamPort}';}`,
      );
      proxy = await startProxy({
        bundleRoot,
        dataDir: dir,
        config: { network: { mode: "manual", pacUrl: pacPath } },
      });
      // Remote hostname forces the native route; the controlled upstream maps it
      // to the test TLS server. Hostname localhost is selected for certificate SNI.
      const target = "https://tls.fixture.invalid/";
      assert.equal(
        await child(
          `import https from 'node:https'; await new Promise((resolve,reject)=>https.get('${target}',{servername:'localhost'},r=>reject(new Error('accepted untrusted TLS'))).on('error',()=>resolve())); console.log('rejected');`,
          { ...proxy.env, NODE_EXTRA_CA_CERTS: "" },
        ),
        "rejected",
      );
      const ca = join(dir, "ca.pem");
      await writeFile(ca, cert);
      assert.equal(
        await child(
          `import https from 'node:https'; const result=await new Promise((resolve,reject)=>https.get('${target}',{servername:'localhost'},r=>{let s='';r.on('data',x=>s+=x);r.on('end',()=>resolve(s));}).on('error',reject)); console.log(result);`,
          { ...proxy.env, NODE_EXTRA_CA_CERTS: ca },
        ),
        "verified-through-connect",
      );
      await proxy.close();
      proxy = undefined;
      await writeFile(pacPath, Buffer.alloc(1024 * 1024 + 1));
      await assert.rejects(
        startProxy({
          bundleRoot,
          dataDir: dir,
          config: { network: { mode: "manual", pacUrl: pacPath } },
        }),
        /exceeds 1 MiB/,
      );
    } finally {
      await proxy?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([stop(upstream), stop(tls)]);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows current-user Negotiate authenticates HTTP and CONNECT against real AcceptSecurityContext",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    assert.ok(bundleRoot, "Set KIRO_TEST_BUNDLE_ROOT to the fully staged Windows bundle.");
    assert.ok(
      process.env.KIRO_TEST_SSPI_FIXTURE,
      "Compile native/sspi-fixture.cpp outside the ZIP and set KIRO_TEST_SSPI_FIXTURE.",
    );
    const dir = await mkdtemp(join(tmpdir(), "kiro-native-sspi-"));
    const fixture = spawn(process.env.KIRO_TEST_SSPI_FIXTURE, [], {
      env: helperEnvironment(process.env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    fixture.stdin.on("error", () => {});
    fixture.stderr.resume();
    let fixtureFailure = false,
      exited = false;
    const exit = new Promise((resolve) => {
      fixture.once("exit", (code) => {
        exited = true;
        resolve(code);
      });
      fixture.once("error", () => {
        exited = true;
        resolve(-1);
      });
    });
    let closingFixture;
    const closeFixture = () =>
      (closingFixture ??= (async () => {
        fixture.stdin.end();
        const timer = setTimeout(() => {
          if (!exited) fixture.kill();
        }, 3000);
        try {
          return await exit;
        } finally {
          clearTimeout(timer);
        }
      })());
    let proxy;
    try {
      const port = await new Promise((resolve, reject) => {
        let text = "";
        const timer = setTimeout(
          () => reject(new Error("Real SSPI fixture did not start.")),
          10000,
        );
        fixture.once("error", reject);
        fixture.stdout.on("data", (data) => {
          text += data.toString();
          if (text.length > 4096) {
            clearTimeout(timer);
            reject(new Error("Unexpected SSPI fixture output."));
            return;
          }
          if (text.includes("KIRO_SSPI_FIXTURE_ERROR")) {
            fixtureFailure = true;
            clearTimeout(timer);
            reject(new Error("Windows SSPI fixture failed."));
          }
          const ready = /^KIRO_SSPI_FIXTURE_READY ([1-9][0-9]{0,4})\r?$/m.exec(text);
          if (ready) {
            clearTimeout(timer);
            resolve(Number(ready[1]));
          }
        });
        exit.then(() => {
          clearTimeout(timer);
          reject(new Error("Windows SSPI fixture exited before readiness."));
        });
      });
      proxy = await startProxy({
        bundleRoot,
        dataDir: dir,
        config: { network: { mode: "manual", proxy: `http://127.0.0.1:${port}` } },
      });
      assert.deepEqual(
        await requestThrough(proxy.env.HTTP_PROXY, "http://sspi.fixture.invalid/real-os-auth"),
        { status: 200, body: "sspi-http" },
      );
      assert.equal(
        await child(
          `import http from 'node:http'; const body=await new Promise((resolve,reject)=>http.get('http://sspi.fixture.invalid/sdk',r=>{if(r.headers['x-sspi-fixture']!=='authenticated')return reject(new Error('SSPI not accepted'));let text='';r.on('data',x=>text+=x);r.on('end',()=>resolve(text));}).on('error',reject));console.log(body);`,
          proxy.env,
        ),
        "sspi-http",
      );
      const { response, socket } = await tunnelThrough(
        proxy.env.HTTP_PROXY,
        "sspi.fixture.invalid:443",
      );
      assert.equal(response.statusCode, 200);
      const payload = Buffer.alloc(70000, 0xb3);
      const echo = new Promise((resolve, reject) => {
        const chunks = [];
        socket.on("data", (data) => chunks.push(data));
        socket.on("end", () => resolve(Buffer.concat(chunks)));
        socket.on("error", reject);
      });
      socket.end(payload);
      assert.deepEqual(await echo, payload);
      assert.equal(
        fixtureFailure,
        false,
        "Real Windows security provider rejected authentication.",
      );
      await proxy.close();
      proxy = undefined;
      assert.equal(await closeFixture(), 0);
    } finally {
      await proxy?.close();
      await closeFixture();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
