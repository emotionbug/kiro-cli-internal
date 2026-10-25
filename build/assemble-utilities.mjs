import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { writeZip } from "./archive.mjs";

// Reuse the producer's pinned acquisition, safe extraction and process helpers.
export async function assembleUtilities({
  output,
  work,
  acquired,
  inputs,
  extract,
  tree,
  run,
  digest,
  json,
}) {
  const pythonRoot = path.join(output, "runtime/python");
  const toolsRoot = path.join(output, "runtime/tools");
  const licenses = path.join(output, "LICENSES");
  await mkdir(toolsRoot, { recursive: true });
  await mkdir(path.join(licenses, "sources"), { recursive: true });
  await extract(acquired.python, pythonRoot);
  assert.equal(
    (await readFile(path.join(pythonRoot, "python313._pth"), "utf8")).replaceAll("\r", ""),
    "python313.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n",
  );
  const bootstrap = path.join(work, "python-utility-config");
  await mkdir(bootstrap);
  await writeFile(
    path.join(bootstrap, "sitecustomize.py"),
    '# Bundle customization: UTF-8 utility pipes, including Windows CP949 hosts.\n# ZIP import keeps the extracted bundle read-only; -S explicitly bypasses this.\nimport sys\nfor stream in (sys.stdin, sys.stdout, sys.stderr):\n    if stream is not None:\n        stream.reconfigure(encoding="utf-8", errors="surrogateescape")\n',
  );
  await writeZip(
    bootstrap,
    await tree(bootstrap),
    path.join(pythonRoot, "utility-config.zip"),
    inputs.sourceDateEpoch,
  );
  await writeFile(
    path.join(pythonRoot, "python313._pth"),
    "# Bundle customization: isolated stdlib + UTF-8 stdio bootstrap.\npython313.zip\n.\nutility-config.zip\nimport site\n",
  );
  // CPython resolves python313._pth from its shared library, ahead of EXE names.
  await copyFile(path.join(pythonRoot, "python.exe"), path.join(pythonRoot, "python3.exe"));
  assert.equal(
    await digest(path.join(pythonRoot, "python.exe")),
    await digest(path.join(pythonRoot, "python3.exe")),
  );
  const sbom = JSON.parse(await readFile(acquired.pythonSbom, "utf8"));
  const pythonPackage = sbom.packages.find((item) => item.name === "CPython");
  assert.equal(pythonPackage.packageFileName, "python-3.13.12-embed-amd64.zip");
  assert.equal(
    pythonPackage.checksums.find((item) => item.algorithm === "SHA256").checksumValue,
    inputs.assets.python.sha256,
  );
  const signature = JSON.parse(await readFile(acquired.pythonSignature, "utf8"));
  assert.equal(signature.messageSignature.messageDigest.algorithm, "SHA2_256");
  assert.equal(
    Buffer.from(signature.messageSignature.messageDigest.digest, "base64").toString("hex"),
    inputs.assets.python.sha256,
  );
  // Retain upstream signing material; comparing its declared digest is not trust-root/signature verification.
  const rgRoot = path.join(toolsRoot, "ripgrep");
  await extract(acquired.rg, rgRoot, 1);
  await copyFile(path.join(rgRoot, "rg.exe"), path.join(toolsRoot, "rg.exe"));
  await copyFile(acquired.jq, path.join(toolsRoot, "jq.exe"));
  await extract(acquired.pythonSource, path.join(licenses, "python"), 1, (name) =>
    /(?:\/Doc\/license\.rst$|\/(?:LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*|COPYRIGHT[^/]*)$)/i.test(
      name,
    ),
  );
  await copyFile(
    path.join(pythonRoot, "LICENSE.txt"),
    path.join(licenses, "python/WINDOWS-BUILD-LICENSE.txt"),
  );
  await extract(acquired.jqSource, path.join(licenses, "jq"), 1, (name) =>
    /\/(?:COPYING[^/]*|LICENSE[^/]*|NOTICE[^/]*|AUTHORS)$/.test(name),
  );
  const licenseCopies = {
    pythonSource: "sources/Python-3.13.12.tgz",
    jqSource: "sources/jq-1.8.1.tar.gz",
    pythonSbom: "python/UPSTREAM-SBOM.spdx.json",
    pythonSignature: "python/UPSTREAM-EMBED.sigstore.json",
    pythonSourceSignature: "python/UPSTREAM-SOURCE.sigstore.json",
    opensslLicense: "python/OPENSSL-LICENSE.txt",
    opensslAuthors: "python/OPENSSL-AUTHORS.txt",
    gccRuntimeLicense: "jq/GCC-RUNTIME-EXCEPTION.txt",
    gccLicense: "jq/GCC-GPL3.txt",
    mingwLicense: "jq/MINGW-LICENSE.txt",
    mingwRuntimeNotices: "jq/MINGW-RUNTIME-NOTICES.txt",
    mingwThreadsLicense: "jq/MINGW-WINPTHREADS-LICENSE.txt",
    mingwAuthors: "jq/MINGW-AUTHORS.txt",
  };
  for (const [name, relative] of Object.entries(licenseCopies))
    await copyFile(acquired[name], path.join(licenses, relative));
  await writeFile(
    path.join(licenses, "UTILITY-CHANGES.txt"),
    'CPython 3.13.12 official embeddable Windows x64 package is retained with its native modules and upstream license. Changes: python313._pth enables import site and a relative utility-config.zip; that ZIP contains our sitecustomize.py which explicitly sets stdin/stdout/stderr to UTF-8 with surrogateescape. python3.exe is an unmodified byte-for-byte copy of python.exe. The standard-library ZIP and native binaries are unmodified. ZIP-imported startup customization does not create __pycache__. Normal isolated search paths do not implicitly import project CWD or script-directory modules; scripts may explicitly configure sys.path. PYTHONHOME/PYTHONPATH/PYTHONUTF8 are ignored by upstream isolated mode, not set globally by this bundle. Explicit -S bypasses our stdio customization. Text-file open() still needs encoding="utf-8" when portable UTF-8 files are intended. pip/ensurepip, Tk and full project environments are not provided. Use an explicitly activated project environment for project dependencies.\nRipgrep complete upstream portable ZIP is retained in runtime/tools/ripgrep; its unmodified executable is also exposed as runtime/tools/rg.exe. jq.exe is the unmodified upstream Windows amd64 executable. Complete jq source, incorporated license notices and supplementary GCC/MinGW runtime terms are retained. These supplemental license versions identify license text, not an assertion of the binary compiler version. Additional POSIX utilities remain in the complete Git for Windows distribution; no second Unix toolkit or utility daemon is installed.\n',
  );

  const staticImports = [];
  const osDlls = new Set([
    "kernel32.dll",
    "ntdll.dll",
    "advapi32.dll",
    "bcrypt.dll",
    "bcryptprimitives.dll",
    "ws2_32.dll",
    "iphlpapi.dll",
    "rpcrt4.dll",
    "user32.dll",
    "userenv.dll",
    "ole32.dll",
    "oleaut32.dll",
    "propsys.dll",
    "crypt32.dll",
    "winmm.dll",
    "version.dll",
    "shlwapi.dll",
  ]);
  const post17763 =
    /^(?:GetProcAddress2|GetTempPath2[AW]|GetSystemCpuSetInformationEx|SetProcessDefaultCpuSetMasks|GetProcessDefaultCpuSetMasks|SetThreadSelectedCpuSetMasks|GetThreadSelectedCpuSetMasks)$/;
  for (const relativeRoot of ["runtime/python", "runtime/tools"]) {
    const files = (await tree(path.join(output, relativeRoot))).filter((file) =>
      /\.(?:exe|dll|pyd)$/i.test(file.path),
    );
    const localDlls = new Set(
      files
        .filter((file) => /\.dll$/i.test(file.path))
        .map((file) => path.basename(file.path).toLowerCase()),
    );
    for (const file of files) {
      const relative = `${relativeRoot}/${file.path}`;
      const executable = path.join(output, relative);
      const bytes = await readFile(executable);
      assert.equal(bytes.toString("ascii", 0, 2), "MZ", relative);
      const pe = bytes.readUInt32LE(0x3c);
      assert.equal(bytes.toString("ascii", pe, pe + 4), "PE\0\0", relative);
      assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, `${relative}: x64 required`);
      const imports = await run("dumpbin.exe", ["/nologo", "/imports", executable], {
        capture: true,
      });
      const importedDlls = [
        ...new Set(
          [...imports.matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gim)].map((match) => match[1]),
        ),
      ].sort();
      const importedApis = [
        ...new Set(
          [...imports.matchAll(/^\s+[0-9A-F]+\s+([A-Za-z_?][^\s]+)\s*$/gim)].map(
            (match) => match[1],
          ),
        ),
      ].sort();
      for (const dll of importedDlls)
        assert.ok(
          localDlls.has(dll.toLowerCase()) ||
            osDlls.has(dll.toLowerCase()) ||
            /^api-ms-win-(?:crt-|core-(?:path-l1-1-0|synch-l1-2-0)\.dll$)/i.test(dll),
          `${relative}: unreviewed DLL ${dll}`,
        );
      assert.ok(
        !importedApis.some((name) => post17763.test(name)),
        `${relative}: known post-17763 direct API import`,
      );
      staticImports.push({
        path: relative,
        sha256: await digest(executable),
        machine: "AMD64",
        importedDlls,
        importedApis,
      });
    }
  }
  await json(path.join(licenses, "UTILITY-NATIVE-IMPORTS.json"), {
    scope:
      "All shipped utility EXE/DLL/PYD direct imports, DLL closure and selected known post-17763 API rejection only. Forwarders/dynamic resolution and actual Server 2019 execution remain unverified. No DLL/API shims.",
    server2019Verified: false,
    files: staticImports,
  });

  const env = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: work,
    TMP: work,
    USERPROFILE: work,
    LOCALAPPDATA: work,
    APPDATA: work,
    PATH: [
      pythonRoot,
      toolsRoot,
      path.join(output, "runtime/git/cmd"),
      path.join(output, "runtime/git/bin"),
      path.join(process.env.SystemRoot, "System32"),
    ].join(path.delimiter),
  };
  const pythonCode =
    'import sys,json,ssl,sqlite3,pathlib,subprocess,importlib.util; c=sqlite3.connect(":memory:"); c.execute("create table t(v)"); c.execute("insert into t values (?)", ("한글 😀",)); assert c.execute("select v from t").fetchone()[0] == "한글 😀"; ssl.create_default_context(); assert importlib.util.find_spec("pip") is None; assert importlib.util.find_spec("ensurepip") is None; assert sys.flags.isolated; assert all(s.encoding.lower() == "utf-8" for s in (sys.stdin,sys.stdout,sys.stderr)); print(json.dumps({"version":sys.version.split()[0],"paths":sys.path,"value":"한글 😀"},ensure_ascii=False))';
  const canonical = JSON.parse(
    await run(path.join(pythonRoot, "python.exe"), ["-c", pythonCode], { env, capture: true }),
  );
  const alias = JSON.parse(
    await run(path.join(pythonRoot, "python3.exe"), ["-c", pythonCode], { env, capture: true }),
  );
  assert.equal(canonical.version, inputs.assets.python.version);
  assert.equal(canonical.value, "한글 😀");
  assert.deepEqual(alias, canonical);
  const bashAlias = JSON.parse(
    await run(
      path.join(output, "runtime/git/bin/bash.exe"),
      ["--noprofile", "--norc", "-c", 'python3 -c "$1"', "utility-probe", pythonCode],
      { env, capture: true },
    ),
  );
  assert.deepEqual(bashAlias, canonical);
  const rgVersion = await run(path.join(toolsRoot, "rg.exe"), ["--version"], {
    env,
    capture: true,
  });
  assert.ok(
    rgVersion.startsWith(`ripgrep ${inputs.assets.rg.version}\n`) ||
      rgVersion.startsWith(`ripgrep ${inputs.assets.rg.version}\r\n`),
  );
  const jqVersion = (
    await run(path.join(toolsRoot, "jq.exe"), ["--version"], { env, capture: true })
  ).trim();
  assert.equal(jqVersion, `jq-${inputs.assets.jq.version}`);
  const fixture = path.join(work, "utility UTF-8 한글.json");
  await writeFile(fixture, '{"value":"한글 😀","count":7}\n');
  assert.equal(
    (
      await run(
        path.join(toolsRoot, "rg.exe"),
        ["--no-config", "--fixed-strings", "한글 😀", fixture],
        { env, capture: true },
      )
    ).trim(),
    '{"value":"한글 😀","count":7}',
  );
  assert.equal(
    (
      await run(path.join(toolsRoot, "jq.exe"), ["-r", ".value", fixture], { env, capture: true })
    ).trim(),
    "한글 😀",
  );
  assert.ok(!(await tree(pythonRoot)).some((file) => file.path.includes("__pycache__")));
  const manifest = {
    schemaVersion: 1,
    python: {
      version: inputs.assets.python.version,
      executable: "runtime/python/python.exe",
      isolated: true,
      pip: false,
      python3Alias: true,
      python3Executable: "runtime/python/python3.exe",
      stdioEncoding: "utf-8",
      implicitProjectImports: false,
      configuration: "runtime/python/utility-config.zip",
      stdioCustomizationBypassedBy: "-S",
      textFileEncoding: 'Explicit encoding="utf-8" recommended; locale defaults unchanged',
    },
    rg: { version: inputs.assets.rg.version, executable: "runtime/tools/rg.exe" },
    jq: { version: inputs.assets.jq.version, executable: "runtime/tools/jq.exe" },
    validation: {
      platform: process.platform,
      arch: process.arch,
      pythonStdlibSslSqlite: true,
      pythonAliasSamePaths: true,
      gitBashPython3: true,
      utf8PipedStdio: true,
      rgUtf8: true,
      jqUtf8: true,
      server2019Verified: false,
      scope:
        "Mandatory producer probes on the actual Windows build host; not Server 2019 execution evidence",
    },
  };
  await json(path.join(output, "manifests/utilities.json"), manifest);
  return manifest;
}
