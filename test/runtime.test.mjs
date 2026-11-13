import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const suppliedBundle = process.env.KIRO_TEST_BUNDLE_ROOT;
const {
  bundleRoot,
  configureDaemon,
  initialize,
  json,
  modelRows,
  ompEnvironment,
  profileId,
  pluginRoot,
  runtimeEnv,
  save,
} = await import(
  suppliedBundle
    ? pathToFileURL(path.join(suppliedBundle, "app/lib/state.mjs")).href
    : "../payload/app/lib/state.mjs"
);
import {
  argumentsFor,
  authOperation,
  desktopSettings,
  hasLiveOwner,
  listenMatches,
  nativeEnv,
  privateOmpArgs,
  privatePaseoArgs,
  tasklistPids,
  validatePassword,
} from "../payload/app/lib/run.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kiro-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const fixtureAuth = {
  kind: "social",
  provider: "google",
  access_token: "runtime-fixture-access",
  refresh_token: "runtime-fixture-refresh",
  expires_at: "2099-01-01T00:00:00.000Z",
  profile_arn: "arn:aws:codewhisperer:us-east-1:fixture:profile/runtime",
};
const bundled = { skip: suppliedBundle ? false : "Requires extracted KIRO_TEST_BUNDLE_ROOT" };
async function catalog(state, models, auth = fixtureAuth) {
  const { saveKiroAuth } = await import(
    pathToFileURL(path.join(pluginRoot, "server/auth.mjs")).href
  );
  const { kiroCatalogAccountId } = await import(
    pathToFileURL(path.join(pluginRoot, "server/model-catalog.mjs")).href
  );
  await saveKiroAuth(auth, { authFile: state.authFile });
  await save(path.join(state.root, "models.json"), {
    version: 1,
    fetchedAt: new Date().toISOString(),
    accountId: kiroCatalogAccountId(auth),
    models,
  });
}
const fixtureModels = [
  { id: "fixture-model", name: "Fixture model" },
  { id: "auto", name: "Account auto" },
];
const fixtureState = () => {
  const root = path.join(tmpdir(), "private");
  return {
    root,
    home: path.join(root, "passession"),
    ompDir: path.join(root, "omp"),
    authFile: path.join(root, "auth.sqlite3"),
    config: { nodeHeapMb: 192 },
  };
};
const kiroProfile = (config) =>
  config.daemon.agentProfiles.find((profile) => profile.id === profileId);

test("state initializes missing parents and preserves existing private configuration", async (t) => {
  const parent = await temporary(t);
  const root = path.join(parent, "nested", "new", "private");
  const first = await initialize(root);
  first.config.port = 19431;
  await save(first.configFile, first.config);
  const second = await initialize(root);
  assert.equal(second.config.port, 19431);
  assert.equal(second.authFile, path.join(root, "auth.sqlite3"));
  assert.equal(second.home, path.join(root, "passession"));
  assert.equal(second.ompDir, path.join(root, "omp"));
  if (process.platform !== "win32") assert.equal((await stat(root)).mode & 0o777, 0o700);
  for (const invalid of [
    path.parse(root).root,
    bundleRoot,
    path.join(bundleRoot, "private"),
    "relative-state",
  ]) {
    await assert.rejects(initialize(invalid), /dedicated directory|must be absolute/);
  }
});

test("adoption refuses unrelated contents and malformed or linked ownership markers", async (t) => {
  const parent = await temporary(t);
  const unrelated = path.join(parent, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "user data");
  await assert.rejects(initialize(unrelated), /nonempty unrelated/);
  assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "user data");
  assert.equal(await json(path.join(unrelated, "portable-state.json")), null);
  const invalid = path.join(parent, "invalid");
  await mkdir(invalid);
  await writeFile(
    path.join(invalid, "portable-state.json"),
    '{"format":"another-app","version":1}',
  );
  await assert.rejects(initialize(invalid), /Unrecognized user data/);
});

