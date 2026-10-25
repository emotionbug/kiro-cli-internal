#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { writeZip } from "./archive.mjs";
import { assembleUtilities } from "./assemble-utilities.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputs = JSON.parse(await readFile(path.join(repo, "build/inputs.json"), "utf8"));
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!["--output", "--cache"].includes(flag) || !process.argv[i + 1] || options.has(flag)) {
    throw new Error(
      "Usage: node build/build-bundle.mjs --output <absolute absent root> [--cache <absolute directory>]",
    );
  }
  if (!path.isAbsolute(process.argv[i + 1])) throw new Error(`${flag} must be absolute`);
  options.set(flag, path.resolve(process.argv[i + 1]));
}
const output = options.get("--output");
if (!output) throw new Error("--output is required");
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    "A complete bundle must be built on Windows x64: published Windows native addons must load and node-pty must spawn under bundled Node 22.23.4. Linux preparation is not native validation.",
  );
}
const cache = options.get("--cache") ?? path.join(repo, ".work/download-cache");
const zipPath = `${output}.zip`;
for (const target of [output, zipPath, `${zipPath}.sha256`]) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Refusing to replace existing build output: ${target}`);
}
if (
  cache === output ||
  cache.startsWith(`${output}${path.sep}`) ||
  repo === output ||
  repo.startsWith(`${output}${path.sep}`)
) {
  throw new Error("Output must not contain the repository or download cache");
}
await mkdir(cache, { recursive: true });
await mkdir(path.dirname(output), { recursive: true });
const work = await mkdtemp(path.join(cache, "assemble-"));
const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

async function digest(file, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function run(command, args, { cwd = work, env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "",
      stderr = "";
    if (capture) {
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
    }
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              `${path.basename(command)} failed (${code})${capture ? `\n${stderr}\n${stdout}` : ""}`,
            ),
          ),
    );
  });
}
async function acquire(name) {
  const spec = inputs.assets[name];
  if (!/^https:\/\//.test(spec.url) || !/^[a-f0-9]{64}$/.test(spec.sha256))
    throw new Error(`Unpinned input: ${name}`);
  const extension =
    new URL(spec.url).pathname.match(/(\.tar\.gz|\.7z\.exe|\.zip|\.exe)$/)?.[1] ?? ".asset";
  const destination = path.join(cache, `${name}-${spec.sha256}${extension}`);
  if (await exists(destination)) {
    if ((await digest(destination)) !== spec.sha256)
      throw new Error(`Corrupt cached ${name}; remove ${destination} and retry`);
    return destination;
  }
  const partial = path.join(work, `${name}${extension}`);
  const response = await fetch(spec.url, {
    signal: AbortSignal.timeout(600000),
    redirect: "follow",
  });
  if (!response.ok || !response.body)
    throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
  if (!response.url.startsWith("https://")) throw new Error(`Non-HTTPS redirect for ${name}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
  if ((await digest(partial)) !== spec.sha256)
    throw new Error(`SHA-256 mismatch downloading ${name}`);
  await rename(partial, destination);
  return destination;
}
async function tree(directory, relative = "") {
  const result = [];
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const stat = await lstat(path.join(directory, name));
    if (stat.isSymbolicLink()) throw new Error(`Symlinks/junctions are not distributable: ${name}`);
    if (stat.isDirectory()) result.push(...(await tree(directory, name)));
    else if (stat.isFile()) result.push({ path: name, size: stat.size });
    else throw new Error(`Unsupported filesystem object: ${name}`);
  }
  return relative
    ? result
    : result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
