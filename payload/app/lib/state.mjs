import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const bundleRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const pluginRoot = path.join(bundleRoot, "app/plugin/omp-kiro");
export const pluginPin = "ea833ca287082fdb17ec709db3d48834189a1054";
export const profileId = "kiro-omp-http";

export async function json(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
export async function save(file, value, expected) {
  const original =
    expected === undefined
      ? undefined
      : await readFile(file, "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
  if (expected !== undefined && original !== expected)
    throw new Error(
      "Configuration changed concurrently; no overwrite performed. Rerun the command.",
    );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    if (expected !== undefined) {
      const latest = await readFile(file, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (latest !== expected)
        throw new Error(
          "Configuration changed concurrently; no overwrite performed. Rerun the command.",
        );
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: "pipe", ...options });
    let stdout = "",
      stderr = "",
      bytes = 0,
      overflow = false;
    const collect = (data, error) => {
      bytes += data.length;
      if (bytes > 1024 * 1024) {
        overflow = true;
        child.kill();
        return;
      }
      if (error) stderr += data;
      else stdout += data;
    };
    child.stdout?.on("data", (data) => collect(data, false));
    child.stderr?.on("data", (data) => collect(data, true));
    child.once("error", reject);
    child.once("close", (code) =>
      overflow
        ? reject(new Error(`${path.basename(executable)} output exceeded 1 MiB.`))
        : code === 0
          ? resolve(stdout)
          : reject(new Error(`${path.basename(executable)} failed (${code}). ${stderr.trim()}`)),
    );
  });
}
export async function initialize(dataDir) {
  if (dataDir !== undefined && !path.isAbsolute(dataDir))
    throw new Error("--data-dir must be absolute.");
  const root = path.resolve(
    dataDir ??
      (process.platform === "win32"
        ? path.join(
            process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData/Local"),
            "KiroInternal",
          )
        : path.join(homedir(), ".local/share/kiro-internal")),
  );
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  if (root === path.parse(root).root || contains(bundleRoot, root))
    throw new Error("User data must use a dedicated directory outside the portable bundle.");
  // Check every existing component before mkdir: a junction in an ancestor must
  // not redirect private state into the bundle or an unrelated directory.
  for (let component = root; ; component = path.dirname(component)) {
    const info = await lstat(component).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new Error("User data path cannot contain a symbolic link, junction or non-directory.");
    if (component === path.dirname(component)) break;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const canonicalBundle = await realpath(bundleRoot);
  if (contains(canonicalBundle, canonical) || (await lstat(root)).isSymbolicLink())
    throw new Error("User data must use a real directory outside the portable bundle.");
  const marker = path.join(root, "portable-state.json");
  const before = await lstat(marker).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before && (!before.isFile() || before.isSymbolicLink()))
    throw new Error("User data marker must be a regular file.");
  if (!before && (await readdir(root)).length)
    throw new Error(
      "Refusing to adopt a nonempty unrelated data directory. Choose a new --data-dir.",
    );
  // Privacy precedes reading trusted state or creating the adoption marker.
  if (process.platform === "win32") {
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const output = await command(path.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = output.match(/"(S-\d+(?:-\d+)+)"/)?.[1];
    if (!sid) throw new Error("Cannot resolve Windows user SID for private data ACL.");
    if (!before) await command(path.join(system, "icacls.exe"), [root, "/reset", "/q"]);
    await command(path.join(system, "icacls.exe"), [
      root,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "/q",
    ]);
  } else await chmod(root, 0o700);
  let state = await json(marker);
  if (!state) {
    if ((await readdir(root)).length)
      throw new Error(
        "Data directory changed during adoption; no marker was written. Rerun with a dedicated empty directory.",
      );
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ format: "kiro-internal-user-data", version: 1 })}\n`,
      );
    } finally {
      await handle.close();
    }
    state = await json(marker);
  }
  if (state?.format !== "kiro-internal-user-data" || state.version !== 1)
    throw new Error("Unrecognized user data format.");
  for (const name of ["omp", "paseo", "proxy", "config"]) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Private state directory ${name} cannot be a symbolic link or junction.`);
  }
  const configFile = path.join(root, "config.json");
  let config = await json(configFile);
  if (!config) {
    const initial = { version: 1, network: { mode: "system" }, port: 16767, nodeHeapMb: 256 };
    try {
      await writeFile(configFile, `${JSON.stringify(initial, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    config = await json(configFile);
  }
  if (
    config?.version !== 1 ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    !Number.isInteger(config.nodeHeapMb) ||
    config.nodeHeapMb < 128 ||
    config.nodeHeapMb > 4096
  )
    throw new Error(
      "Invalid wrapper config: version=1, port=1024..65535, nodeHeapMb=128..4096 required.",
    );
  return {
    root,
    config,
    configFile,
    home: path.join(root, "paseo"),
    authFile: path.join(root, "auth.sqlite3"),
  };
}
export function runtimeEnv(state, env = process.env) {
  const entries = Object.entries(env);
  const inheritedPath = entries.find(([key]) => /^path$/i.test(key))?.[1] ?? "";
  const inheritedNoProxy = entries.find(([key]) => /^no_proxy$/i.test(key))?.[1] ?? "";
  const noProxy = [
    ...new Set(
      `${inheritedNoProxy},localhost,127.0.0.1,::1,[::1]`
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].join(",");
  const virtualEnv = entries.find(([key]) => /^virtual_env$/i.test(key))?.[1];
  const condaPrefix = entries.find(([key]) => /^conda_prefix$/i.test(key))?.[1];
  const activePython =
    virtualEnv && path.isAbsolute(virtualEnv)
      ? path.join(virtualEnv, process.platform === "win32" ? "Scripts" : "bin")
      : condaPrefix && path.isAbsolute(condaPrefix)
        ? condaPrefix
        : null;
  const clean = Object.fromEntries(
    entries.filter(
      ([key]) =>
        !/^(?:PATH$|NO_PROXY$|HOME$|USERPROFILE$|PASEO_|PI_CONFIG_DIR$|PI_CODING_AGENT_DIR$|PI_PROFILE$|OMP_PROFILE$|OMP_KIRO_|OMP_INTERNAL_|KIRO_INTERNAL_DATA_DIR$|NODE_OPTIONS$|BUN_OPTIONS$)/i.test(
          key,
        ),
    ),
  );
  return {
    ...clean,
    PATH: [
      path.join(bundleRoot, "runtime/node"),
      path.join(bundleRoot, "runtime/tools"),
      ...(activePython ? [activePython, inheritedPath] : []),
      path.join(bundleRoot, "runtime/python"),
      path.join(bundleRoot, "runtime/git/cmd"),
      path.join(bundleRoot, "runtime/git/bin"),
      path.join(bundleRoot, "runtime/git/mingw64/bin"),
      path.join(bundleRoot, "runtime/git/usr/bin"),
      ...(!activePython ? [inheritedPath] : []),
    ].join(path.delimiter),
    HOME: state.root,
    USERPROFILE: state.root,
    PASEO_HOME: state.home,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_OPTIONS: `--max-old-space-size=${state.config.nodeHeapMb}`,
    PI_CONFIG_DIR: "config",
    PI_CODING_AGENT_DIR: path.join(state.root, "omp"),
    OMP_KIRO_TRANSPORT: "http",
    OMP_KIRO_AUTH_FILE: state.authFile,
    OMP_KIRO_MODEL_CATALOG_FILE: path.join(state.root, "models.json"),
    KIRO_INTERNAL_DATA_DIR: state.root,
  };
}
export function ompArgs() {
  return [
    "--no-extensions",
    "-e",
    path.join(pluginRoot, "index.js"),
    "--no-title",
    "--no-lsp",
    "--no-prewalk",
  ];
}
export async function ensureOmpSettings(state) {
  const file = path.join(state.root, "omp/config.yml");
  const { disabledProviders } = await json(path.join(bundleRoot, "app/omp-provider-roster.json"));
  try {
    await writeFile(
      file,
      "startup:\n  checkUpdate: false\n  setupWizard: false\n  changelogMode: hidden\nmarketplace:\n  autoUpdate: 'off'\nretry:\n  enabled: false\n  modelFallback: false\n  fallbackChains: {}\n  waitForUsageReset: false\n" +
        `disabledProviders: ${JSON.stringify(disabledProviders)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
export function modelRows(catalog) {
  if (!Array.isArray(catalog) || !catalog.length)
    throw new Error("No account model metadata. Run auth.cmd login, then models.cmd.");
  const ids = new Set();
  for (const model of catalog) {
    if (
      !model ||
      typeof model.id !== "string" ||
      !model.id.trim() ||
      /[\s,\x00-\x1f]/.test(model.id) ||
      model.id.startsWith("-") ||
      ids.has(model.id)
    )
      throw new Error("Invalid or duplicate model ID in account catalog.");
    ids.add(model.id);
  }
  return catalog.map((model) => ({
    id: `kiro-http/${model.id}`,
    label: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
    ...(model.id === "auto" ? { isDefault: true } : {}),
  }));
}
export function accountOmpArgs(args, catalog) {
  const rows = modelRows(catalog);
  const allowed = new Set(rows.map((model) => model.id));
  const selected = [];
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positional = true;
      continue;
    }
    if (positional) continue;
    for (const flag of ["--model", "--provider", "--models", "--smol", "--slow"]) {
      if (arg !== flag && !arg.startsWith(`${flag}=`)) continue;
      const value = arg === flag ? args[++index] : arg.slice(flag.length + 1);
      if (!value || value.startsWith("-")) throw new Error(`Missing ${flag} value.`);
      if (flag === "--provider") {
        if (value !== "kiro-http")
          throw new Error("This bundle only supports the kiro-http provider.");
      } else {
        const values = flag === "--models" ? value.split(",").map((id) => id.trim()) : [value];
        if (values.some((id) => !allowed.has(id)))
          throw new Error(
            "Select an exact account model from models.json using --model kiro-http/<id>; aliases and fallback providers are not accepted.",
          );
        if (flag === "--model") selected.push(value);
      }
      break;
    }
  }
  if (selected.length) return args;
  const automatic = rows.find((model) => model.isDefault);
  if (!automatic)
    throw new Error(
      "This account has no auto model. Select an exact model from models.json using --model kiro-http/<id>.",
    );
  return ["--model", automatic.id, ...args];
}
export async function configurePaseo(state, { passwordHash, port = state.config.port } = {}) {
  const file = path.join(state.home, "config.json");
  const original = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const previous = original ? JSON.parse(original) : {};
  const catalog = await json(path.join(state.root, "models.json"));
  if (catalog && (catalog.version !== 1 || !Array.isArray(catalog.models)))
    throw new Error("Invalid account model metadata. Run models.cmd.");
  const models = catalog?.models.length ? modelRows(catalog.models) : [];
  const oldProviders = previous.agents?.providers ?? {};
  const providers = { ...oldProviders };
  for (const id of ["claude", "codex", "copilot", "opencode", "pi", "omp"])
    providers[id] = { ...providers[id], enabled: providers[id]?.enabled ?? false };
  // Keep desired activation separate from catalog gating: [] triggers runtime
  // discovery in Paseo, so an empty account catalog must disable this profile.
  const gateFile = path.join(state.root, "paseo-profile.json");
  const gate = await json(gateFile);
  const configurationHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const changedExternally =
    gate && original && configurationHash(original) !== gate.configurationHash;
  let requestedEnabled = gate?.requestedEnabled ?? providers[profileId]?.enabled ?? true;
  if (
    gate &&
    typeof providers[profileId]?.enabled === "boolean" &&
    (providers[profileId].enabled !== gate.appliedEnabled ||
      (changedExternally && providers[profileId].enabled === false))
  )
    requestedEnabled = providers[profileId].enabled;
  const appliedEnabled = models.length > 0 && requestedEnabled;
  providers[profileId] = {
    ...providers[profileId],
    enabled: appliedEnabled,
    extends: "omp",
    label: "Kiro HTTP (OMP)",
    command: [path.join(bundleRoot, "runtime/omp/omp.exe"), ...ompArgs()],
    env: {
      ...Object.fromEntries(
        Object.entries(providers[profileId]?.env ?? {}).filter(
          ([key]) => !/^OMP_KIRO_MODEL_CATALOG_FILE$/i.test(key),
        ),
      ),
      OMP_KIRO_AUTH_FILE: state.authFile,
      OMP_KIRO_MODEL_CATALOG_FILE: path.join(state.root, "models.json"),
      OMP_KIRO_TRANSPORT: "http",
      NODE_OPTIONS: "",
      HOME: state.root,
      USERPROFILE: state.root,
      PI_CONFIG_DIR: "config",
      PI_CODING_AGENT_DIR: path.join(state.root, "omp"),
    },
    models,
  };
  delete providers[profileId].additionalModels;
  providers["kiro-http"] = {
    ...providers["kiro-http"],
    enabled: providers["kiro-http"]?.enabled ?? false,
    env: {
      ...Object.fromEntries(
        Object.entries(providers["kiro-http"]?.env ?? {}).filter(
          ([key]) => !/^OMP_KIRO_MODEL_CATALOG_FILE$/i.test(key),
        ),
      ),
      OMP_KIRO_AUTH_FILE: state.authFile,
      OMP_KIRO_MODEL_CATALOG_FILE: path.join(state.root, "models.json"),
    },
  };
  const profiles = (previous.daemon?.agentProfiles ?? []).filter(
    (profile) => profile.id !== profileId,
  );
  const automatic = models.find((model) => model.isDefault);
  const previousProfile = previous.daemon?.agentProfiles?.find(
    (profile) => profile.id === profileId,
  );
  const preferred = models.find((model) => model.id === previousProfile?.model) ?? automatic;
  const profileSettings = { ...previousProfile };
  delete profileSettings.model;
  let requestedCliDefault =
    gate?.requestedCliDefault ??
    previousProfile?.cliDefault ??
    !profiles.some((profile) => profile.cliDefault);
  if (
    gate &&
    typeof previousProfile?.cliDefault === "boolean" &&
    (previousProfile.cliDefault !== gate.appliedCliDefault ||
      (changedExternally && previousProfile.cliDefault === false))
  )
    requestedCliDefault = previousProfile.cliDefault;
  const appliedCliDefault = appliedEnabled && Boolean(preferred) && requestedCliDefault;
  profiles.unshift({
    ...profileSettings,
    id: profileId,
    name: previousProfile?.name ?? "Kiro HTTP via OMP",
    provider: profileId,
    cliDefault: appliedCliDefault,
    ...(preferred ? { model: preferred.id } : {}),
  });
  const next = {
    ...previous,
    version: 1,
    daemon: {
      ...previous.daemon,
      listen: `127.0.0.1:${port}`,
      relay: { ...previous.daemon?.relay, enabled: false },
      auth: { ...previous.daemon?.auth, ...(passwordHash ? { password: passwordHash } : {}) },
      git: { ...previous.daemon?.git, maxProcessConcurrency: 2, maxProcessesPerSecond: 8 },
      agentProfiles: profiles,
    },
    features: {
      ...previous.features,
      webUi: { ...previous.features?.webUi, enabled: true },
      dictation: { ...previous.features?.dictation, enabled: false },
      voiceMode: { ...previous.features?.voiceMode, enabled: false },
    },
    agents: {
      ...previous.agents,
      providers,
      metadataGeneration: { ...previous.agents?.metadataGeneration, providers: [] },
    },
    pluginsEnabled: previous.pluginsEnabled ?? true,
    plugins: {
      ...previous.plugins,
      "omp-kiro": {
        source: "directory",
        path: pluginRoot,
        enabled: previous.plugins?.["omp-kiro"]?.enabled ?? true,
      },
    },
  };
  await save(file, next, original);
  await save(gateFile, {
    requestedEnabled,
    appliedEnabled,
    requestedCliDefault,
    appliedCliDefault,
    configurationHash: configurationHash(`${JSON.stringify(next, null, 2)}\n`),
  });
  return next;
}
