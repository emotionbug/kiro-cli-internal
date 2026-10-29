import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const suppliedBundle = process.env.KIRO_TEST_BUNDLE_ROOT;
const {
  bundleRoot,
  configurePaseo,
  initialize,
  json,
  modelRows,
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
  hasLiveOwner,
  privatePaseoArgs,
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

test("state initializes missing parents and preserves existing private configuration", async (t) => {
  const parent = await temporary(t);
  const root = path.join(parent, "nested", "new", "private");
  const first = await initialize(root);
  first.config.port = 19431;
  await save(first.configFile, first.config);
  const second = await initialize(root);
  assert.equal(second.config.port, 19431);
  assert.equal(second.authFile, path.join(root, "auth.sqlite3"));
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
  await rm(path.join(state.root, "paseo"), { recursive: true });
  await symlink(
    target,
    path.join(state.root, "paseo"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(initialize(state.root), /symbolic link|junction/);
  assert.equal(await json(path.join(target, "portable-state.json")), null);
});

test("mixed-case inherited environment cannot escape the private runtime or inject Node options", () => {
  const state = {
    root: path.join(tmpdir(), "private"),
    home: path.join(tmpdir(), "private", "paseo"),
    authFile: path.join(tmpdir(), "private", "auth.sqlite3"),
    config: { nodeHeapMb: 192 },
  };
  const env = runtimeEnv(state, {
    Path: "inherited-tools",
    HOME: "caller-git-home",
    USERPROFILE: "caller-windows-home",
    pAsEo_HoMe: "foreign",
    paseo_host: "remote",
    Pi_Config_Dir: "foreign",
    node_options: "--require injected",
    BuN_Options: "injected",
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
  assert.equal(env.PASEO_HOME, state.home);
  assert.equal(env.OMP_KIRO_AUTH_FILE, state.authFile);
  assert.equal(env.OMP_KIRO_MODEL_CATALOG_FILE, path.join(state.root, "models.json"));
  assert.equal(env.omp_kiro_model_catalog_file, undefined);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=192");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "enterprise.pem");
  assert.equal(env.HOME, "caller-git-home");
  assert.equal(env.USERPROFILE, "caller-windows-home");
  assert.equal(env.PI_CONFIG_DIR, undefined);
  assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(env.OMP_KIRO_TRANSPORT, undefined);
  assert.equal(env.paseo_host, undefined);
  assert.equal(env.BuN_Options, undefined);
});

test("active virtual environments precede bundled Python while utilities remain on PATH", () => {
  const active = path.join(tmpdir(), "active-python");
  const state = {
    root: path.join(tmpdir(), "private"),
    home: path.join(tmpdir(), "private", "paseo"),
    authFile: path.join(tmpdir(), "private", "auth.sqlite3"),
    config: { nodeHeapMb: 192 },
  };
  const env = runtimeEnv(state, {
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

test("account catalog models retain exact native IDs and never invent an auto model", () => {
  assert.throws(() => modelRows([]), /No account model metadata/);
  assert.throws(() => modelRows([{ id: "same" }, { id: "same" }]), /duplicate/);
  assert.deepEqual(modelRows(fixtureModels), [
    { id: "fixture-model", label: "Fixture model" },
    { id: "auto", label: "Account auto", isDefault: true },
  ]);
  assert.deepEqual(modelRows([{ id: "fixture-model" }]), [
    { id: "fixture-model", label: "fixture-model" },
  ]);
  assert.deepEqual(modelRows([{ id: "-native,raw id" }]), [
    { id: "-native,raw id", label: "-native,raw id" },
  ]);
});

test("missing credentials never enable a catalog or load unused providers", async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await save(path.join(state.root, "models.json"), { version: 1, models: fixtureModels });
  let config = await configurePaseo(state);
  const profile = config.daemon.agentProfiles.find((entry) => entry.id === profileId);
  assert.deepEqual(Object.keys(config.agents.providers), ["kiro-http"]);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.equal(profile.cliDefault, false);
  assert.equal(profile.model, undefined);
  assert.equal(profile.modeId, "full");
  await writeFile(path.join(state.root, "models.json"), "{malformed");
  config = await configurePaseo(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
});

test("Paseo restores authenticated activation and preserves explicit user choices", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  let config = await configurePaseo(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.equal(
    config.daemon.agentProfiles.find((profile) => profile.id === profileId).cliDefault,
    false,
  );
  assert.equal(
    config.daemon.agentProfiles.find((profile) => profile.id === profileId).model,
    undefined,
  );
  await catalog(state, fixtureModels);
  config = await configurePaseo(state);
  assert.equal(config.agents.providers[profileId].enabled, true);
  assert.equal(
    config.agents.providers[profileId].env.OMP_KIRO_MODEL_CATALOG_FILE,
    path.join(state.root, "models.json"),
  );
  assert.equal(
    config.daemon.agentProfiles.find((profile) => profile.id === profileId).model,
    "auto",
  );
  assert.equal(
    config.daemon.agentProfiles.find((profile) => profile.id === profileId).cliDefault,
    true,
  );
  config.agents.providers[profileId].enabled = false;
  config.agents.providers[profileId].env.omp_kiro_model_catalog_file = "foreign";
  config.agents.providers.codex = { enabled: true, env: { CUSTOM: "removed" } };
  config.daemon.agentProfiles[0].modeId = "plan";
  config.pluginsEnabled = false;
  await save(path.join(state.home, "config.json"), config);
  await configurePaseo(state);
  await rm(path.join(state.root, "models.json"));
  await configurePaseo(state);
  await catalog(state, fixtureModels);
  config = await configurePaseo(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.equal(
    config.agents.providers[profileId].env.OMP_KIRO_MODEL_CATALOG_FILE,
    path.join(state.root, "models.json"),
  );
  assert.equal(config.agents.providers[profileId].env.omp_kiro_model_catalog_file, undefined);
  assert.equal(config.agents.providers.codex, undefined);
  assert.equal(config.daemon.agentProfiles[0].modeId, "plan");
  assert.equal(config.pluginsEnabled, false);
});

test("an empty refreshed catalog removes stale profile model and has no default fallback", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await catalog(state, fixtureModels);
  await configurePaseo(state);
  await catalog(state, []);
  const config = await configurePaseo(state);
  const profile = config.daemon.agentProfiles.find((value) => value.id === profileId);
  assert.equal(profile.model, undefined);
  assert.equal(profile.cliDefault, false);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.deepEqual(config.agents.providers[profileId].models, []);
});

test("changed account and malformed snapshots fail closed without rotating credentials", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await catalog(state, fixtureModels);
  const initial = await configurePaseo(state);
  assert.equal(initial.agents.providers[profileId].enabled, true);
  const { saveKiroAuth, readKiroAuth } = await import(
    pathToFileURL(path.join(pluginRoot, "server/auth.mjs")).href
  );
  const otherAccount = { ...fixtureAuth, profile_arn: `${fixtureAuth.profile_arn}-other` };
  await saveKiroAuth(otherAccount, { authFile: state.authFile });
  let config = await configurePaseo(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.equal(config.daemon.agentProfiles[0].cliDefault, false);
  assert.equal(config.daemon.agentProfiles[0].model, undefined);
  assert.deepEqual(await readKiroAuth({ authFile: state.authFile }), otherAccount);
  await catalog(state, fixtureModels);
  await writeFile(path.join(state.root, "models.json"), "{malformed");
  config = await configurePaseo(state);
  assert.equal(config.agents.providers[profileId].enabled, false);
  assert.deepEqual(await readKiroAuth({ authFile: state.authFile }), fixtureAuth);
});

test("direct profile uses real first model when auto is absent and preserves Ask", bundled, async (t) => {
  const state = await initialize(path.join(await temporary(t), "state"));
  await catalog(state, [fixtureModels[0]]);
  let config = await configurePaseo(state);
  assert.equal(config.daemon.agentProfiles[0].model, "fixture-model");
  assert.equal(config.daemon.agentProfiles[0].modeId, "full");
  assert.equal(config.daemon.agentProfiles[0].cliDefault, true);
  config.daemon.agentProfiles[0].modeId = "ask";
  await save(path.join(state.home, "config.json"), config);
  config = await configurePaseo(state);
  assert.equal(config.daemon.agentProfiles[0].modeId, "ask");
});

test("configuration concurrent edit detection does not overwrite the user change", async (t) => {
  const file = path.join(await temporary(t), "config.json");
  await writeFile(file, "user changed it");
  await assert.rejects(save(file, { overwritten: true }, "old bytes"), /changed concurrently/);
  assert.equal(await readFile(file, "utf8"), "user changed it");
});

test("wrapper preserves native positional separator and pins all Paseo target selectors", () => {
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
    ["--format", "json", "daemon", "start"],
    ["--cwd", "project", "daemon", "run"],
    ["--provider=kiro-http", "start"],
  ])
    assert.throws(() => privatePaseoArgs(lifecycle, "private-home"), /Use start.cmd/);
  for (const offline of [["--version"], ["help"], ["status"], ["daemon", "status"]]) {
    assert.deepEqual(privatePaseoArgs(offline, "private-home"), [
      "--home",
      "private-home",
      ...offline,
    ]);
  }
});

test("main Paseo port is reserved and default private state stays on 16767", async (t) => {
  assert.throws(() => argumentsFor(["start", "--port", "6767"]), /main Paseo port/);
  const state = await initialize(path.join(await temporary(t), "state"));
  assert.equal(state.config.port, 16767);
  state.config.port = 6767;
  await save(state.configFile, state.config);
  await assert.rejects(initialize(state.root), /main Paseo port/);
});

test("auth help cannot masquerade as a successful login or logout and target store overrides fail closed", () => {
  assert.equal(authOperation(["login", "--help"]), "help");
  assert.equal(authOperation(["auth", "logout", "-h"]), "help");
  assert.equal(authOperation(["auth", "status", "--json"]), "auth status");
  assert.equal(
    authOperation(["auth", "import-cli", "--database", "source.sqlite3"]),
    "auth import-cli",
  );
  assert.equal(authOperation(["--provider", "google", "login"]), "login");
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
  for (const pid of [0, 1, -1, "123", undefined])
    assert.equal(hasLiveOwner({ ...owner, pid }, instance), false);
});