async function copyTree(source, destination, include = () => true) {
  for (const file of await tree(source)) {
    if (!include(file.path)) continue;
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, file.path), target);
  }
}
async function extract(archive, destination, strip = 0, include) {
  await mkdir(destination, { recursive: true });
  const members = (await run(systemTar, ["-tf", archive], { capture: true }))
    .split(/\r?\n/)
    .filter(Boolean);
  for (const member of members) {
    const normalized = member.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").includes("..")
    )
      throw new Error(`Unsafe archive member: ${member}`);
  }
  let selection = [];
  if (include) {
    const selected = members.filter((member) => !member.endsWith("/") && include(member));
    if (!selected.length)
      throw new Error("Required source notices are absent from the pinned archive");
    const list = path.join(work, "archive-selection.txt");
    await writeFile(list, `${selected.join("\n")}\n`);
    selection = ["-T", list];
  }
  await run(systemTar, [
    "-xf",
    archive,
    "-C",
    destination,
    ...(strip ? ["--strip-components", String(strip)] : []),
    ...selection,
  ]);
  await tree(destination); // Reject every link, including links that point inside the tree.
}
async function assertFile(relative) {
  const stat = await lstat(path.join(output, relative)).catch(() => {
    throw new Error(`Required production payload missing: ${relative}`);
  });
  if (!stat.isFile() || !stat.size)
    throw new Error(`Required production payload empty: ${relative}`);
}
async function guardPayload(source) {
  for (const file of await tree(source)) {
    if (
      file.path
        .split("/")
        .some((part) =>
          /^(node_modules|\.git|\.work|\.env(?:\..*)?|auth\.json|credentials[^/]*|[^/]*\.sqlite(?:3)?|[^/]*\.db)$/i.test(
            part,
          ),
        )
    ) {
      throw new Error(`Private/generated content in source payload: ${file.path}`);
    }
    if (/\.(?:json|mjs|js|ts|cmd|ps1|lua)$/i.test(file.path)) {
      const text = await readFile(path.join(source, file.path), "utf8");
      if (/"(?:accessToken|refreshToken|clientSecret|password)"\s*:\s*"[^"\s][^"]*"/i.test(text))
        throw new Error(`Literal credential in source payload: ${file.path}`);
      if (text.includes(repo) || text.includes(os.homedir()))
        throw new Error(`Build-machine path in source payload: ${file.path}`);
    }
  }
}

