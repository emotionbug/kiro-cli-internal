import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { projectionEditor, trustedForkSource } from "./paseo-projection-ast.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const omittedDependencies = [
  "@agentclientprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@opencode-ai/sdk",
  "@opencode/client", "ai", "openai", "sherpa-onnx-node",
];
const projectionInputs = [
  "package.json",
  "dist/server/server/agent/provider-registry.js",
  "dist/server/server/agent/provider-runtime.js",
  "dist/server/server/bootstrap.js",
  "dist/server/server/plugins/builtin/index.js",
  "dist/server/server/speech/speech-runtime.js",
];

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
function declaration(ts, node, name) {
  return (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 &&
      node.declarationList.declarations[0].name.getText() === name);
}
function removeImport(ts, editor, specifier) {
  editor.change(`remove import ${specifier}`, (node) => ts.isImportDeclaration(node) &&
    node.moduleSpecifier.text === specifier, "");
}
function removeNamedImport(ts, editor, name) {
  editor.change(`remove imported ${name}`, (node) => ts.isImportDeclaration(node) &&
    node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.some((element) => element.name.text === name),
  (node) => {
    const clause = node.importClause;
    const bindings = ts.factory.updateNamedImports(clause.namedBindings,
      clause.namedBindings.elements.filter((element) => element.name.text !== name));
    return ts.createPrinter().printNode(ts.EmitHint.Unspecified,
      ts.factory.updateImportDeclaration(node, node.modifiers,
        ts.factory.updateImportClause(clause, clause.isTypeOnly, clause.name, bindings),
        node.moduleSpecifier, node.attributes), editor.ast);
  });
}
function callStatement(ts, node, callee) {
  return ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText() === callee;
}

function projectProviderRuntime(ts, file, source) {
  let editor = projectionEditor(ts, file, source);
  removeImport(ts, editor, "./providers/opencode/bridge.js");
  editor.change("OpenCode bridge allocation", (node) => declaration(ts, node, "bridge"), "");
  editor.change("unwrap bridge startup failure boundary", (node) => ts.isTryStatement(node) &&
    ts.isFunctionDeclaration(node.parent.parent) && node.parent.parent.name?.text === "createAgentProviderRuntime",
  (node) => {
    const statements = node.tryBlock.statements;
    if (statements.length !== 4 || statements[0].getText(editor.ast) !== "await bridge.start();")
      throw new Error("Provider runtime bridge startup boundary changed");
    return statements.slice(1).map((statement) => statement.getText(editor.ast)).join("\n");
  });
  editor.change("unwrap bridge shutdown boundary", (node) => ts.isTryStatement(node) &&
    ts.isFunctionDeclaration(node.parent.parent) && node.parent.parent.name?.text === "shutdownProviderRuntime",
  (node) => {
    if (node.tryBlock.statements.length !== 1 ||
        node.tryBlock.statements[0].getText(editor.ast) !== "await snapshotManager.shutdown();")
      throw new Error("Provider snapshot shutdown boundary changed");
    return node.tryBlock.statements[0].getText(editor.ast);
  });
  source = editor.finish();
  editor = projectionEditor(ts, file, source);
  editor.change("snapshot manager without OpenCode bridge", (node) => ts.isObjectLiteralExpression(node) &&
    node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === "openCodeBridge"),
  (node) => ts.createPrinter().printNode(ts.EmitHint.Expression,
    ts.factory.updateObjectLiteralExpression(node, node.properties.filter((property) => property.name?.getText() !== "openCodeBridge")),
    editor.ast));
  editor.change("runtime without OpenCode tool catalog", (node) => ts.isObjectLiteralExpression(node) &&
    node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === "setPaseoToolCatalog"),
  (node) => ts.createPrinter().printNode(ts.EmitHint.Expression,
    ts.factory.updateObjectLiteralExpression(node, node.properties.filter((property) => property.name?.getText() !== "setPaseoToolCatalog")),
    editor.ast));
  source = editor.finish();
  editor = projectionEditor(ts, file, source);
  editor.change("snapshot-only shutdown call", (node) => ts.isCallExpression(node) &&
    node.expression.getText() === "shutdownProviderRuntime" && node.arguments.length === 2 &&
    node.arguments[1].getText() === "bridge", "shutdownProviderRuntime(snapshotManager)");
  editor.change("snapshot-only shutdown signature", (node) => ts.isFunctionDeclaration(node) &&
    node.name?.text === "shutdownProviderRuntime" && node.parameters.length === 2,
  (node) => {
    const updated = ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken,
      node.name, node.typeParameters, [node.parameters[0]], node.type, node.body);
    return ts.createPrinter().printNode(ts.EmitHint.Unspecified, updated, editor.ast);
  });
  return editor.finish();
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

