#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyForkReconnect } from "./paseo-reconnect.mjs";
import { findMetroExport } from "./metro-export.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputs = JSON.parse(await readFile(path.join(repo, "build/inputs.json"), "utf8"));
const pin = inputs.assets.paseoFork;
const source = Object.fromEntries(["repository", "commit", "url", "sha256"].map((key) => [key, pin[key]]));
const workspaces = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const projectionInputs = ["package.json", "dist/server/server/agent/provider-registry.js", "dist/server/server/agent/provider-runtime.js", "dist/server/server/bootstrap.js", "dist/server/server/plugins/builtin/index.js", "dist/server/server/speech/speech-runtime.js"];
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--output", "--cache"].includes(flag) || !value || !path.isAbsolute(value) || options.has(flag))
    throw new Error("Usage: node build/build-paseo-fork.mjs --output <absolute absent directory> [--cache <absolute directory>]");
  options.set(flag, path.resolve(value));
}
const output = options.get("--output");
if (!output) throw new Error("--output is required");
if (process.platform !== "linux" || process.arch !== "x64" || process.versions.node !== inputs.assets.node.version)
  throw new Error(`Fork source compilation requires Linux x64 Node ${inputs.assets.node.version}`);
const cache = options.get("--cache") ?? path.join(repo, ".work/download-cache");
if ([repo, cache].some((directory) => directory === output || directory.startsWith(`${output}${path.sep}`)))
  throw new Error("Output must not contain repository or cache");