test("root, ancestor and state-subdirectory links cannot redirect private state", async (t) => {
  const parent = await temporary(t);
  const target = path.join(parent, "target");
  await mkdir(target);
  const link = path.join(parent, "redirect");
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(initialize(link), /symbolic link|junction/);
  await assert.rejects(initialize(path.join(link, "child")), /symbolic link|junction/);
  const state = await initialize(path.join(parent, "owned"));
  for (const name of ["passession", "omp"]) {
    await rm(path.join(state.root, name), { recursive: true });
    await symlink(
      target,
      path.join(state.root, name),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(initialize(state.root), /symbolic link|junction/);
    await rm(path.join(state.root, name));
    await mkdir(path.join(state.root, name));
  }
  assert.equal(await json(path.join(target, "portable-state.json")), null);
});

test("earlier Node-Paseo and native-HTTP session data are never opened or reused", async (t) => {
  const root = path.join(await temporary(t), "state");
  const state = await initialize(root);
  const legacyHome = path.join(root, "paseo");
  const legacyHistory = path.join(root, ".local", "state", "omp-kiro", "paseo");
  await mkdir(legacyHome, { recursive: true });
  await mkdir(legacyHistory, { recursive: true });
  await writeFile(path.join(legacyHome, "config.json"), '{"legacy":true}');
  await writeFile(path.join(legacyHistory, "session.json"), '{"legacy":true}');
  const config = await configureDaemon(await initialize(root));
  assert.equal(config.legacy, undefined);
  assert.notEqual(state.home, legacyHome);
  assert.equal(await readFile(path.join(legacyHome, "config.json"), "utf8"), '{"legacy":true}');
  assert.equal(await readFile(path.join(legacyHistory, "session.json"), "utf8"), '{"legacy":true}');
  const env = runtimeEnv(state, {});
  for (const value of Object.values(env)) {
    assert.ok(!value.includes(legacyHistory));
    assert.ok(!value.split(path.delimiter).includes(legacyHome));
  }
});

test("mixed-case inherited environment cannot escape the private runtime or select another daemon", () => {
  const state = fixtureState();
  const env = runtimeEnv(state, {
    Path: "inherited-tools",
    HOME: "caller-git-home",
    USERPROFILE: "caller-windows-home",
    pAsEo_HoMe: "foreign",
    paseo_host: "remote",
    PASEO_PASSWORD: "foreign-daemon-password",
    Paseo_Listen: "0.0.0.0:1",
    Pi_Config_Dir: "foreign",
    pi_coding_agent_dir: "foreign",
    Omp_Command: "foreign-omp",
    omp_kiro_transport: "acp",
    node_options: "--require injected",
    BuN_Options: "injected",
    bun_be_bun: "1",
    omp_kiro_auth_file: "foreign",
    omp_kiro_model_catalog_file: "foreign",
    kiro_internal_data_dir: "foreign",
    NODE_EXTRA_CA_CERTS: "enterprise.pem",
  });
  assert.deepEqual(
    Object.keys(env).filter((key) => /^path$/i.test(key)),
    ["PATH"],
  );
  assert.ok(env.PATH.endsWith(path.delimiter + "inherited-tools"));
  assert.deepEqual(
    Object.keys(env).filter((key) => /^paseo_/i.test(key)),
    ["PASEO_HOME"],
  );
  assert.equal(env.PASEO_HOME, state.home);
  assert.equal(env.OMP_KIRO_AUTH_FILE, state.authFile);
  assert.equal(env.OMP_KIRO_MODEL_CATALOG_FILE, path.join(state.root, "models.json"));
  assert.equal(env.omp_kiro_model_catalog_file, undefined);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=192");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "enterprise.pem");
  assert.equal(env.HOME, "caller-git-home");
  assert.equal(env.USERPROFILE, "caller-windows-home");
  assert.equal(env.PI_CONFIG_DIR, ompEnvironment(state).PI_CONFIG_DIR);
  assert.equal(env.PI_CODING_AGENT_DIR, path.join(state.ompDir, "agent"));
  for (const key of ["Pi_Config_Dir", "pi_coding_agent_dir", "Omp_Command", "omp_kiro_transport"])
    assert.equal(env[key], undefined);
  assert.equal(env.OMP_KIRO_TRANSPORT, undefined);
  assert.equal(env.BuN_Options, undefined);
  assert.equal(env.bun_be_bun, undefined);
});

test("OMP state never uses the caller's ~/.omp for descendant, sibling or cross-drive data", () => {
  const home = path.join(tmpdir(), "profile");
  const inside = { ...fixtureState(), ompDir: path.join(home, "AppData", "Local", "KiroInternal", "omp") };
  assert.deepEqual(ompEnvironment(inside, home), {
    PI_CONFIG_DIR: path.join("AppData", "Local", "KiroInternal", "omp"),
    PI_CODING_AGENT_DIR: path.join(inside.ompDir, "agent"),
    OMP_KIRO_AUTH_FILE: inside.authFile,
    OMP_KIRO_MODEL_CATALOG_FILE: path.join(inside.root, "models.json"),
  });
  // Same drive outside the profile: OMP's path.join(home, PI_CONFIG_DIR) reaches the data dir.
  const sibling = { ...fixtureState(), ompDir: path.join(tmpdir(), "elsewhere", "omp") };
  const siblingEnv = ompEnvironment(sibling, home);
  assert.ok(siblingEnv.PI_CONFIG_DIR.startsWith(".."));
  assert.equal(path.join(home, siblingEnv.PI_CONFIG_DIR), sibling.ompDir);
  assert.equal(siblingEnv.PI_CODING_AGENT_DIR, path.join(sibling.ompDir, "agent"));
  if (process.platform === "win32") {
    const first = { ...sibling, root: "D:\\Data\\Kiro", ompDir: "D:\\Data\\Kiro\\omp" };
    const second = { ...sibling, root: "D:\\Data\\Other", ompDir: "D:\\Data\\Other\\omp" };
    const mapped = ompEnvironment(first, "C:\\Users\\fixture");
    assert.match(mapped.PI_CONFIG_DIR, /^\.kiro-internal-omp\\[0-9a-f]{64}$/);
    assert.equal(ompEnvironment({ ...first, root: "d:\\data\\kiro" }, "C:\\Users\\fixture").PI_CONFIG_DIR, mapped.PI_CONFIG_DIR);
    assert.notEqual(ompEnvironment(second, "C:\\Users\\fixture").PI_CONFIG_DIR, mapped.PI_CONFIG_DIR);
    assert.equal(mapped.PI_CODING_AGENT_DIR, "D:\\Data\\Kiro\\omp\\agent");
  }
  for (const env of [ompEnvironment(inside, home), siblingEnv])
    assert.notEqual(path.join(home, env.PI_CONFIG_DIR), path.join(home, ".omp"));
  // The child's own profile variable decides, not this process's home.
  const child = runtimeEnv(inside, {
    [process.platform === "win32" ? "USERPROFILE" : "HOME"]: home,
  });
  assert.equal(child.PI_CONFIG_DIR, path.join("AppData", "Local", "KiroInternal", "omp"));
});

test("active virtual environments precede bundled Python while utilities remain on PATH", () => {
  const active = path.join(tmpdir(), "active-python");
  const env = runtimeEnv(fixtureState(), {
    PATH: "caller-tools",
    VIRTUAL_ENV: active,
    CONDA_PREFIX: path.join(tmpdir(), "unused-conda"),
  });
  const entries = env.PATH.split(path.delimiter);
  assert.ok(entries.includes(path.join(bundleRoot, "runtime/tools")));
  assert.ok(entries.includes(path.join(bundleRoot, "runtime/git/usr/bin")));
  assert.ok(
    entries.indexOf(path.join(active, process.platform === "win32" ? "Scripts" : "bin")) <
      entries.indexOf(path.join(bundleRoot, "runtime/python")),
  );
});

test("native processes never receive the Node-only network bootstrap", () => {
  const env = nativeEnv({
    NODE_OPTIONS: "--import=bootstrap",
    node_use_env_proxy: "1",
    HTTPS_PROXY: "http://kiro:secret@127.0.0.1:1",
    NODE_EXTRA_CA_CERTS: "trust.pem",
  });
  assert.deepEqual(env, {
    HTTPS_PROXY: "http://kiro:secret@127.0.0.1:1",
    NODE_EXTRA_CA_CERTS: "trust.pem",
  });
});

test("account catalog models become exact kiro-http OMP selectors and never invent an auto model", () => {
  assert.throws(() => modelRows([]), /No account model metadata/);
  assert.throws(() => modelRows([{ id: "same" }, { id: "same" }]), /duplicate/);
  assert.deepEqual(modelRows(fixtureModels), [
    { id: "kiro-http/fixture-model", label: "Fixture model" },
    { id: "kiro-http/auto", label: "Account auto", isDefault: true },
  ]);
  assert.deepEqual(modelRows([{ id: "fixture-model" }]), [
    { id: "kiro-http/fixture-model", label: "fixture-model" },
  ]);
  assert.deepEqual(modelRows([{ id: "-native,raw id" }]), [
    { id: "kiro-http/-native,raw id", label: "-native,raw id" },
  ]);
});

test("missing credentials never enable a catalog or another provider", async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await save(path.join(state.root, "models.json"), { version: 1, models: fixtureModels });
  let config = await configureDaemon(state);
  const profile = kiroProfile(config);
  for (const [id, provider] of Object.entries(config.agents.providers))
    assert.equal(provider.enabled, false, id);
  assert.deepEqual(Object.keys(config.agents.providers).sort(), [
    "claude",
    "codex",
    "copilot",
    "kiro-http",
    "omp",
    "opencode",
    "pi",
  ]);
  assert.equal(profile.cliDefault, false);
  assert.equal(profile.model, undefined);
  assert.equal(profile.modeId, "full");
  await writeFile(path.join(state.root, "models.json"), "{malformed");
  config = await configureDaemon(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
});

test("daemon configuration is loopback-only, relay-free and launches only the trusted extension", async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  const config = await configureDaemon(state, { passwordHash: "$2b$12$" + "a".repeat(53), port: 19432 });
  assert.equal(config.version, 1);
  assert.equal(config.daemon.listen, "127.0.0.1:19432");
  assert.equal(config.daemon.relay.enabled, false);
  assert.deepEqual(config.daemon.cors.allowedOrigins, []);
  assert.equal(config.daemon.auth.password, "$2b$12$" + "a".repeat(53));
  assert.equal(config.features, undefined);
  const provider = config.agents.providers[profileId];
  assert.equal(provider.extends, "omp");
  assert.equal(provider.env.PI_CODING_AGENT_DIR, path.join(state.ompDir, "agent"));
  assert.equal(provider.env.PI_CONFIG_DIR, ompEnvironment(state).PI_CONFIG_DIR);
  assert.equal(provider.env.OMP_KIRO_AUTH_FILE, state.authFile);
  assert.equal(provider.options.rpcTimeoutMs, 120000);
  // A later write keeps the stored hash and an explicit user timeout.
  provider.options.rpcTimeoutMs = 90000;
  provider.env.CUSTOM = "kept";
  provider.env.OMP_KIRO_TRANSPORT = "acp";
  provider.env.HTTPS_PROXY = "http://stale";
  await save(path.join(state.home, "config.json"), config);
  const next = await configureDaemon(state);
  assert.equal(next.daemon.auth.password, "$2b$12$" + "a".repeat(53));
  assert.equal(next.agents.providers[profileId].options.rpcTimeoutMs, 90000);
  assert.equal(next.agents.providers[profileId].env.CUSTOM, "kept");
  assert.equal(next.agents.providers[profileId].env.OMP_KIRO_TRANSPORT, undefined);
  assert.equal(next.agents.providers[profileId].env.HTTPS_PROXY, undefined);
});

