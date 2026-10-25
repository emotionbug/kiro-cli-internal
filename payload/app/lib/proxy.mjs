import { spawn } from "node:child_process";
import { access, readFile, mkdir, writeFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";
import { getCACertificates } from "node:tls";
import { createHash, randomBytes, X509Certificate } from "node:crypto";

const libDir = fileURLToPath(new URL(".", import.meta.url));
const proxyKeys = /^(?:https?|all|no)_proxy$|^PX_/i;
export const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
export function isLoopback(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}
export function validateNetwork(network = {}) {
  const mode = network.mode ?? "system";
  if (!["direct", "system", "manual"].includes(mode))
    throw new Error("network.mode must be system, direct, or manual.");
  if (mode === "direct" && (network.proxy || network.pacUrl))
    throw new Error("Direct mode cannot specify a proxy or PAC.");
  if (network.proxy && network.pacUrl)
    throw new Error("Choose either network.proxy or network.pacUrl, not both.");
  if (mode === "manual" && !network.proxy && !network.pacUrl)
    throw new Error("Manual mode requires network.proxy or network.pacUrl.");
  let proxy;
  if (network.proxy) {
    try {
      proxy = new URL(network.proxy);
    } catch {
      throw new Error("network.proxy must be an http://host:port URL.");
    }
    if (
      proxy.protocol !== "http:" ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    ) {
      throw new Error(
        "network.proxy must be an HTTP proxy URL without credentials, path, query, or fragment. Authentication uses Windows SSPI.",
      );
    }
  }
  if (network.pacUrl) {
    if (/\r|\n|\0/.test(network.pacUrl)) throw new Error("Invalid network.pacUrl.");
    if (/^[a-z]+:\/\//i.test(network.pacUrl)) {
      let pac;
      try {
        pac = new URL(network.pacUrl);
      } catch {
        throw new Error("Invalid PAC URL.");
      }
      if (!["http:", "https:"].includes(pac.protocol) || pac.username || pac.password)
        throw new Error(
          "PAC URL must use HTTP(S), without credentials. Local absolute PAC paths are also supported.",
        );
    } else if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(network.pacUrl))
      throw new Error("Local PAC paths must be absolute.");
  }
  return { mode, proxy: proxy?.host, pacUrl: network.pacUrl, caFile: network.caFile };
}

// Only OS identity/runtime locations reach the native SSPI helper. Application
// tokens, inherited proxy passwords and runtime injection settings do not.
export function helperEnvironment(env) {
  const allowed =
    /^(?:SystemRoot|WINDIR|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PROGRAMDATA|COMSPEC|SYSTEMDRIVE|USERNAME|USERDOMAIN|USERDNSDOMAIN)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}

