import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
assert.equal(process.platform, "win32", "Native validation must run on Windows");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v22.23.4");
assert.equal(process.versions.modules, "127");
const app = path.join(root, "app");
const require = createRequire(path.join(app, "package.json"));
const esbuild = require("esbuild");
assert.match(esbuild.transformSync("const value: number = 1", { loader: "ts" }).code, /value/);
require("sherpa-onnx-node");
require("undici");
require("proxy-agent");
require("@getpaseo/plugin/server");
const pty = require("node-pty");
await new Promise((resolve, reject) => {
  const child = pty.spawn(process.execPath, ["-e", 'console.log("KIRO_PTY_MATERIALIZED")'], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: app,
    env: process.env,
  });
  let output = "";
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("node-pty spawn timed out"));
  }, 15000);
  child.onData((data) => {
    output += data;
  });
  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode !== 0 || !output.includes("KIRO_PTY_MATERIALIZED"))
      reject(new Error("node-pty Windows spawn did not complete"));
    else resolve();
  });
});
const serverRoot = path.join(app, "node_modules", "@getpaseo", "server");
const compiler = await import(
  pathToFileURL(path.join(serverRoot, "dist/server/server/plugins/compiler.js"))
);
const pluginRoot = path.join(app, "plugin/omp-kiro");
const compiled = await compiler.compilePlugin({ server: path.join(pluginRoot, "index.server.ts") });
assert.ok(compiled.serverBundle?.length, "Kiro native plugin did not compile");
const builtinRoot = path.join(serverRoot, "dist/server/builtin-plugins");
let builtinCount = 0;
for (const entry of await readdir(builtinRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(
    await readFile(path.join(builtinRoot, entry.name, "paseo-plugin.json"), "utf8"),
  );
  // Published built-ins use conventional entry names, resolved like the server plugin loader.
  const entries = await readdir(path.join(builtinRoot, entry.name));
  const server = entries.includes("index.server.ts")
    ? path.join(builtinRoot, entry.name, "index.server.ts")
    : undefined;
  if (server) {
    assert.ok(
      (await compiler.compilePlugin({ server })).serverBundle?.length,
      `Built-in ${manifest.id} did not compile`,
    );
    builtinCount++;
  }
}
assert.ok(builtinCount > 0, "Published built-in plugin resources missing");
assert.match(
  await readFile(path.join(serverRoot, "dist/server/web-ui/index.html"), "utf8"),
  /html/i,
);
console.log(
  JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    nodeABI: process.versions.modules,
    nodePty: "published win32-x64 N-API prebuild loaded and spawned bundled Node",
    sherpa: "published win32-x64 addon and DLLs loaded; speech models not downloaded or exercised",
    esbuild: esbuild.version,
    pluginCompilation: true,
    builtinPluginCompilations: builtinCount,
    server2019Verified: false,
  }),
);
