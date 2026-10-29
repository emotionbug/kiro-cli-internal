import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const omittedDependencies = [
  "@agentclientprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@opencode-ai/sdk",
  "@opencode/client", "ai", "openai", "sherpa-onnx-node",
];
const guards = {
  "package.json": "e40a4141f614a71c470308812493b5ad342ff60cf8f01d38f57d38b547a80bd1",
  "dist/server/server/agent/provider-registry.js": "bc5edd6570917a52f4742a74f37000e62dab33efc6f05c94ef70f04df3f700c3",
  "dist/server/server/agent/provider-runtime.js": "73f8d37ea5fb6b95bae4b1c3e6500abf61b38766b609ffb5cb53524fcb5804a9",
  "dist/server/server/bootstrap.js": "ed0cdd546451a3751fa4af18b8f028d2e321849defaee39f5cce0c069171e933",
  "dist/server/server/plugins/builtin/index.js": "d72240bc3f7246f466c3b862961026f7b0220d80c9a30a8d017830484ba6f961",
  "dist/server/server/speech/speech-runtime.js": "9aeced411c7f2c31f7e9780a3baf468c2964da895b2e4bf87b4dd6d17cf06fd0",
};

async function files(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Projection refuses links: ${name}`);
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push({ path: name, bytes: (await lstat(path.join(root, name))).size });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Direct-only boundary changed: ${before}`);
  return source.replace(before, after);
}
function omitLines(source, first, last) {
  return source.split("\n").filter((_, index) => index + 1 < first || index + 1 > last).join("\n");
}
function imports(ts, file, source) {
  const names = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      names.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments.length && ts.isStringLiteral(node.arguments[0]))
      names.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return names;
}