test("Passession restores authenticated activation and preserves explicit user choices", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  let config = await configureDaemon(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.equal(kiroProfile(config).cliDefault, false);
  assert.equal(kiroProfile(config).model, undefined);
  await catalog(state, fixtureModels);
  config = await configureDaemon(state);
  assert.equal(config.agents.providers[profileId].enabled, true);
  assert.deepEqual(config.agents.providers[profileId].models, modelRows(fixtureModels));
  assert.equal(kiroProfile(config).model, "kiro-http/auto");
  assert.equal(kiroProfile(config).cliDefault, true);
  config.agents.providers[profileId].enabled = false;
  config.agents.providers.codex = { enabled: true, env: { CUSTOM: "removed" } };
  config.agents.providers.custom = { extends: "acp", label: "Other", command: ["other"] };
  config.daemon.agentProfiles[0].modeId = "write";
  config.pluginsEnabled = false;
  await save(path.join(state.home, "config.json"), config);
  await configureDaemon(state);
  await rm(path.join(state.root, "models.json"));
  await configureDaemon(state);
  await catalog(state, fixtureModels);
  config = await configureDaemon(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.deepEqual(config.agents.providers.codex, { enabled: false });
  assert.equal(config.agents.providers.custom, undefined);
  assert.equal(config.daemon.agentProfiles[0].modeId, "write");
  assert.equal(config.pluginsEnabled, false);
});

test("an empty refreshed catalog removes stale profile model and has no default fallback", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await catalog(state, fixtureModels);
  await configureDaemon(state);
  await catalog(state, []);
  const config = await configureDaemon(state);
  const profile = kiroProfile(config);
  assert.equal(profile.model, undefined);
  assert.equal(profile.cliDefault, false);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.deepEqual(config.agents.providers[profileId].models, []);
});

