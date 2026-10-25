// Windows-only, offline qualification of actual assembled utility executables.
// Run with any Node: node test/windows-utilities.mjs <absolute bundle root> [safe evidence directory]
// Only utilities.json survives; fixtures, private process identities and raw
// command output remain outside the bundle and are removed. No installer is run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { pathToFileURL } from "node:url";

const bundle = process.argv[2];
if (process.platform !== "win32" || process.arch !== "x64" || !bundle || !path.isAbsolute(bundle)) {
  console.error("Windows x64 and an absolute assembled bundle root are required.");
  process.exitCode = 1;
} else {
  const node = path.join(bundle, "runtime/node/node.exe");
  if ((await realpath(process.execPath)).toLowerCase() !== (await realpath(node)).toLowerCase()) {
    const child = spawn(node, [process.argv[1], ...process.argv.slice(2)], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => {
      console.error("Bundled Node launch failed.");
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  } else {
    await qualify();
  }
}

function contains(parent, child) {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function qualify() {
  const canonicalBundle = await realpath(bundle);
  const evidence = path.resolve(
    process.argv[3] ?? path.join(process.cwd(), "windows-utilities-evidence"),
  );
  assert.ok(!contains(canonicalBundle, evidence), "Evidence must be outside the bundle");
  await mkdir(evidence, { recursive: true });
  assert.ok(
    !contains(canonicalBundle, await realpath(evidence)),
    "Evidence must not resolve into the bundle",
  );
  const scratch = await mkdtemp(path.join(os.tmpdir(), "Kiro utilities 공간 "));
  assert.ok(
    !contains(canonicalBundle, await realpath(scratch)),
    "Fixtures must be outside the bundle",
  );
  const report = {
    qualification: "assembled Windows utilities: Python stdlib -> ripgrep -> jq",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    result: "failed",
    phase: "manifest",
    checks: [],
    scope:
      "offline fixture commands only; no package installation, network request, compiler or full project environment",
  };
  const active = new Set();
  const identities = new Map();
  let env;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const inspectionEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: path.join(systemRoot, "System32"),
    TEMP: scratch,
    TMP: scratch,
    USERPROFILE: scratch,
    APPDATA: scratch,
    LOCALAPPDATA: scratch,
  };

  function command(executable, args, { input, environment = env, timeout = 45000 } = {}) {
    const child = spawn(executable, args, {
      cwd: scratch,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    active.add(child);
    let stdout = "",
      stderr = "",
      bytes = 0,
      expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill();
    }, timeout);
    child.stdin.on("error", () => {});
    const done = new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      for (const [stream, append] of [
        [
          child.stdout,
          (text) => {
            stdout += text;
          },
        ],
        [
          child.stderr,
          (text) => {
            stderr += text;
          },
        ],
      ]) {
        stream.on("data", (text) => {
          bytes += Buffer.byteLength(text);
          if (bytes > 1024 * 1024) {
            expired = true;
            child.kill();
          } else append(text);
        });
      }
      child.once("error", (error) => {
        clearTimeout(timer);
        active.delete(child);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        active.delete(child);
        if (expired)
          reject(
            Object.assign(new Error("Owned command deadline or output bound exceeded"), {
              code: "UTILITY_COMMAND_BOUND",
            }),
          );
        else resolve({ code, signal, stdout, stderr });
      });
    });
    done.catch(() => {});
    if (input !== undefined) child.stdin.end(input);
    return { child, done };
  }
  async function ps(source) {
    const job = command(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, "utf16le").toString("base64"),
      ],
      { input: "", environment: inspectionEnv, timeout: 20000 },
    );
    const result = await job.done;
    assert.equal(result.code, 0, "Owned process inspection failed");
    return JSON.parse(result.stdout.trim());
  }
  async function identity(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "Invalid owned PID");
    const value = await ps(
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{pid=[int]$p.Id;created=$p.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress`,
    );
    assert.equal(value.pid, pid);
    assert.match(value.created, /^\d+$/);
    identities.set(pid, value.created);
    return value;
  }
  async function stillOwned({ pid, created }) {
    return ps(
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; [bool]($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${created}') | ConvertTo-Json -Compress`,
    );
  }
  async function runPipeline(executable, args, expectedExecutable, label) {
    const job = command(executable, args);
    let line = "",
      ready;
    const handshake = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Python readiness deadline exceeded")),
        15000,
      );
      const onData = (text) => {
        line += text;
        if (!line.includes("\n")) return;
        job.child.stdout.off("data", onData);
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line.slice(0, line.indexOf("\n"))));
        } catch {
          reject(new Error("Invalid Python readiness record"));
        }
      };
      job.child.stdout.on("data", onData);
      job.done.then(
        () => {
          clearTimeout(timer);
          reject(new Error("Python exited before readiness"));
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    try {
      ready = await handshake;
      assert.equal(ready.event, "ready");
      const owned = await identity(ready.pid);
      job.child.stdin.end("continue\n");
      const result = await job.done;
      assert.equal(result.code, 0, "Actual utility pipeline failed");
      assert.equal(result.stderr, "", "Utility pipeline emitted unexpected diagnostics");
      const lines = result.stdout
        .trim()
        .split(/\r?\n/)
        .map((value) => JSON.parse(value));
      assert.equal(lines.length, 2, "Unexpected pipeline output");
      const value = lines[1];
      assert.equal(value.event, "result");
      assert.equal(
        (await realpath(value.executable)).toLowerCase(),
        (await realpath(expectedExecutable)).toLowerCase(),
        "Python must resolve to the bundled interpreter",
      );
      assert.equal(value.version, report.versions.python);
      assert.deepEqual(value.pipeline, {
        total: 7,
        unicode: "정확한 내용 한글 ✓",
        line: 2,
        matches: 1,
        numeric: "number",
        sqlite: "한글 SQLite ✓",
      });
      assert.equal(value.isolated, true);
      assert.equal(value.stdioUtf8, true);
      assert.equal(value.sslVerifiedContext, true);
      assert.equal(value.pipAbsent, true);
      assert.equal(
        await stillOwned(owned),
        false,
        "Owned Python incarnation survived command exit",
      );
      identities.delete(owned.pid);
      report.checks.push({
        command: label,
        result: "passed",
        ownedPythonExited: true,
        pipeline: value.pipeline,
        ssl: value.sslVersion,
        sqlite: value.sqliteVersion,
      });
    } finally {
      if (active.has(job.child)) job.child.kill();
    }
  }

  try {
    const manifest = JSON.parse(
      await readFile(path.join(bundle, "manifests/utilities.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.python.executable, "runtime/python/python.exe");
    assert.equal(manifest.rg.executable, "runtime/tools/rg.exe");
    assert.equal(manifest.jq.executable, "runtime/tools/jq.exe");
    assert.equal(manifest.python.isolated, true);
    assert.equal(manifest.python.pip, false);
    assert.equal(manifest.python.stdioEncoding, "utf-8");
    assert.equal(manifest.python.implicitProjectImports, false);
    assert.equal(typeof manifest.python.python3Alias, "boolean");
    if (manifest.python.python3Alias)
      assert.equal(manifest.python.python3Executable, "runtime/python/python3.exe");
    report.versions = Object.fromEntries(
      ["python", "rg", "jq"].map((key) => [key, manifest[key].version]),
    );
    report.contract = {
      pip: false,
      python3Alias: manifest.python.python3Alias,
      stdioEncoding: "utf-8",
      implicitProjectImports: false,
    };
    report.phase = "relocation";
    const relocated = path.join(scratch, "portable bundle 한글 spaces");
    // Exercise real relocation rather than a junction that could hide path bugs.
    // No state initialization, authentication, npm, compiler or installer is used.
    await mkdir(path.join(relocated, "app/lib"), { recursive: true });
    await mkdir(path.join(relocated, "runtime"), { recursive: true });
    for (const directory of ["node", "python", "tools", "git"]) {
      await cp(
        path.join(bundle, "runtime", directory),
        path.join(relocated, "runtime", directory),
        { recursive: true, errorOnExist: true, force: false },
      );
    }
    await cp(path.join(bundle, "app/lib/state.mjs"), path.join(relocated, "app/lib/state.mjs"));
    const files = [
      "runtime/node/node.exe",
      manifest.python.executable,
      manifest.rg.executable,
      manifest.jq.executable,
      "runtime/git/bin/bash.exe",
    ];
    if (manifest.python.python3Alias) files.push(manifest.python.python3Executable);
    report.hashes = {};
    for (const file of files) {
      const original = await digest(path.join(bundle, file));
      assert.equal(await digest(path.join(relocated, file)), original, "Relocated binary changed");
      report.hashes[file] = original;
    }
    const workspace = path.join(scratch, "consumer workspace 작업");
    const home = path.join(scratch, "isolated home 사용자");
    await mkdir(workspace);
    await mkdir(home);
    const { runtimeEnv } = await import(
      pathToFileURL(path.join(relocated, "app/lib/state.mjs")).href
    );
    env = runtimeEnv(
      {
        root: home,
        home: path.join(home, "paseo"),
        authFile: path.join(home, "unused-auth.json"),
        config: { nodeHeapMb: 128 },
      },
      {
        ...inspectionEnv,
        USERPROFILE: home,
        HOME: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        // No user PATH, Python installation, registry selection, profile or toolchain.
        PATH: path.join(systemRoot, "System32"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(home, "absent-gitconfig"),
        BASH_ENV: "",
        ENV: "",
        MSYS_NO_PATHCONV: "1",
        MSYS2_ARG_CONV_EXCL: "*",
      },
    );
    const script = path.join(workspace, "stdlib pipeline 한글.py");
    await writeFile(script, pythonFixture(), "utf8");
    assert.ok(rootCertificates.length > 0, "Bundled Node must provide a public CA fixture");
    const publicCa = path.join(workspace, "공개 인증서 CA.pem");
    await writeFile(publicCa, rootCertificates[0], "ascii");
    report.publicCaSha256 = await digest(publicCa);
    const python = path.join(relocated, manifest.python.executable);
    const rg = path.join(relocated, manifest.rg.executable);
    const jq = path.join(relocated, manifest.jq.executable);
    report.phase = "versions";
    for (const [name, executable, versionArgs, prefix] of [
      ["rg", rg, ["--version"], "ripgrep "],
      ["jq", jq, ["--version"], "jq-"],
    ]) {
      const result = await command(executable, versionArgs, { input: "" }).done;
      assert.equal(result.code, 0, "Utility version command failed");
      assert.equal(result.stdout.trim().split(/\r?\n/)[0], `${prefix}${manifest[name].version}`);
    }
    report.phase = "native-python-pipeline";
    await runPipeline(
      "python",
      [script, path.join(workspace, "native fixture 데이터"), python, rg, jq],
      python,
      "PATH python",
    );
    report.phase = "git-bash-python-pipeline";
    const bash = path.join(relocated, "runtime/git/bin/bash.exe");
    await runPipeline(
      bash,
      [
        "--noprofile",
        "--norc",
        "-c",
        'exec python "$@"',
        "utility-smoke",
        script,
        path.join(workspace, "bash fixture 데이터"),
        python,
        rg,
        jq,
      ],
      python,
      "Git Bash python",
    );
    if (manifest.python.python3Alias) {
      report.phase = "git-bash-python3-pipeline";
      const python3 = path.join(relocated, manifest.python.python3Executable);
      await runPipeline(
        bash,
        [
          "--noprofile",
          "--norc",
          "-c",
          'exec python3 "$@"',
          "utility-smoke",
          script,
          path.join(workspace, "python3 fixture 데이터"),
          python,
          rg,
          jq,
          python3,
        ],
        python3,
        "Git Bash python3",
      );
    }
    report.checks.push({
      check: "pip not shipped per declared manifest; no bootstrap attempted",
      result: "passed",
    });
    report.result = "passed";
    report.phase = "complete";
  } catch (error) {
    // Never serialize command output, paths, environment, PID/creation-time data,
    // arbitrary exception text or user/machine identifiers into public evidence.
    report.failure = {
      classification: ["ENOENT", "EACCES", "EPERM", "UTILITY_COMMAND_BOUND"].includes(error?.code)
        ? error.code
        : "UTILITY_QUALIFICATION_FAILED",
    };
    process.exitCode = 1;
  } finally {
    // Kill only recorded PID incarnations, never a global process-name match.
    try {
      for (const [pid, created] of identities) {
        await ps(
          `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${created}') {Stop-Process -Id ${pid} -Force -ErrorAction Stop}; 'true'`,
        );
        assert.equal(
          await stillOwned({ pid, created }),
          false,
          "Owned utility did not exit during cleanup",
        );
      }
      for (const child of active) child.kill();
    } catch {
      report.result = "failed";
      report.failure = { classification: "OWNED_PROCESS_CLEANUP_FAILED" };
      process.exitCode = 1;
    }
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    } catch {
      report.result = "failed";
      report.failure = { classification: "FIXTURE_CLEANUP_FAILED" };
      process.exitCode = 1;
    }
    await writeFile(path.join(evidence, "utilities.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    report.result === "passed"
      ? "Windows utility qualification passed."
      : "Windows utility qualification failed; see safe utilities.json.",
  );
}

function pythonFixture() {
  return String.raw`import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import ssl
import subprocess
import sys

print(json.dumps({"event": "ready", "pid": os.getpid()}), flush=True)
assert sys.stdin.readline().strip() == "continue"
root = Path(sys.argv[1])
expected_python, expected_rg, expected_jq = map(Path, sys.argv[2:5])
assert Path(sys.executable).samefile(Path(sys.argv[5]) if len(sys.argv) > 5 else expected_python)
if len(sys.argv) > 5:
    assert Path(shutil.which("python3")).samefile(Path(sys.argv[5]))
assert Path(shutil.which("python")).samefile(expected_python)
assert Path(shutil.which("rg")).samefile(expected_rg)
assert Path(shutil.which("jq")).samefile(expected_jq)
assert sys.flags.isolated == 1 and sys.flags.ignore_environment == 1 and sys.flags.no_user_site == 1
assert all(Path(entry).resolve() != Path.cwd().resolve() for entry in sys.path if entry)
assert sys.stdin.encoding.lower().replace("_", "-") == "utf-8"
assert sys.stdout.encoding.lower().replace("_", "-") == "utf-8"
assert sys.stderr.encoding.lower().replace("_", "-") == "utf-8"
assert importlib.util.find_spec("pip") is None
root.mkdir()
needle = "정확한 내용 한글 ✓"
source = root / "입력 데이터" / "검색 결과 한글.txt"
source.parent.mkdir()
source.write_text("header\n" + needle + "\n", encoding="utf-8")
assert source.read_text(encoding="utf-8") == "header\n" + needle + "\n"
(root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
for relative in ["ignored/무시 한글.txt", "excluded/제외 한글.txt", "다른 형식.md", ".hidden.txt"]:
    filename = root / relative
    filename.parent.mkdir(exist_ok=True)
    filename.write_text(needle + "\n", encoding="utf-8")
with sqlite3.connect(root / "임시 데이터.sqlite") as connection:
    connection.execute("create table records (label text not null, amount integer not null)")
    connection.execute("insert into records values (?, ?)", ("한글 SQLite ✓", 7))
    connection.commit()
with sqlite3.connect(root / "임시 데이터.sqlite") as connection:
    row = connection.execute("select label, amount, typeof(amount) from records").fetchone()
assert row == ("한글 SQLite ✓", 7, "integer")
context = ssl.create_default_context(cafile=str(root.parent / "공개 인증서 CA.pem"))
assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
assert context.cert_store_stats()["x509_ca"] >= 1 and len(context.get_ca_certs()) >= 1
assert ssl.OPENSSL_VERSION.startswith("OpenSSL ")
search = subprocess.run(["rg", "--json", "--line-number", "--fixed-strings", "--no-require-git", "--type-add", "fixture:*.txt", "--type", "fixture", "--glob", "!excluded/**", "--", needle, "."], cwd=root, stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8", errors="strict", timeout=15, check=True)
assert search.stderr == ""
matches = [json.loads(line)["data"] for line in search.stdout.splitlines() if json.loads(line)["type"] == "match"]
assert len(matches) == 1
match = matches[0]
assert (root / match["path"]["text"]).samefile(source)
assert match["line_number"] == 2 and match["lines"]["text"] == needle + "\n"
document = {"rows": [{"label": needle, "count": row[1]}], "matches": [{"line": match["line_number"], "text": needle}], "sqlite": row[0]}
json_file = root / "구조화된 결과 데이터.json"
json_file.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
assert json.loads(json_file.read_text(encoding="utf-8")) == document
filtered = subprocess.run(["jq", "-ce", "{total: ([.rows[].count] | add), unicode: .rows[0].label, line: .matches[0].line, matches: (.matches | length), numeric: (.rows[0].count | type), sqlite: .sqlite}", str(json_file)], cwd=root, stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8", errors="strict", timeout=15, check=True)
assert filtered.stderr == ""
result = json.loads(filtered.stdout)
assert type(result["total"]) is int and type(result["line"]) is int
print(json.dumps({"event": "result", "executable": sys.executable, "version": ".".join(map(str, sys.version_info[:3])), "pipeline": result, "isolated": True, "stdioUtf8": True, "sslVerifiedContext": True, "sslVersion": ssl.OPENSSL_VERSION, "sqliteVersion": sqlite3.sqlite_version, "pipAbsent": True}, ensure_ascii=False), flush=True)
`;
}