try { await lstat(output); throw new Error(`Output already exists: ${output}`); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(cache, { recursive: true });
const work = await mkdtemp(path.join(cache, "paseo-source-"));
const sourceRoot = path.join(work, "source");
const archive = path.join(cache, `paseo-${pin.sha256}.tar.gz`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
Object.assign(env, {
  CI: "true", EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1", PASEO_WEB_PLATFORM: "web",
  PASEO_DIAGNOSTIC_REVISION: pin.commit, SOURCE_DATE_EPOCH: String(inputs.sourceDateEpoch), TZ: "UTC",
  ONNXRUNTIME_NODE_INSTALL: "skip", ELECTRON_SKIP_BINARY_DOWNLOAD: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  NPM_CONFIG_CACHE: path.join(cache, "npm"), NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
  NPM_CONFIG_USERCONFIG: path.join(work, "npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(work, "global-npmrc"),
  PATH: [path.join(sourceRoot, "node_modules/.bin"), process.env.PATH].join(path.delimiter),
});
await writeFile(env.NPM_CONFIG_USERCONFIG, "registry=https://registry.npmjs.org/\nstrict-ssl=true\naudit=false\nfund=false\n");
await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "");
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function run(command, args, { cwd = sourceRoot, capture = false, timeout = 1200000 } = {}) {
  process.stderr.write(`[fork] ${command} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    const chunks = [];
    let bytes = 0;
    let problem;
    const terminate = (error) => {
      problem = error;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") reject(killError); } }
    };
    const timer = setTimeout(() => terminate(new Error(`Fork build command exceeded ${timeout}ms: ${command}`)), timeout);
    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) terminate(new Error("Fork build capture exceeded 16 MiB"));
      else chunks.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (problem || code !== 0) reject(problem ?? new Error(`${command} failed: ${code}`));
      else resolve(capture ? Buffer.concat(chunks).toString("utf8") : "");
    });
  });
}
async function inventory(directory, relative = "") {
  const files = [];
  for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const stat = await lstat(path.join(directory, name));
    if (stat.isDirectory()) files.push(...await inventory(directory, name));
    else if (stat.isFile()) files.push({ path: name, bytes: stat.size, sha256: await digest(path.join(directory, name)) });
    else throw new Error(`Unexpected link or special source/package file: ${name}`);
  }
  return files;
}
async function assertSafeArchive(file, prefix) {
  const members = (await run("tar", ["-tzf", file], { cwd: work, capture: true })).trim().split("\n");
  if (!members.length || members.some((name) => !name.startsWith(`${prefix}/`) || name.includes("\\") || name.split("/").some((part) => part === "..")))
    throw new Error("Unsafe or unexpected fork archive members");
  const types = (await run("tar", ["-tvzf", file], { cwd: work, capture: true })).trim().split("\n");
  if (types.some((line) => !["-", "d"].includes(line[0]))) throw new Error("Fork archive contains links or special files");
}
try {
  try { await access(archive); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(180000), redirect: "follow" });
    if (!response.ok || !response.body || !response.url.startsWith("https://")) throw new Error(`Fork source download failed: ${response.status}`);
    const partial = path.join(work, "source.tar.gz");
    let bytes = 0;
    async function* bounded(chunks) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > 150000000) throw new Error("Fork source archive exceeds 150 MB download bound");
        yield chunk;
      }
    }
    await pipeline(bounded(Readable.fromWeb(response.body)), createWriteStream(partial, { flags: "wx" }));
    if (await digest(partial) !== pin.sha256) throw new Error("Fork source archive SHA-256 mismatch");
    await rename(partial, archive);
  }
  if (await digest(archive) !== pin.sha256) throw new Error("Cached fork source SHA-256 mismatch");
  await assertSafeArchive(archive, `paseo-${pin.commit}`);
  await mkdir(sourceRoot);
  await run("tar", ["-xzf", archive, "--strip-components=1", "-C", sourceRoot], { cwd: work });
  const rootManifest = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  if (rootManifest.version !== pin.version) throw new Error("Fork source version differs from pin");
  const lockFile = path.join(sourceRoot, "package-lock.json");
  const lockSha256 = await digest(lockFile);
  if (lockSha256 !== pin.lockSha256) throw new Error("Fork source npm lock differs from pinned source recipe");
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name || item.link || name.startsWith("packages/") || name === "plugins") continue;
    if (!item.integrity || !item.resolved?.startsWith("https://registry.npmjs.org/")) throw new Error(`Unpinned fork npm input: ${name}`);
  }
  await run("npm", ["ci", "--ignore-scripts", "--include=dev", "--include=optional", "--no-audit", "--no-fund"]);
  // Execute only the pinned fork's trusted patch recipe, not arbitrary dependency hooks.
  await run(process.execPath, ["scripts/postinstall-patches.mjs"]);
  const projection = await applyForkReconnect(sourceRoot);
  await run("npm", ["run", "build:server"]);
  await run("npm", ["run", "build:daemon-web-ui"]);
  const composerQueue = await findMetroExport({ sourceRoot, serverRoot: path.join(sourceRoot, "packages/server"), exportName: "sendQueuedComposerMessageNow" });
  if (await digest(lockFile) !== lockSha256) throw new Error("Fork build modified the immutable npm lock");
  await mkdir(output, { recursive: true });
  const packages = [];
  for (const workspace of workspaces) {
    const directory = path.join(sourceRoot, "packages", workspace);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (manifest.name !== `@getpaseo/${workspace}` || manifest.version !== pin.version) throw new Error(`Unexpected fork workspace: ${workspace}`);
    await copyFile(path.join(sourceRoot, "LICENSE"), path.join(directory, "LICENSE"));
    const packed = JSON.parse(await run("npm", ["pack", "--ignore-scripts", `--workspace=${manifest.name}`, "--json", "--pack-destination", output], { capture: true }));
    if (packed.length !== 1 || path.basename(packed[0].filename) !== packed[0].filename) throw new Error("Unexpected npm pack result");
    const filename = packed[0].filename;
    const extracted = path.join(work, `pack-${workspace}`);
    await assertSafeArchive(path.join(output, filename), "package");
    await mkdir(extracted);
    await run("tar", ["-xzf", path.join(output, filename), "--strip-components=1", "-C", extracted], { cwd: work });
    const files = await inventory(extracted);
    if (files.some((file) => file.path.split("/").some((part) => ["node_modules", ".git"].includes(part)))) throw new Error(`Development/install tree in fork pack: ${workspace}`);
    packages.push({ name: manifest.name, version: manifest.version, filename, sha256: await digest(path.join(output, filename)), files });
  }
  const serverRoot = path.join(work, "pack-server");
  const serverProjectionInputs = Object.fromEntries(await Promise.all(projectionInputs.map(async (relative) => [relative, await digest(path.join(serverRoot, relative))])));
  await access(path.join(serverRoot, "dist/server/web-ui/index.html"));
  await mkdir(path.join(output, "source"));
  const sourceArchive = `source/paseo-${pin.commit}.tar.gz`;
  await copyFile(archive, path.join(output, sourceArchive));
  for (const helper of ["build-paseo-fork.mjs", "paseo-reconnect.mjs", "paseo-direct-only.mjs", "paseo-projection-ast.mjs", "metro-export.mjs", "inputs.json"])
    await copyFile(path.join(repo, "build", helper), path.join(output, "source", helper));
  const sourceFiles = await inventory(path.join(output, "source"));
  const manifest = {
    schemaVersion: 1, source, version: pin.version, packages, serverProjectionInputs,
    sourceProjections: [projection], sourceArchive,
    webUi: { composerQueue },
    compilation: {
      platform: process.platform, arch: process.arch, node: process.versions.node,
      npm: (await run("npm", ["--version"], { capture: true })).trim(),
      typescript: JSON.parse(await readFile(path.join(sourceRoot, "node_modules/typescript/package.json"), "utf8")).version,
      lockSha256, builderSha256: await digest(fileURLToPath(import.meta.url)),
      sourceDateEpoch: inputs.sourceDateEpoch, webPlatform: "web", diagnosticRevision: pin.commit,
      commands: ["npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund", "node scripts/postinstall-patches.mjs", "npm run build:server", "npm run build:daemon-web-ui", "npm pack --ignore-scripts --workspace=<each runtime workspace>"],
      dependencyHooks: false, trustedPatchScriptSha256: await digest(path.join(sourceRoot, "scripts/postinstall-patches.mjs")),
      webUi: "Full fork Expo browser export with gzip/Brotli assets; not public npm UI or Electron",
    },
    sourceFiles,
  };
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, source, packages: packages.map(({ name, filename, sha256 }) => ({ name, filename, sha256 })) }));
} finally {
  await rm(work, { recursive: true, force: true });
}