test("changed account and malformed snapshots fail closed without rotating credentials", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await catalog(state, fixtureModels);
  const initial = await configureDaemon(state);
  assert.equal(initial.agents.providers[profileId].enabled, true);
  const { saveKiroAuth, readKiroAuth } = await import(
    pathToFileURL(path.join(pluginRoot, "server/auth.mjs")).href
  );
  const otherAccount = { ...fixtureAuth, profile_arn: `${fixtureAuth.profile_arn}-other` };
  await saveKiroAuth(otherAccount, { authFile: state.authFile });
  let config = await configureDaemon(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.equal(config.daemon.agentProfiles[0].cliDefault, false);
  assert.equal(config.daemon.agentProfiles[0].model, undefined);
  assert.deepEqual(await readKiroAuth({ authFile: state.authFile }), otherAccount);
  await catalog(state, fixtureModels);
  await writeFile(path.join(state.root, "models.json"), "{malformed");
  config = await configureDaemon(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.deepEqual(await readKiroAuth({ authFile: state.authFile }), fixtureAuth);
});

test("selected model persists and unsupported OMP modes fall back to Full access", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await catalog(state, fixtureModels);
  let config = await configureDaemon(state);
  config.daemon.agentProfiles[0].model = "kiro-http/fixture-model";
  config.daemon.agentProfiles[0].modeId = "ask";
  await save(path.join(state.home, "config.json"), config);
  config = await configureDaemon(state);
  assert.equal(config.daemon.agentProfiles[0].model, "kiro-http/fixture-model");
  assert.equal(config.daemon.agentProfiles[0].modeId, "ask");
  config.daemon.agentProfiles[0].modeId = "plan";
  await save(path.join(state.home, "config.json"), config);
  config = await configureDaemon(state);
  assert.equal(config.daemon.agentProfiles[0].modeId, "full");
  await catalog(state, [fixtureModels[0]]);
  config = await configureDaemon(state);
  assert.equal(config.daemon.agentProfiles[0].model, "kiro-http/fixture-model");
  assert.equal(config.daemon.agentProfiles[0].cliDefault, true);
});

