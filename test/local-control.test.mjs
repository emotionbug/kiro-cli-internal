import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { runtimeEnv } from "../payload/app/lib/state.mjs";

test("private daemon connections bypass inherited Node environment proxies", async (t) => {
  let proxyRequests = 0;
  const local = http.createServer((_request, response) => response.end("private-daemon"));
  const proxy = http.createServer((_request, response) => {
    proxyRequests++;
    response.end("wrong-proxy");
  });
  for (const server of [local, proxy]) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
  }
  const root = path.join(tmpdir(), "kiro-loopback-fixture");
  const state = {
    root,
    home: path.join(root, "paseo"),
    authFile: path.join(root, "auth.sqlite3"),
    config: { nodeHeapMb: 128 },
  };
  const address = `http://127.0.0.1:${proxy.address().port}`;
  const env = runtimeEnv(state, {
    ...process.env,
    NODE_OPTIONS: "",
    HTTP_PROXY: address,
    HTTPS_PROXY: address,
    ALL_PROXY: address,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
  });
  const url = `http://127.0.0.1:${local.address().port}/private-rpc`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import http from 'node:http'; http.get(${JSON.stringify(url)},response=>{response.pipe(process.stdout);response.on('end',()=>http.globalAgent.destroy());}).on('error',error=>{console.error(error.code);process.exitCode=1;});`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Private daemon probe timed out"));
    }, 10000);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(stderr));
    });
  });
  assert.equal(output, "private-daemon");
  assert.equal(proxyRequests, 0);
});
