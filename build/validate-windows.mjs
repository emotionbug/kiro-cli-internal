// Producer-side native qualification of an assembled bundle on the Windows x64 build host.
// Runs only owned, non-interactive probes against an isolated scratch home; never launches the
// desktop GUI, a daemon, a network request or an installer. Parent smoke covers live sessions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(process.argv[2], "The bundle root is required");
const root = path.resolve(process.argv[2]);
const inputs = JSON.parse(await readFile(new URL("./inputs.json", import.meta.url), "utf8")).assets;
assert.equal(process.platform, "win32", "Native validation must run on Windows");
assert.equal(process.arch, "x64");
assert.equal(process.version, `v${inputs.node.version}`, "Validation must run under the bundled Node");
const app = path.join(root, "app");
const scratch = await mkdtemp(path.join(os.tmpdir(), "kiro-native-qualifier-"));

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
async function peMachine(relative) {
  const handle = await open(path.join(root, relative), "r");
  try {
    const header = Buffer.alloc(4096);
    await handle.read(header, 0, header.length, 0);
    assert.equal(header.toString("ascii", 0, 2), "MZ", `${relative}: not a PE image`);
    const pe = header.readUInt32LE(0x3c);
    assert.ok(pe + 6 <= header.length, `${relative}: PE header outside probe window`);
    assert.equal(header.toString("ascii", pe, pe + 4), "PE\0\0", `${relative}: not a PE image`);
    assert.equal(header.readUInt16LE(pe + 4), 0x8664, `${relative}: x64 required`);
    return "AMD64";
  } finally {
    await handle.close();
  }
}
function execute(relative, args, timeout = 30000) {
  const home = path.join(scratch, "home");
  // Isolated state: no user Paseo/OMP home, config, credentials or sessions are read or written.
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    SystemDrive: process.env.SystemDrive,
    PATH: path.join(process.env.SystemRoot, "System32"),
    TEMP: scratch,
    TMP: scratch,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    PASEO_HOME: path.join(home, ".paseo"),
    PI_CODING_AGENT_DIR: path.join(home, "omp-agent"),
    NO_COLOR: "1",
  };
  const result = spawnSync(path.join(root, relative), args, {
    cwd: scratch,
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${relative} ${args.join(" ")}: ${result.error.message}`);
  assert.equal(result.status, 0, `${relative} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function passessionIdentity(relativeRoot, installationKind) {
  const pin = inputs.passessionDaemon;
  const directory = path.join(root, relativeRoot);
  const runtime = JSON.parse(await readFile(path.join(directory, "paseo-runtime.json"), "utf8"));
  const provenance = JSON.parse(
    await readFile(path.join(directory, "bundle-provenance.json"), "utf8"),
  );
  for (const marker of [runtime, provenance]) {
    assert.equal(marker.version, pin.version, `${relativeRoot}: version`);
    assert.equal(marker.sourceSha, pin.commit, `${relativeRoot}: source commit`);
    assert.equal(marker.platform, "windows");
    assert.equal(marker.arch, "x64");
    assert.equal(marker.runtime, "rust");
    assert.equal(marker.release, true);
    assert.equal(marker.installationKind, installationKind, `${relativeRoot}: installation kind`);
  }
  assert.equal(provenance.repository, "emotionbug/Passession");
  assert.equal(provenance.sourceDirty, false);
  const executable = `${relativeRoot}/paseo.exe`;
  const digest = await sha256(path.join(root, executable));
  assert.equal(digest, provenance.executableSha256, `${executable}: provenance digest`);
  assert.equal(digest, pin.executableSha256, `${executable}: pinned digest`);
  await peMachine(executable);
  const version = execute(executable, ["--version"]);
  assert.equal(version, `paseo ${pin.version}`);
  assert.match(execute(executable, ["--help"]), /\bdaemon\b/);
  return { executable, sha256: digest, installationKind, version };
}

let evidence;
try {
  const daemon = await passessionIdentity("runtime/passession", "standalone-archive");
  const bundledDaemon = await passessionIdentity(
    "runtime/passession-app/runtime",
    "desktop-bundled",
  );
  const descriptor = JSON.parse(
    await readFile(path.join(root, "runtime/passession-app/runtime/desktop-runtime.json"), "utf8"),
  );
  assert.equal(descriptor.executable, "paseo.exe", "Desktop descriptor must name the bundled daemon");
  const desktop = "runtime/passession-app/paseo_sessions.exe";
  await peMachine(desktop);
  for (const entry of await readdir(path.join(root, "runtime/passession-app")))
    assert.ok(
      !/^(?:Uninstall\.exe|\$PLUGINSDIR|\.paseo-sessions-owned-files)$/i.test(entry),
      `Installer-only member shipped: ${entry}`,
    );

  const omp = "runtime/omp/omp.exe";
  await peMachine(omp);
  assert.equal(await sha256(path.join(root, omp)), inputs.omp.sha256);
  const ompVersion = execute(omp, ["--version"]);
  assert.equal(ompVersion, `omp/${inputs.omp.version}`);
  assert.match(execute(omp, ["--help"]), /--print/);

  // Wrapper/auth production dependencies resolve from the materialized app root only.
  const require = createRequire(path.join(app, "package.json"));
  const appManifest = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  const dependencies = Object.keys(appManifest.dependencies).sort();
  for (const name of dependencies) {
    const resolved = require.resolve(name);
    assert.ok(resolved.startsWith(path.join(app, "node_modules")), `${name} resolved outside app`);
    await import(pathToFileURL(resolved));
  }
  const { ProxyAgent } = await import(pathToFileURL(require.resolve("proxy-agent")));
  const { Agent, setGlobalDispatcher } = await import(pathToFileURL(require.resolve("undici")));
  assert.equal(typeof ProxyAgent, "function");
  assert.equal(typeof Agent, "function");
  assert.equal(typeof setGlobalDispatcher, "function");

  // The OMP extension closure: index.js needs host-supplied @oh-my-pi/pi-ai, so Node loads every
  // retained server module that index.js and auth-cli.mjs import.
  const plugin = path.join(app, "plugin/omp-kiro");
  const pluginManifest = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8"));
  assert.equal(pluginManifest.version, inputs.plugin.version);
  assert.deepEqual(pluginManifest.omp?.extensions, ["./index.js"]);
  const pluginModules = (await readdir(path.join(plugin, "server")))
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  for (const name of pluginModules) await import(pathToFileURL(path.join(plugin, "server", name)));
  const { readKiroModelCatalog } = await import(
    pathToFileURL(path.join(plugin, "server/model-catalog.mjs"))
  );
  assert.equal(typeof readKiroModelCatalog, "function");

  evidence = {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    passessionDaemon: daemon,
    passessionAppBundledDaemon: bundledDaemon,
    passessionApp: {
      executable: desktop,
      machine: "AMD64",
      launched: false,
      descriptor: "runtime/passession-app/runtime/desktop-runtime.json",
    },
    omp: { executable: omp, version: ompVersion },
    appDependencies: dependencies,
    pluginModulesLoaded: pluginModules.map((name) => `server/${name}`),
    pluginExtensionHostLoaded: false,
    server2019Verified: false,
    scope:
      "Build host only: PE/x64, pinned digests and provenance markers, isolated --version/--help execution, Node module resolution. Desktop GUI, daemon sessions and OMP extension host loading are covered by Windows smoke, not here.",
  };
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(evidence));