test("configuration concurrent edit detection does not overwrite the user change", async (t) => {
  const file = path.join(await temporary(t), "config.json");
  await writeFile(file, "user changed it");
  await assert.rejects(save(file, { overwritten: true }, "old bytes"), /changed concurrently/);
  assert.equal(await readFile(file, "utf8"), "user changed it");
});

test("wrapper preserves native positional separator and pins all Passession target selectors", () => {
  const parsed = argumentsFor([
    "paseo",
    "--data-dir",
    path.resolve("private"),
    "--",
    "--",
    "--model",
    "literal",
  ]);
  assert.deepEqual(parsed.rest, ["--", "--model", "literal"]);
  assert.deepEqual(privatePaseoArgs(["daemon", "status"], "private-home"), [
    "--home",
    "private-home",
    "daemon",
    "status",
  ]);
  for (const selector of [
    "--home",
    "--home=other",
    "--host",
    "--host=remote",
    "--daemon",
    "--daemon=remote",
  ])
    assert.throws(
      () => privatePaseoArgs(["daemon", "status", selector], "private-home"),
      /private home/,
    );
  for (const lifecycle of [
    ["start"],
    ["restart"],
    ["onboard"],
    ["daemon", "start"],
    ["daemon", "run"],
    ["daemon", "restart"],
    ["daemon", "update"],
    ["--format", "json", "daemon", "start"],
    ["--cwd", "project", "daemon", "run"],
    ["--provider=kiro-http", "start"],
  ])
    assert.throws(() => privatePaseoArgs(lifecycle, "private-home"), /Use start.cmd/);
  for (const allowed of [
    ["--version"],
    ["help"],
    ["daemon", "status"],
    ["daemon", "stop"],
    ["run", "--title", "start", "--provider", "kiro-http", "--model", "kiro-http/auto", "start the task"],
  ]) {
    assert.deepEqual(privatePaseoArgs(allowed, "private-home"), [
      "--home",
      "private-home",
      ...allowed,
    ]);
  }
});