// Compiled boundaries are authenticated by the manifest emitted by the isolated
// pinned-fork source build, not hashes from an unrelated public npm release.
export async function applyPaseoDirectOnly(serverRoot, { fork } = {}) {
  if (fork?.schemaVersion !== 1 || !fork.source || !fork.serverProjectionInputs)
    throw new Error("Native projection requires a complete fork build manifest");
  const forkSource = await trustedForkSource(fork.source);
  const originals = new Map();
  for (const file of projectionInputs) {
    const expected = fork.serverProjectionInputs[file];
    const bytes = await readFile(path.join(serverRoot, file));
    if (!/^[a-f0-9]{64}$/.test(expected ?? "") || sha256(bytes) !== expected)
      throw new Error(`Native projection refused changed fork compiler input: ${file}`);
    originals.set(file, bytes.toString("utf8"));
  }
  const ts = createRequire(path.join(serverRoot, "package.json"))("typescript");
  const outputs = new Map();
  const registryFile = "dist/server/server/agent/provider-registry.js";
  const registry = projectionEditor(ts, registryFile, originals.get(registryFile));
  for (const name of [
    "isNonEmptyStringArray", "PROVIDER_CONTRACTS", "UNSUPPORTED_PROVIDER_CONTRACT",
    "HUB_E2E_PROVIDER_ID", "HUB_E2E_MCP_SERVER", "HUB_E2E_TOOL_NAME", "HUB_E2E_PROVIDER_CONTRACT",
    "PROVIDER_CLIENT_FACTORIES", "getCursorACPCommand", "getProviderClientFactory",
    "createDerivedDefinition", "buildResolvedBuiltinProviders", "addDerivedProviders",
  ]) registry.change(`omit CLI factory ${name}`, (node) => node.parent === registry.ast && declaration(ts, node, name), "");
  registry.change("omit CLI provider imports", (node) => ts.isImportDeclaration(node) &&
    node.moduleSpecifier.text.startsWith("./providers/"), "", 13);
  removeNamedImport(ts, registry, "DEV_AGENT_PROVIDER_DEFINITIONS");
  registry.change("start with native plugin registrations only", (node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.length === 1 &&
    node.declarationList.declarations[0].name.getText() === "resolvedProviders" &&
    ts.isCallExpression(node.declarationList.declarations[0].initializer) &&
    node.declarationList.declarations[0].initializer.expression.getText() === "buildResolvedBuiltinProviders",
  `const resolvedProviders = new Map();
    for (const [id, override] of Object.entries(providerOverrides)) {
        if (override.extends || (BUILTIN_PROVIDER_IDS.includes(id) && override.enabled !== false))
            throw new Error(\`This Kiro HTTP distribution does not include CLI provider \${id}\`);
    }`);
  registry.change("omit derived CLI registration", (node) => callStatement(ts, node, "addDerivedProviders"), "");
  outputs.set(registryFile, registry.finish());
  const runtimeFile = "dist/server/server/agent/provider-runtime.js";
  outputs.set(runtimeFile, projectProviderRuntime(ts, runtimeFile, originals.get(runtimeFile)));

  const bootstrapFile = "dist/server/server/bootstrap.js";
  const bootstrap = projectionEditor(ts, bootstrapFile, originals.get(bootstrapFile));
  removeImport(ts, bootstrap, "./speech/speech-runtime.js");
  removeNamedImport(ts, bootstrap, "createPaseoAgentToolManifest");
  for (const name of ["setAgentProviderToolsEnabled", "speechService"])
    bootstrap.change(`omit optional service ${name}`, (node) => declaration(ts, node, name), "");
  bootstrap.change("omit OpenCode catalog wiring", (node) => callStatement(ts, node, "setAgentProviderToolsEnabled"), "", 3);
  for (const method of ["start", "stop"])
    bootstrap.change(`omit speech ${method}`, (node) => ts.isExpressionStatement(node) &&
      (callStatement(ts, node, `speechService.${method}`) ||
       (ts.isAwaitExpression(node.expression) && ts.isCallExpression(node.expression.expression) &&
        node.expression.expression.expression.getText() === `speechService.${method}`)), "");
  bootstrap.change("omit speech creation log", (node) => callStatement(ts, node, "logger.info") &&
    node.expression.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === "Speech service created"), "");
  bootstrap.change("nullable upstream speech boundary", (node) => ts.isIdentifier(node) && node.text === "speechService" &&
    ts.isNewExpression(node.parent) && node.parent.expression.getText() === "VoiceAssistantWebSocketServer", "null");
  outputs.set(bootstrapFile, bootstrap.finish());

  const builtinFile = "dist/server/server/plugins/builtin/index.js";
  const builtin = projectionEditor(ts, builtinFile, originals.get(builtinFile));
  builtin.change("omit unrelated built-in plugin roster", (node) => ts.isArrayLiteralExpression(node) &&
    ts.isVariableDeclaration(node.parent) && node.parent.name.getText() === "builtinPlugins", "[]");
  outputs.set(builtinFile, builtin.finish());
  const manifest = JSON.parse(originals.get("package.json"));
  for (const dependency of omittedDependencies) {
    if (!manifest.dependencies[dependency]) throw new Error(`Expected fork dependency missing: ${dependency}`);
    delete manifest.dependencies[dependency];
  }
  outputs.set("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const projectedFiles = [];
  for (const [file, text] of outputs) {
    const bytes = Buffer.from(text.replace(/\/\/# sourceMappingURL=[^\n]*\n?/g, ""));
    await writeFile(path.join(serverRoot, file), bytes);
    await rm(path.join(serverRoot, `${file}.map`), { force: true });
    projectedFiles.push({ path: file, originalSha256: fork.serverProjectionInputs[file], patchedSha256: sha256(bytes), bytes: bytes.length });
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
    projection: "paseo-fork-native-kiro-http-only",
    source: forkSource,
    scope: "Pinned user fork server and complete fork UI; native plugin adapter, usage, session-first UI, delayed browser startup, runtime resilience and core terminal retained; CLI factories/OpenCode bridge/optional speech removed",
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
  const forbidden = /(?:^|\/)(?:omp(?:-windows-x64)?|kiro(?:-cli)?|claude(?:-code)?|codex|wezterm(?:-gui|-mux-server)?|opencode|copilot|cursor-agent|pi|traecli|sherpa[^/.]*|espeak(?:-ng)?|piper|whisper)(?:\.(?:exe|cmd|bat|com)|$)/i;
  for (const file of files) {
    if (forbidden.test(file.path) ||
        /(?:^|\/)node_modules\/(?:sherpa-onnx[^/]*|@anthropic-ai|@opencode-ai)(?:\/|$)/i.test(file.path) ||
        /\/server\/speech\/.*\.(?:onnx|dll|node|exe|bin|wasm)$/i.test(file.path))
      throw new Error(`Forbidden non-Kiro-HTTP runtime in payload: ${file.path}`);
  }
  return { rejected: ["OMP", "Kiro CLI", "Claude CLI/SDK", "Codex", "WezTerm", "OpenCode", "other provider CLI", "native voice runtime"], scope: "Every staged path; kiro-proxy.exe is the retained WinHTTP/SSPI helper, not Kiro CLI" };
}
