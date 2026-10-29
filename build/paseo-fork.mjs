import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const workspaceNames = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"].map((name) => `@getpaseo/${name}`);
function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`Unsafe fork artifact path: ${value}`);
  return value;
}
export async function materializePaseoFork({ directory, app, output, repo, work, inputs, lock, extract, tree, digest }) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const pin = inputs.assets.paseoFork;
  if (manifest.schemaVersion !== 1 || manifest.version !== pin.version) throw new Error("Unsupported fork build manifest");
  for (const key of ["repository", "commit", "url", "sha256"])
    if (manifest.source?.[key] !== pin[key]) throw new Error(`Fork source identity mismatch: ${key}`);
  if (manifest.compilation?.lockSha256 !== pin.lockSha256 || manifest.compilation?.node !== inputs.assets.node.version || manifest.compilation?.platform !== "linux" || manifest.compilation?.arch !== "x64" || manifest.compilation?.dependencyHooks !== false)
    throw new Error("Fork compiler/lock provenance differs from the trusted source job");
  if (manifest.compilation.builderSha256 !== await digest(path.join(repo, "build/build-paseo-fork.mjs")))
    throw new Error("Fork artifact was built with a different source builder");
  const archivePath = `source/paseo-${pin.commit}.tar.gz`;
  if (manifest.sourceArchive !== archivePath || await digest(path.join(directory, archivePath)) !== pin.sha256)
    throw new Error("Fork artifact source archive identity mismatch");
  if (!Array.isArray(manifest.sourceFiles)) throw new Error("Missing fork source derivation files");
  for (const file of manifest.sourceFiles) {
    safeRelative(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || await digest(path.join(directory, "source", file.path)) !== file.sha256)
      throw new Error(`Fork source derivation checksum mismatch: ${file.path}`);
  }
  const licenses = path.join(output, "LICENSES");
  await mkdir(path.join(licenses, "sources"), { recursive: true });
  for (const helper of ["build-paseo-fork.mjs", "paseo-reconnect.mjs", "paseo-projection-ast.mjs", "metro-export.mjs", "inputs.json"]) {
    if (await digest(path.join(directory, "source", helper)) !== await digest(path.join(repo, "build", helper)))
      throw new Error(`Fork artifact projection helper changed: ${helper}`);
    await copyFile(path.join(directory, "source", helper), path.join(licenses, "sources", helper));
  }
  // This transform runs only in the authenticated Windows stage, after source
  // compilation. It is not an input to the reusable Linux source artifact.
  await copyFile(path.join(repo, "build/paseo-direct-only.mjs"), path.join(licenses, "sources/paseo-direct-only.mjs"));
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== workspaceNames.length || new Set(manifest.packages.map((item) => item.name)).size !== workspaceNames.length)
    throw new Error("Fork artifact must contain exactly the seven runtime workspace products");
  const overlay = [];
  for (const pkg of manifest.packages) {
    if (!workspaceNames.includes(pkg.name) || pkg.version !== pin.version || path.basename(pkg.filename) !== pkg.filename || !/\.tgz$/.test(pkg.filename) || !/^[a-f0-9]{64}$/.test(pkg.sha256))
      throw new Error(`Invalid fork runtime package: ${pkg.name}`);
    const archive = path.join(directory, pkg.filename);
    if (await digest(archive) !== pkg.sha256) throw new Error(`Fork runtime archive checksum mismatch: ${pkg.name}`);
    const unpacked = path.join(work, `fork-${pkg.name.split("/")[1]}`);
    await extract(archive, unpacked, 1);
    const files = await tree(unpacked);
    if (!Array.isArray(pkg.files) || files.length !== pkg.files.length) throw new Error(`Fork package file inventory differs: ${pkg.name}`);
    const expected = new Map(pkg.files.map((file) => [safeRelative(file.path), file]));
    if (expected.size !== files.length) throw new Error(`Duplicate fork package file: ${pkg.name}`);
    for (const file of files) {
      const bound = expected.get(file.path);
      if (file.path.split("/").some((part) => ["node_modules", ".git"].includes(part)) || !bound || bound.bytes !== file.size || await digest(path.join(unpacked, file.path)) !== bound.sha256)
        throw new Error(`Fork package content differs: ${pkg.name}/${file.path}`);
    }
    const installed = JSON.parse(await readFile(path.join(unpacked, "package.json"), "utf8"));
    if (installed.name !== pkg.name || installed.version !== pkg.version) throw new Error(`Fork package manifest identity differs: ${pkg.name}`);
    const relative = `node_modules/${pkg.name}`;
    const acquisition = lock.packages[relative];
    if (!acquisition || acquisition.version !== pkg.version) throw new Error(`Fork package absent from pinned dependency acquisition base: ${pkg.name}`);
    // Keep Windows-resolved third-party nested dependencies, but replace every byte
    // of the acquired public workspace itself with the same-commit fork product.
    const target = path.join(app, relative);
    const nested = path.join(target, "node_modules");
    const saved = path.join(work, `fork-nested-${pkg.name.split("/")[1]}`);
    let hasNested = false;
    try {
      const stat = await lstat(nested);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unexpected nested dependency object: ${relative}`);
      await rename(nested, saved);
      hasNested = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rm(target, { recursive: true, force: true });
    await rename(unpacked, target);
    if (hasNested) await rename(saved, path.join(target, "node_modules"));
    const fork = { source: manifest.source, filename: pkg.filename, sha256: pkg.sha256 };
    const replacement = { ...acquisition, fork, acquisitionBase: { resolved: acquisition.resolved, integrity: acquisition.integrity } };
    delete replacement.resolved;
    delete replacement.integrity;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "engines"])
      if (installed[field]) replacement[field] = installed[field];
      else delete replacement[field];
    lock.packages[relative] = replacement;
    overlay.push({ path: `app/${relative}`, name: pkg.name, version: pkg.version, source: manifest.source, tarball: pkg.filename, sha256: pkg.sha256, acquisitionBase: replacement.acquisitionBase });
  }
  for (const relative of Object.keys(lock.packages)) {
    const match = relative.match(/(?:^|\/)node_modules\/(@getpaseo\/[^/]+)$/);
    if (match && (!workspaceNames.includes(match[1]) || relative !== `node_modules/${match[1]}`))
      throw new Error(`Unreplaced public fork workspace copy in npm recipe: ${relative}`);
  }
  const server = path.join(app, "node_modules/@getpaseo/server");
  for (const [relative, sha256] of Object.entries(manifest.serverProjectionInputs ?? {})) {
    safeRelative(relative);
    if (await digest(path.join(server, relative)) !== sha256) throw new Error(`Compiled fork projection boundary differs: ${relative}`);
  }
  const composer = manifest.webUi?.composerQueue;
  if (!composer || composer.exportName !== "sendQueuedComposerMessageNow" || !Number.isSafeInteger(composer.moduleId) || composer.moduleId < 0 ||
      !safeRelative(composer.assetPath).startsWith("dist/server/web-ui/") || !/^[a-f0-9]{64}$/.test(composer.assetSha256) ||
      await digest(path.join(server, composer.assetPath)) !== composer.assetSha256)
    throw new Error("Fork browser module metadata does not match the complete staged web UI");
  const semver = createRequire(import.meta.url)(path.join(output, "runtime/node/node_modules/npm/node_modules/semver"));
  const dependencyGraph = await assertForkProductionDependencies(app, lock, semver);
  return { manifest, overlay, dependencyGraph };
}

export async function assertForkProductionDependencies(app, lock, semver) {
  const installed = new Map();
  for (const relative of Object.keys(lock.packages).filter(Boolean)) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(app, relative, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (manifest.version !== lock.packages[relative].version) throw new Error(`Installed dependency differs from immutable recipe: ${relative}`);
    installed.set(relative, manifest);
  }
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
  let requiredEdges = 0;
  let optionalEdges = 0;
  const visited = new Set();
  const visit = (relative, manifest) => {
    if (visited.has(relative)) return;
    visited.add(relative);
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, range] of Object.entries(dependencies)) {
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name) || (Object.hasOwn(manifest.peerDependencies ?? {}, name) && !Object.hasOwn(manifest.dependencies ?? {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true);
      const target = resolve(relative, name);
      if (!target) {
        if (optional) continue;
        throw new Error(`Fork production dependency missing: ${manifest.name}: ${name}@${range}`);
      }
      const actual = installed.get(target);
      if (!semver.validRange(range) || !semver.satisfies(actual.version, range))
        throw new Error(`Fork production dependency incompatible: ${manifest.name}: ${name}@${range} resolves to ${actual.version} at ${target}; update the actual locked acquisition recipe`);
      if (optional) optionalEdges++; else requiredEdges++;
      visit(target, actual);
    }
  };
  const root = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  visit("", root);
  return { algorithm: "Actual Windows installed package manifests and Node ancestor resolution; semver-satisfying required, installed optional and peer dependencies", phase: "Full fork workspace overlay before direct-only source projection", recipeOverrides: root.overrides ?? {}, packages: visited.size - 1, requiredEdges, optionalEdges, allRangesSatisfied: true };
}