test("OMP rejects unapproved extension selectors", () => {
  for (const selector of ["--extension", "-e", "--hook=x", "--trusted-extension", "--plugin-dir"])
    assert.throws(() => privateOmpArgs([selector, "x"]), /pinned Kiro extension/);
});

test("start uses the desktop app unless --no-app and keeps the main Paseo port reserved", async (t) => {
  assert.equal(argumentsFor(["start", "--no-app"]).flags["no-app"], true);
  assert.deepEqual(argumentsFor(["start", "--no-browser"]).rest, ["--no-browser"]);
  assert.throws(() => argumentsFor(["start", "--port", "6767"]), /main Paseo port/);
  const state = await initialize(path.join(await temporary(t), "state"));
  assert.equal(state.config.port, 16767);
  state.config.port = 6767;
  await save(state.configFile, state.config);
  await assert.rejects(initialize(state.root), /main Paseo port/);
});

test("readiness requires the exact private loopback endpoint", () => {
  assert.equal(listenMatches("127.0.0.1:16767", 16767), true);
  assert.equal(listenMatches("tcp://127.0.0.1:16767", 16767), true);
  for (const listen of ["127.0.0.1:6767", "0.0.0.0:16767", "localhost:16767", null])
    assert.equal(listenMatches(listen, 16767), false);
});

test("daemon passwords match Passession's bcrypt input limits", () => {
  assert.equal(validatePassword("correct horse"), "correct horse");
  assert.equal(validatePassword("가".repeat(24)), "가".repeat(24));
  for (const invalid of ["", "line\nbreak", "a".repeat(73), "가".repeat(25), undefined])
    assert.throws(() => validatePassword(invalid), /password/);
});

test("desktop app settings never let the app start or replace a daemon", () => {
  assert.deepEqual(desktopSettings(null), {
    version: 1,
    settings: { daemon: { keepRunningAfterQuit: true, manageBuiltInDaemon: false } },
  });
  assert.deepEqual(
    desktopSettings({
      version: 1,
      settings: {
        releaseChannel: "beta",
        daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
      },
    }),
    {
      version: 1,
      settings: {
        releaseChannel: "beta",
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false },
      },
    },
  );
});

test("desktop single-instance detection parses only matching tasklist rows", () => {
  assert.deepEqual(
    tasklistPids(
      '"paseo_sessions.exe","4242","Console","1","120,000 K"\r\n"paseo_sessions.exe","77","Console","1","1 K"\r\n',
    ),
    [4242, 77],
  );
  assert.deepEqual(tasklistPids("INFO: No tasks are running which match the specified criteria.\r\n"), []);
});

test("auth help cannot masquerade as a successful login or logout and target store overrides fail closed", () => {
  assert.equal(authOperation(["login", "--help"]), "help");
  assert.equal(authOperation(["auth", "logout", "-h"]), "help");
  assert.equal(authOperation(["auth", "status", "--json"]), "auth status");
  assert.equal(
    authOperation(["auth", "import-cli", "--database", "source.sqlite3"]),
    "auth import-cli",
  );
  assert.equal(authOperation(["auth", "profile", "--profile", "arn:fixture"]), "auth profile");
  assert.equal(authOperation(["--provider", "google", "login", "--profile", "arn:x"]), "login");
  assert.throws(() => authOperation(["login", "--auth-file=foreign"]));
  assert.throws(() => authOperation(["auth", "logout", "extra"]));
});

test("existing daemon ownership requires live launcher PID and exact daemon incarnation", () => {
  const instance = { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
  const owner = { pid: process.pid, daemonPid: instance.pid, daemonStartedAt: instance.startedAt };
  assert.equal(hasLiveOwner(owner, instance), true);
  assert.equal(
    hasLiveOwner({ ...owner, daemonStartedAt: "2026-01-02T00:00:00.000Z" }, instance),
    false,
  );
  assert.equal(hasLiveOwner({ ...owner, daemonPid: process.pid + 1 }, instance), false);
  assert.equal(hasLiveOwner({ pid: process.pid }, instance), false);
  for (const pid of [0, 1, -1, "123", undefined])
    assert.equal(hasLiveOwner({ ...owner, pid }, instance), false);
});