export async function startProxy({ bundleRoot, dataDir, config = {}, env = process.env, signal }) {
  const network = validateNetwork(config.network);
  if (
    Object.entries(env).some(
      ([key, value]) => /^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(key) && value === "0",
    )
  )
    throw new Error("Remove NODE_TLS_REJECT_UNAUTHORIZED=0; TLS verification must remain enabled.");
  signal?.throwIfAborted();
  const controlled =
    /^(?:OMP_INTERNAL_PROXY|NODE_OPTIONS|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS)$/i;
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !proxyKeys.test(key) && !controlled.test(key)),
  );
  childEnv.NO_PROXY = childEnv.no_proxy = LOOPBACK_NO_PROXY;
  childEnv.NODE_OPTIONS = `--use-system-ca --import=${JSON.stringify(pathToFileURL(join(libDir, "network-bootstrap.mjs")).href)}`;
  const inheritedCA = Object.entries(env).find(([key]) => /^NODE_EXTRA_CA_CERTS$/i.test(key))?.[1];
  let extra = "";
  if (network.caFile || inheritedCA) {
    const input = await readFile(resolve(network.caFile || inheritedCA), "utf8");
    if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(input))
      throw new Error(
        "CA files must not contain private keys; provide public PEM certificates only.",
      );
    const blocks = input.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!blocks?.length) throw new Error("network.caFile must contain valid PEM certificates.");
    try {
      extra = blocks.map((block) => new X509Certificate(block).toString()).join("\n");
    } catch {
      throw new Error("network.caFile must contain valid PEM certificates.");
    }
  }
  // Bun does not execute Node's --use-system-ca preloader. Export public system
  // roots plus canonical X.509 certificates, never raw CA-file payload/comments.
  const pem =
    process.platform === "win32" ? getCACertificates("system").join("\n") + "\n" + extra : extra;
  if (pem.includes("-----BEGIN CERTIFICATE-----")) {
    const caDir = join(dataDir, "proxy");
    await mkdir(caDir, { recursive: true });
    const caPath = join(caDir, `trust-${createHash("sha256").update(pem).digest("hex")}.pem`);
    await writeFile(caPath, pem, { mode: 0o600 });
    childEnv.NODE_EXTRA_CA_CERTS = caPath;
  }
  if (network.mode === "direct")
    return {
      env: childEnv,
      diagnostic: "Direct network mode; TLS verification enabled.",
      close: async () => {},
    };
  if (process.platform !== "win32")
    throw new Error(
      "Windows system/PAC and integrated proxy authentication require the Windows bundle. Use direct mode on other systems.",
    );
  const executable = join(bundleRoot, "runtime", "proxy", "kiro-proxy.exe");
  await access(executable);
  const workDir = join(dataDir, "proxy");
  await mkdir(workDir, { recursive: true });
  let pacServer;
  let pacUrl = network.pacUrl;
  if (pacUrl && !/^https?:\/\//i.test(pacUrl)) {
    // WinHTTP accepts HTTP(S) PAC locations, not file://. Keep the exact local
    // file private behind an unguessable path in this already-running parent.
    const file = await open(pacUrl, "r");
    let body;
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 1024 * 1024) throw new Error("Local PAC file exceeds 1 MiB.");
      body = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    const secretPath = "/" + randomBytes(32).toString("hex") + ".pac";
    pacServer = http.createServer((req, res) => {
      if (req.method !== "GET" || req.url !== secretPath) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/x-ns-proxy-autoconfig",
        "content-length": body.length,
        "cache-control": "no-store",
        connection: "close",
      });
      res.end(body);
    });
    pacServer.maxConnections = 4;
    pacServer.headersTimeout = 5000;
    pacServer.requestTimeout = 10000;
    await new Promise((resolveListen, reject) => {
      pacServer.once("error", reject);
      pacServer.listen(0, "127.0.0.1", resolveListen);
    });
    pacUrl = `http://127.0.0.1:${pacServer.address().port}${secretPath}`;
  }
  const nonce = randomBytes(32).toString("hex");
  const helper = spawn(executable, [], {
    cwd: workDir,
    env: helperEnvironment(env),
    windowsHide: true,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let exited = false;
  const exit = new Promise((resolveExit) => {
    const done = () => {
      exited = true;
      resolveExit();
    };
    helper.once("exit", done);
    helper.once("error", done);
  });
  let closing;
  const close = () =>
    (closing ??= (async () => {
      // stdin EOF belongs to this exact child; never kill by executable name/port.
      helper.stdin.end();
      if (pacServer) {
        pacServer.closeAllConnections();
        await new Promise((resolveClose) => pacServer.close(resolveClose));
      }
      if (!exited) {
        const timer = setTimeout(() => {
          if (!exited) helper.kill();
        }, 3000);
        await exit;
        clearTimeout(timer);
      }
    })());
  helper.stdin.on("error", () => {});
  helper.stderr.resume(); // Never persist upstream addresses, PAC bodies or credentials.
  let port;
  try {
    port = await new Promise((resolveReady, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Timed out starting private native PAC/SSPI proxy. Check Windows PAC policy.",
            ),
          ),
        20000,
      );
      const aborted = () => finish(signal.reason ?? new Error("Proxy startup cancelled."));
      const failed = () =>
        finish(
          new Error(
            "Private native PAC/SSPI proxy exited before startup. Check system proxy/PAC settings.",
          ),
        );
      const errored = (error) => finish(error);
      function finish(error, value) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        helper.removeListener("exit", failed);
        helper.removeListener("error", errored);
        helper.stdout.removeListener("data", receive);
        helper.stdout.resume();
        error ? reject(error) : resolveReady(value);
      }
      function receive(chunk) {
        buffer += chunk.toString();
        if (buffer.length > 65536)
          return finish(new Error("Unexpected output from private proxy helper."));
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("KIRO_PROXY_ERROR "))
            return finish(
              new Error(`Private native proxy startup failed (${line.slice(17).trim()}).`),
            );
          if (!line.startsWith("KIRO_PROXY_READY ")) continue;
          const candidate = Number(line.slice(17).trim());
          if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536)
            return finish(null, candidate);
          return finish(new Error("Invalid private proxy readiness response."));
        }
      }
      helper.once("exit", failed);
      helper.once("error", errored);
      helper.stdout.on("data", receive);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      if (!signal?.aborted)
        helper.stdin.write(
          ["KIRO_PROXY_V1", nonce, network.mode, network.proxy ?? "", pacUrl ?? "", ""].join("\n"),
        );
    });
  } catch (error) {
    await close();
    throw error;
  }
  const address = `http://kiro:${nonce}@127.0.0.1:${port}`;
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    childEnv[key] = address;
  childEnv.OMP_INTERNAL_PROXY = address;
  // Abort is intentionally startup-only: Ctrl+C often cancels an OMP turn, not
  // the session. The owner closes us only after the application has exited.
  return {
    env: childEnv,
    diagnostic: `Private per-destination ${network.proxy ? "manual" : network.pacUrl ? "PAC" : "Windows system"} proxy ready; SSPI and strict TLS enabled.`,
    close,
  };
}