// The public package is immutable input. Line ranges below are anchored by complete
// file SHA-256, not best-effort matches against another Paseo release.
export async function applyPaseoDirectOnly(serverRoot) {
  const originals = new Map();
  for (const [file, expected] of Object.entries(guards)) {
    const bytes = await readFile(path.join(serverRoot, file));
    if (sha256(bytes) !== expected) throw new Error(`Direct-only projection refused changed public input: ${file}`);
    originals.set(file, bytes.toString("utf8"));
  }
  const outputs = new Map();
  const registryFile = "dist/server/server/agent/provider-registry.js";
  let registry = originals.get(registryFile);
  // Remove built-in/derived CLI factories, preserving the actual plugin adapter,
  // model decoration, permission contracts, registry entries, and shutdown logic.
  registry = omitLines(registry, 460, 571);
  registry = omitLines(registry, 141, 151);
  registry = omitLines(registry, 85, 98);
  registry = omitLines(registry, 51, 84);
  registry = omitLines(registry, 23, 50);
  registry = omitLines(registry, 19, 21);
  registry = omitLines(registry, 4, 16);
  registry = replaceOnce(registry, "BUILTIN_PROVIDER_IDS, DEV_AGENT_PROVIDER_DEFINITIONS,", "BUILTIN_PROVIDER_IDS,");
  registry = replaceOnce(registry,
    '    const resolvedProviders = buildResolvedBuiltinProviders(providerOverrides, runtimeSettings, {\n        workspaceGitService: options?.workspaceGitService,\n        managedProcesses: options?.managedProcesses,\n        ompRuntime: options?.ompRuntime,\n        openCodeBridge: options?.openCodeBridge,\n    }, options?.isDev === true);',
    '    const resolvedProviders = new Map();\n    for (const [id, override] of Object.entries(providerOverrides)) {\n        if (override.extends || (BUILTIN_PROVIDER_IDS.includes(id) && override.enabled !== false))\n            throw new Error(`This Kiro HTTP distribution does not include CLI provider ${id}`);\n    }');
  registry = replaceOnce(registry,
    '    addDerivedProviders(resolvedProviders, providerOverrides, {\n        managedProcesses: options?.managedProcesses,\n        openCodeBridge: options?.openCodeBridge,\n    });', "");
  outputs.set(registryFile, registry);
  outputs.set("dist/server/server/agent/provider-runtime.js", `import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
export async function createAgentProviderRuntime(options) {
    const snapshotManager = new ProviderSnapshotManager({
        ...options.snapshotManager,
        logger: options.logger.child({ module: "provider-snapshot-manager" }),
    });
    let shutdownPromise;
    return {
        snapshotManager,
        shutdown: () => shutdownPromise ??= snapshotManager.shutdown(),
    };
}
`);
  const bootstrapFile = "dist/server/server/bootstrap.js";
  let bootstrap = originals.get(bootstrapFile);
  bootstrap = omitLines(bootstrap, 1400, 1402);
  bootstrap = replaceOnce(bootstrap, "        await speechService.stop();\n", "");
  bootstrap = omitLines(bootstrap, 1242, 1247);
  bootstrap = replaceOnce(bootstrap, "daemonAuth, speechService, terminalManager", "daemonAuth, null, terminalManager");
  bootstrap = replaceOnce(bootstrap, "                            setAgentProviderToolsEnabled(mcpEnabled && inject);\n", "");
  bootstrap = replaceOnce(bootstrap, "                            setAgentProviderToolsEnabled(mcpEnabled && value !== false);\n", "");
  bootstrap = omitLines(bootstrap, 1128, 1130);
  bootstrap = replaceOnce(bootstrap, "    setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);\n", "");
  bootstrap = replaceOnce(bootstrap, 'import { createSpeechService } from "./speech/speech-runtime.js";\n', "");
  bootstrap = replaceOnce(bootstrap, "createPaseoToolCatalog, createPaseoAgentToolManifest,", "createPaseoToolCatalog,");
  outputs.set(bootstrapFile, bootstrap);
  const builtinFile = "dist/server/server/plugins/builtin/index.js";
  outputs.set(builtinFile, replaceOnce(originals.get(builtinFile), originals.get(builtinFile).split("\n").slice(3, 17).join("\n"), "export const builtinPlugins = [];"));
  const manifest = JSON.parse(originals.get("package.json"));
  for (const dependency of omittedDependencies) {
    if (!manifest.dependencies[dependency]) throw new Error(`Expected public dependency missing: ${dependency}`);
    delete manifest.dependencies[dependency];
  }
  outputs.set("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const projectedFiles = [];
  for (const [file, text] of outputs) {
    const bytes = Buffer.from(text.replace(/\/\/# sourceMappingURL=[^\n]*\n?/g, ""));
    await writeFile(path.join(serverRoot, file), bytes);
    await rm(path.join(serverRoot, `${file}.map`), { force: true });
    projectedFiles.push({ path: file, originalSha256: guards[file], patchedSha256: sha256(bytes), bytes: bytes.length });
  }

  const removed = [];
  async function remove(file, reason) {
    const bytes = await readFile(path.join(serverRoot, file));
    removed.push({ path: file, bytes: bytes.length, sha256: sha256(bytes), reason });
    await rm(path.join(serverRoot, file));
  }
  await remove("dist/server/server/speech/speech-runtime.js", "Speech service omitted at the existing nullable WebSocket boundary; no background model loading or native speech runtime");
  await rm(path.join(serverRoot, "dist/server/server/speech/speech-runtime.d.ts"), { force: true });
  await rm(path.join(serverRoot, "dist/server/server/speech/speech-runtime.js.map"), { force: true });
  for (const file of await files(path.join(serverRoot, "dist/server/builtin-plugins")))
    await remove(`dist/server/builtin-plugins/${file.path}`, "Unrelated built-in provider/usage plugin omitted with its loader roster");
  await rm(path.join(serverRoot, "dist/server/builtin-plugins"), { recursive: true });

  // Keep every source file outside the two omitted implementation subtrees as a
  // conservative root, then retain all transitive local imports from those roots.
  // Shared diagnostics/provider-runner and speech config/model metadata survive.
  const ts = createRequire(path.join(serverRoot, "package.json"))("typescript");
  const all = (await files(serverRoot)).filter((file) => /\.(?:mjs|cjs|js)$/.test(file.path) && !file.path.startsWith("dist/server/web-ui/"));
  const source = new Map(await Promise.all(all.map(async ({ path: file }) => [file, await readFile(path.join(serverRoot, file), "utf8")])));
  const candidates = (file) => /\/server\/agent\/providers\/|\/server\/speech\/providers\//.test(file);
  const reachable = new Set();
  function retain(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const specifier of imports(ts, file, source.get(file))) {
      if (!specifier.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (source.has(target)) retain(target);
    }
  }
  for (const file of source.keys()) if (!candidates(file)) retain(file);
  for (const file of source.keys()) {
    if (candidates(file) && !reachable.has(file)) {
      await remove(file, "Unreachable provider/speech implementation after native-only projection (TypeScript AST local-import closure)");
      for (const sibling of [`${file}.map`, file.replace(/\.js$/, ".d.ts")])
        await rm(path.join(serverRoot, sibling), { force: true });
      source.delete(file);
    }
  }
  // Some published declarations have no JavaScript companion. They do not
  // participate in runtime imports and must not retain an omitted provider.
  for (const { path: file } of await files(serverRoot)) {
    if (!candidates(file)) continue;
    const runtime = file.endsWith(".d.ts")
      ? file.slice(0, -5) + ".js"
      : file.endsWith(".js.map")
        ? file.slice(0, -4)
        : null;
    if (runtime && !source.has(runtime))
      await remove(file, "Orphan declaration/source map of an omitted provider or speech runtime");
  }
  for (const file of await files(serverRoot)) {
    if (candidates(file.path) && /\.(?:onnx|dll|node|exe|bin|wasm)$/i.test(file.path))
      await remove(file.path, "Unused provider/speech binary asset; implementation omitted");
  }
  for (const [file, text] of source) {
    for (const specifier of imports(ts, file, text)) {
      if (omittedDependencies.some((name) => specifier === name || specifier.startsWith(`${name}/`)))
        throw new Error(`Retained source still imports omitted dependency: ${file}: ${specifier}`);
    }
  }
  return {
    projection: "paseo-0.13.0-native-kiro-http-only",
    scope: "Public npm server only; native plugin adapter and core terminal preserved; CLI provider factories, OpenCode bridge and optional speech service removed",
    speech: "Absent service passed as null through upstream's existing optional speech API; no fake addon/service and no downloads",
    builtinPlugins: [], omittedDependencies, files: projectedFiles,
    removedFiles: removed, removedBytes: removed.reduce((sum, file) => sum + file.bytes, 0),
    obsoleteSourceMapsRemoved: true,
  };
}

export async function pruneProductionClosure(app, lock) {
  const packagePaths = Object.keys(lock.packages).filter(Boolean);
  const installed = new Map();
  for (const relative of packagePaths) {
    try { installed.set(relative, JSON.parse(await readFile(path.join(app, relative, "package.json"), "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const root = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  const retained = new Set();
  function resolve(from, name) {
    let directory = from;
    while (true) {
      const candidate = path.posix.join(directory, "node_modules", name);
      if (installed.has(candidate)) return candidate;
      if (!directory) return null;
      directory = path.posix.dirname(directory);
      if (directory === ".") directory = "";
    }
  }
  function visit(from, manifest) {
    const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
      .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true));
    const dependencies = { ...peers, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      const resolved = resolve(from, name);
      if (!resolved) {
        if (manifest.optionalDependencies?.[name]) continue;
        throw new Error(`Missing production dependency: ${manifest.name}: ${name}`);
      }
      if (retained.has(resolved)) continue;
      retained.add(resolved);
      visit(resolved, installed.get(resolved));
    }
  }
  visit("", root);
  const omitted = [];
  const removable = [...installed.keys()].filter((relative) => !retained.has(relative)).sort((a, b) => b.length - a.length);
  for (const relative of removable) {
    if ([...retained].some((kept) => kept.startsWith(`${relative}/`)))
      throw new Error(`Pruning would remove nested retained dependency: ${relative}`);
    const manifest = installed.get(relative);
    const contents = await files(path.join(app, relative));
    omitted.push({ path: `app/${relative}`, name: manifest.name, version: manifest.version,
      bytes: contents.reduce((sum, file) => sum + file.bytes, 0), files: contents.length,
      integrity: lock.packages[relative].integrity,
      reason: "Outside production dependency closure after hash-guarded native-only server manifest projection" });
    const bins = typeof manifest.bin === "string" ? { [manifest.name.split("/").at(-1)]: manifest.bin } : manifest.bin ?? {};
    const binRoot = path.join(app, relative.slice(0, relative.lastIndexOf("node_modules/") + "node_modules/".length), ".bin");
    for (const name of Object.keys(bins)) for (const suffix of ["", ".cmd", ".ps1"])
      await rm(path.join(binRoot, `${name}${suffix}`), { force: true });
    await rm(path.join(app, relative), { recursive: true });
  }
  // The repository lock is the immutable acquisition recipe. The shipped lock
  // describes only the projected production tree, including its server manifest.
  const originalLockSha256 = sha256(await readFile(path.join(app, "package-lock.json")));
  const projectedLock = structuredClone(lock);
  for (const relative of Object.keys(projectedLock.packages)) {
    if (relative && !retained.has(relative)) delete projectedLock.packages[relative];
  }
  projectedLock.packages["node_modules/@getpaseo/server"].dependencies =
    installed.get("node_modules/@getpaseo/server").dependencies;
  const projectedLockBytes = Buffer.from(`${JSON.stringify(projectedLock, null, 2)}\n`);
  await writeFile(path.join(app, "package-lock.json"), projectedLockBytes);
  // npm's internal install cache is not an independent shipped dependency graph.
  await rm(path.join(app, "node_modules/.package-lock.json"), { force: true });
  return { algorithm: "Installed package manifests; Node ancestor resolution; required+installed optional production dependencies and nonoptional peers; no development roots", retainedPackages: retained.size,
    originalLockSha256, projectedLockSha256: sha256(projectedLockBytes),
    removedPackages: omitted.sort((a, b) => a.path.localeCompare(b.path, "en")),
    removedBytes: omitted.reduce((sum, item) => sum + item.bytes, 0),
    removedFiles: omitted.reduce((sum, item) => sum + item.files, 0),
    measurement: "Actual staged Windows npm tree before removal; excludes separately reported source projections and non-Windows node-pty prebuilds" };
}

export function assertDirectOnlyPayload(files) {
  const forbidden = /(?:^|\/)(?:omp(?:-windows-x64)?|kiro(?:-cli)?|claude(?:-code)?|codex|wezterm(?:-gui|-mux-server)?|opencode|copilot|cursor-agent|pi|traecli|sherpa[^/]*|espeak(?:-ng)?|piper|whisper)(?:\.(?:exe|cmd|bat|com)|$)/i;
  for (const file of files) {
    if (forbidden.test(file.path) || /(?:^|\/)(?:sherpa-onnx[^/]*|@anthropic-ai|@opencode-ai)(?:\/|$)/i.test(file.path))
      throw new Error(`Forbidden non-Kiro-HTTP runtime in payload: ${file.path}`);
  }
  return { rejected: ["OMP", "Kiro CLI", "Claude CLI/SDK", "Codex", "WezTerm", "OpenCode", "other provider CLI", "native voice runtime"], scope: "Every staged path; kiro-proxy.exe is the retained WinHTTP/SSPI helper, not Kiro CLI" };
}