try {
  const payload = path.join(repo, "payload");
  await guardPayload(payload);
  await mkdir(output);
  await copyTree(payload, output);
  const acquired = {};
  for (const name of Object.keys(inputs.assets)) acquired[name] = await acquire(name);
  const nodeExtract = path.join(work, "node");
  await extract(acquired.node, nodeExtract, 1);
  await copyTree(nodeExtract, path.join(output, "runtime/node"));
  await mkdir(path.join(output, "runtime/omp"), { recursive: true });
  await copyFile(acquired.omp, path.join(output, "runtime/omp/omp.exe"));
  const gitRoot = path.join(output, "runtime/git");
  await mkdir(gitRoot, { recursive: true });
  await run(acquired.git, ["-y", `-o${gitRoot}`]);
  const utilities = await assembleUtilities({
    output,
    work,
    acquired,
    inputs,
    extract,
    tree,
    run,
    digest,
    json,
  });
  const proxyRoot = path.join(output, "runtime/proxy");
  await mkdir(proxyRoot, { recursive: true });
  const nativeSource = path.join(repo, "native/kiro-proxy.cpp");
  const nativeFlags = [
    "/nologo",
    "/std:c++17",
    "/O2",
    "/MT",
    "/EHsc",
    "/W4",
    "/DUNICODE",
    "/D_UNICODE",
    "/DWIN32_LEAN_AND_MEAN",
    "/D_WIN32_WINNT=0x0A00",
  ];
  await run("cl.exe", [
    ...nativeFlags,
    nativeSource,
    `/Fo${path.join(work, "kiro-proxy.obj")}`,
    `/Fe${path.join(proxyRoot, "kiro-proxy.exe")}`,
    "/link",
    "/SUBSYSTEM:CONSOLE",
    "/STACK:262144",
    "ws2_32.lib",
    "winhttp.lib",
    "secur32.lib",
    "bcrypt.lib",
  ]);
  const nativeExecutable = path.join(proxyRoot, "kiro-proxy.exe");
  const dependents = await run("dumpbin.exe", ["/nologo", "/dependents", nativeExecutable], {
    capture: true,
  });
  const importedDlls = [...dependents.matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gim)]
    .map((match) => match[1])
    .sort();
  const allowedDlls = new Set([
    "kernel32.dll",
    "ws2_32.dll",
    "winhttp.dll",
    "secur32.dll",
    "bcrypt.dll",
    "advapi32.dll",
  ]);
  if (!importedDlls.length || importedDlls.some((name) => !allowedDlls.has(name.toLowerCase())))
    throw new Error(`Native helper imports a non-approved OS library: ${importedDlls.join(", ")}`);
  const imports = await run("dumpbin.exe", ["/nologo", "/imports", nativeExecutable], {
    capture: true,
  });
  const importedApis = [
    ...new Set(
      [...imports.matchAll(/^\s+[0-9A-F]+\s+([A-Za-z_?][^\s]+)\s*$/gim)].map((match) => match[1]),
    ),
  ].sort();
  if (
    !importedApis.includes("WinHttpGetProxyForUrl") ||
    !importedApis.includes("InitializeSecurityContextW")
  )
    throw new Error("Compiled helper does not import the required WinHTTP/SSPI APIs");
  const post17763 =
    /^(?:GetProcAddress2|GetTempPath2[AW]|GetSystemCpuSetInformationEx|SetProcessDefaultCpuSetMasks|GetProcessDefaultCpuSetMasks|SetThreadSelectedCpuSetMasks|GetThreadSelectedCpuSetMasks)$/;
  if (importedApis.some((name) => post17763.test(name)))
    throw new Error("Compiled helper statically imports an API newer than Server 2019");
  const nativeImports = {
    importedDlls,
    importedApis,
    staticRuntimeVerified: true,
    knownPost17763StaticImportsRejected: true,
    scope:
      "Direct imports only; source API review and actual Server 2019 execution remain distinct requirements",
  };
  const terminalExtract = path.join(work, "terminal");
  await extract(acquired.wezterm, terminalExtract);
  const terminalEntries = (await tree(terminalExtract)).filter((file) =>
    /(^|\/)wezterm-gui\.exe$/i.test(file.path),
  );
  if (terminalEntries.length !== 1)
    throw new Error("Official WezTerm ZIP must contain exactly one GUI executable");
  const terminalRoot = path.dirname(path.join(terminalExtract, terminalEntries[0].path));
  await copyTree(
    terminalRoot,
    path.join(output, "runtime/terminal"),
    (name) => !/(^|\/)(mesa|wezterm\.lua)(\/|$)/i.test(name) && !/\.pdb$/i.test(name),
  );
  const terminalLicenses = path.join(output, "runtime/terminal/licenses");
  await extract(acquired.weztermSource, terminalLicenses, 1, (name) =>
    /(^|\/)(?:licenses?\/|(?:licenses?[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|ofl[^/]*)$)/i.test(
      name,
    ),
  );
  if (
    !(await exists(path.join(terminalLicenses, "LICENSE.md"))) ||
    !(await exists(path.join(terminalLicenses, "licenses/ANGLE.md")))
  )
    throw new Error("WezTerm MIT/ANGLE notices are missing from the pinned source");
  await writeFile(
    path.join(output, "runtime/terminal/wezterm.lua"),
    `local wezterm = require 'wezterm'\nreturn {\n  front_end = 'Software', max_fps = 30, animation_fps = 1,\n  scrollback_lines = 3000, check_for_updates = false, font_size = 11,\n  default_prog = {'cmd.exe', '/d', '/c', wezterm.config_dir .. '/../../omp.cmd'},\n  exit_behavior = 'CloseOnCleanExit',\n}\n`,
  );
  const source = path.join(work, "plugin");
  await extract(acquired.plugin, source, 1);
  const plugin = path.join(output, "app/plugin/omp-kiro");
  const published = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  if (published.version !== inputs.assets.plugin.version)
    throw new Error("Plugin source version does not match pin");
  await copyTree(source, plugin, (name) =>
    /^(server\/|docs\/|index\.js$|index\.server\.ts$|icon\.svg$|LICENSE$|README\.md$|[^/]+\.mjs$)/.test(
      name,
    ),
  );
  const {
    scripts,
    devDependencies,
    peerDependencies,
    peerDependenciesMeta,
    ...productionManifest
  } = published;
  await json(path.join(plugin, "package.json"), productionManifest);
  const pluginManifest = JSON.parse(await readFile(path.join(source, "paseo-plugin.json"), "utf8"));
  delete pluginManifest.build;
  await json(path.join(plugin, "paseo-plugin.json"), pluginManifest);
  await json(path.join(plugin, "BUNDLE-PROJECTION.json"), {
    upstream: inputs.assets.plugin,
    modifications: [
      "package.json: removed development/scripts/optional host-peer installation metadata; production dependencies resolve from app/node_modules",
      "paseo-plugin.json: removed npm ci build step because production dependencies are already assembled",
    ],
    originalPackageManifest: published,
    originalPluginManifest: JSON.parse(
      await readFile(path.join(source, "paseo-plugin.json"), "utf8"),
    ),
  });
  const app = path.join(output, "app");
  const lock = JSON.parse(await readFile(path.join(app, "package-lock.json"), "utf8"));
  for (const [name, item] of Object.entries(lock.packages)) {
    if (name && (!item.integrity || !item.resolved?.startsWith("https://registry.npmjs.org/")))
      throw new Error(`Unpinned/non-public npm input: ${name}`);
  }
  const node = path.join(output, "runtime/node/node.exe");
  const npm = path.join(output, "runtime/node/node_modules/npm/bin/npm-cli.js");
  const env = {
    ...process.env,
    PATH: [
      path.dirname(node),
      path.join(gitRoot, "cmd"),
      path.join(gitRoot, "bin"),
      path.join(output, "runtime/python"),
      path.join(output, "runtime/tools"),
      process.env.PATH,
    ].join(path.delimiter),
  };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  await writeFile(
    path.join(work, "npmrc"),
    "registry=https://registry.npmjs.org/\nstrict-ssl=true\naudit=false\nfund=false\n",
  );
  await writeFile(path.join(work, "global-npmrc"), "");
  Object.assign(env, {
    NPM_CONFIG_USERCONFIG: path.join(work, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(work, "global-npmrc"),
  });
  await run(
    node,
    [
      npm,
      "ci",
      "--omit=dev",
      "--include=optional",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--install-strategy=hoisted",
      "--cache",
      path.join(cache, "npm"),
    ],
    { cwd: app, env },
  );
  const ptyPrebuilds = path.join(app, "node_modules/node-pty/prebuilds");
  for (const entry of await readdir(ptyPrebuilds)) {
    if (entry !== "win32-x64")
      await rm(path.join(ptyPrebuilds, entry), { recursive: true, force: true });
  }
  // Exact npm tarballs already contain N-API node-pty prebuilds, esbuild.exe and sherpa DLLs.
  // No install hooks, node-gyp, downloads or compiler toolchain are needed at runtime.
  for (const relative of [
    "start.cmd",
    "omp.cmd",
    "auth.cmd",
    "stop.cmd",
    "doctor.cmd",
    "app/lib/run.mjs",
    "runtime/node/node.exe",
    "runtime/omp/omp.exe",
    "runtime/git/bin/bash.exe",
    "runtime/git/cmd/git.exe",
    "runtime/proxy/kiro-proxy.exe",
    "runtime/terminal/wezterm-gui.exe",
    "app/node_modules/node-pty/prebuilds/win32-x64/conpty.node",
    "app/node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node",
    "app/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
    "app/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
    "app/node_modules/@esbuild/win32-x64/esbuild.exe",
    "app/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node",
    "app/node_modules/sherpa-onnx-win-x64/onnxruntime.dll",
    "app/node_modules/@types/node/index.d.ts",
    "app/node_modules/@getpaseo/plugin/dist/server/index.d.ts",
    "app/node_modules/@getpaseo/server/dist/server/web-ui/index.html",
  ])
    await assertFile(relative);
  const probeEnv = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: work,
    TMP: work,
    USERPROFILE: work,
    LOCALAPPDATA: work,
    APPDATA: work,
    PATH: env.PATH,
  };
  const validationText = await run(node, [path.join(repo, "build/validate-windows.mjs"), output], {
    cwd: app,
    env: probeEnv,
    capture: true,
  });
  const validation = JSON.parse(validationText.trim().split(/\r?\n/).at(-1));
  const proxyValidationText = await run(
    node,
    [path.join(repo, "build/probe-native-proxy.mjs"), output],
    { cwd: app, env: probeEnv, capture: true },
  );
  const proxyValidation = JSON.parse(proxyValidationText.trim().split(/\r?\n/).at(-1));
  await run(path.join(gitRoot, "cmd/git.exe"), ["--version"], { env: probeEnv, capture: true });
  await run(
    path.join(gitRoot, "bin/bash.exe"),
    ["--noprofile", "--norc", "-c", "printf KIRO_BASH_READY"],
    { env: probeEnv, capture: true },
  );
  // Only safe structured validation evidence is shipped; temporary compiler results stay in work.
  const licenses = path.join(output, "LICENSES");
  await mkdir(path.join(licenses, "sources"), { recursive: true });
  for (const [name, destination] of Object.entries({
    ompLicense: "OMP-LICENSE.txt",
    ompNotices: "OMP-THIRD-PARTY-NOTICES.txt",
    paseoLicense: "PASEO-LICENSE.txt",
    sherpaLicense: "SHERPA-ONNX-LICENSE.txt",
    gitSource: "sources/mingw-w64-git-2.56.0.3-1.src.tar.gz",
  }))
    await copyFile(acquired[name], path.join(licenses, destination));
  for (const [name, destination] of Object.entries({
    onnxLicense: "ONNXRUNTIME-LICENSE.txt",
    onnxNotices: "ONNXRUNTIME-THIRD-PARTY-NOTICES.txt",
  }))
    await copyFile(acquired[name], path.join(licenses, destination));
  await copyFile(
    path.join(output, "runtime/node/LICENSE"),
    path.join(licenses, "NODE-LICENSE.txt"),
  );
  await copyFile(path.join(plugin, "LICENSE"), path.join(licenses, "OMP-KIRO-LICENSE.txt"));
  await writeFile(
    path.join(licenses, "SOURCE-AVAILABILITY.txt"),
    "Git for Windows is redistributed as its complete, unmodified PortableGit distribution; its licenses and third-party notices remain under runtime/git. The upstream Git source package is included in LICENSES/sources. Additional bundled MSYS2 component source packages and build recipes are available from https://gitforwindows.org/third-party.html and https://github.com/git-for-windows/MSYS2-packages and https://github.com/git-for-windows/MINGW-packages . Preserve these notices when redistributing.\nNode.js LICENSE contains its third-party notices. npm package licenses remain with each installed package; NPM-PACKAGES.json records exact public integrity pins. WezTerm component licenses remain under runtime/terminal. The native WinHTTP/SSPI helper is compiled from the accompanying repository source with a statically linked MSVC runtime; no Python, Px, runtime compiler or redistributable installer is required.\n",
  );
  await copyFile(nativeSource, path.join(licenses, "sources/kiro-proxy.cpp"));
  await json(path.join(licenses, "NATIVE-PROXY-BUILD.json"), {
    source: "sources/kiro-proxy.cpp",
    sourceSha256: await digest(nativeSource),
    compiler: "MSVC cl.exe on Windows build host",
    flags: nativeFlags,
    linkerFlags: ["/SUBSYSTEM:CONSOLE", "/STACK:262144"],
    libraries: ["ws2_32.lib", "winhttp.lib", "secur32.lib", "bcrypt.lib"],
    runtime: "static /MT; no VC redistributable installer",
    windowsApiTarget: "Windows 10 / Server 2019; actual Server 2019 execution unverified",
  });
  await json(path.join(licenses, "NATIVE-PROXY-IMPORTS.json"), nativeImports);
  await json(path.join(output, "native-proxy-validation.json"), proxyValidation);
  const packages = [];
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name || !(await exists(path.join(app, name, "package.json")))) continue;
    const installed = JSON.parse(await readFile(path.join(app, name, "package.json"), "utf8"));
    if (installed.version !== item.version)
      throw new Error(`Installed package differs from lock: ${name}`);
    packages.push({
      path: `app/${name}`,
      name: installed.name,
      version: item.version,
      url: item.resolved,
      integrity: item.integrity,
      license:
        installed.license ??
        item.license ??
        (installed.name?.startsWith("@getpaseo/")
          ? "Apache-2.0 (LICENSES/PASEO-LICENSE.txt)"
          : "See package notices"),
    });
  }
  await json(path.join(licenses, "NPM-PACKAGES.json"), packages);
  await json(path.join(licenses, "DOWNLOAD-INPUTS.json"), inputs);
  await json(path.join(licenses, "PASEO-PROVENANCE.json"), {
    version: "0.13.0",
    commit: inputs.assets.paseoLicense.commit,
    tarball: lock.packages["node_modules/@getpaseo/server"],
    publishedWebUi: true,
    builtinPluginsPreserved: true,
  });
  const files = await tree(output);
  for (const file of files) file.sha256 = await digest(path.join(output, file.path));
  const pythonInterpreterFiles = files
    .filter((file) =>
      /(^|\/)(?:(?:msys-|lib)?python(?:w|[\d.-]+)?|pypy[\dw.-]*)\.(?:exe|dll)$/i.test(file.path),
    )
    .map((file) => ({
      ...file,
      component: file.path.startsWith("runtime/python/")
        ? "Pinned CPython standard-library utility runtime"
        : file.path.startsWith("runtime/git/")
          ? "Complete pinned PortableGit distribution"
          : "Other pinned payload component; inspect its recorded path and package notices",
      retentionReason: file.path.startsWith("runtime/python/")
        ? "On-demand portable utilities; official native files retained with isolated UTF-8 stream configuration and unmodified python3.exe alias."
        : file.path.startsWith("runtime/git/")
          ? "Preserved unmodified with PortableGit rather than silently changing Git behavior. Packaged proxy/auth do not require Python; invocation by other Git functionality is not asserted."
          : "Reported, not blindly deleted: this inventory is not a blanket interpreter ban.",
    }));
  const manifest = {
    schemaVersion: 1,
    target: inputs.target,
    sourceDateEpoch: inputs.sourceDateEpoch,
    archive: {
      format: "ZIP",
      root: ".",
      filename: path.basename(zipPath),
      checksum: `${path.basename(zipPath)}.sha256`,
      ordering: "ordinal path lexical",
      timestamps: "fixed sourceDateEpoch",
      compression: "deflate level 6",
    },
    inputs: inputs.assets,
    npmLockSha256: await digest(path.join(app, "package-lock.json")),
    nativeValidation: {
      ...validation,
      windowsRelease: os.release(),
      scope: "Build host only. This is not Server 2019/build 17763 execution evidence.",
    },
    utilities,
    proxy: {
      backend: "winhttp-sspi",
      executable: "runtime/proxy/kiro-proxy.exe",
      frameworkVm: false,
      python: false,
      localAuthentication:
        "per-launch random nonce over owner stdin; never command line or upstream",
      budgets: {
        workers: 8,
        pendingConnections: 16,
        duplexBufferBytesPerDirection: 16384,
        routeEntries: 32,
        stackReserveBytesPerThread: 262144,
        idleWarmPrivateBytes: 33554432,
        idleWarmWorkingSetBytes: 33554432,
      },
      validation: proxyValidation,
    },
    compatibility: {
      intended: "Windows x64 / Server 2019 build 17763",
      server2019Verified: false,
      minimumOsFromRuntimeExecution: null,
      noFakeNativeDlls: true,
      browser:
        "User-supplied approved current Microsoft Edge or Chrome; no browser or Electron bundled",
      speechModels: "Not bundled. Local speech must stay disabled for offline startup.",
    },
    componentInventory: {
      pythonInterpreterFiles,
      scope:
        "Conventional Python/PyPy EXE/DLL names across every staged file; not proof against an embedded or renamed interpreter. Complete paths and hashes remain in files. No package-wide Python-free claim is made.",
    },
    privacy: {
      userDataIncluded: false,
      sourcePayloadGuard: true,
      linksAllowed: false,
      sourceProjection:
        "Only explicitly pinned public archives plus repository payload; no host installations or user configuration copied",
    },
    files,
    manifestSelfHash:
      "Excluded to avoid recursion; the ZIP SHA-256 authenticates this manifest too.",
  };
  await json(path.join(output, "bundle-manifest.json"), manifest);
  const archiveFiles = await tree(output);
  await writeZip(output, archiveFiles, zipPath, inputs.sourceDateEpoch);
  const sha256 = await digest(zipPath);
  await writeFile(`${zipPath}.sha256`, `${sha256}  ${path.basename(zipPath)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({
      root: output,
      zip: zipPath,
      checksum: `${zipPath}.sha256`,
      sha256,
      files: archiveFiles.length,
      target: inputs.target,
      server2019Verified: false,
      pythonInterpreterFiles: pythonInterpreterFiles.map((file) => file.path),
    }),
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
