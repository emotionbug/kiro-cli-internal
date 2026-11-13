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
    `A complete bundle must be built on Windows x64: native Passession, OMP, utilities and the WinHTTP/SSPI helper must execute under bundled Node ${inputs.assets.node.version}.`,
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
const producerAbort = new AbortController();
let producerStage = "startup";
let commandSupervisor;
function checkpoint(name) {
  producerAbort.signal.throwIfAborted();
  producerStage = name;
  process.stderr.write(`[build] ${name}\n`);
}
function interrupt(signal) {
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  producerAbort.abort(new Error(`Build interrupted by ${signal} during ${producerStage}`));
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

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
async function run(
  command,
  args,
  {
    cwd = work,
    env = process.env,
    capture = false,
    phase = path.basename(command),
    timeoutMs = 120000,
  } = {},
) {
  producerAbort.signal.throwIfAborted();
  const label = `${producerStage}/${path.basename(phase).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const started = Date.now();
  const captureLimit = 16 * 1024 * 1024;
  const drainMs = 5000;
  process.stderr.write(`[build] ${label} started; deadline ${timeoutMs}ms\n`);
  return new Promise((resolve, reject) => {
    let child;
    let exited = false;
    let settled = false;
    let failure;
    let outputBytes = 0;
    const stdout = [];
    let drainTimer;
    let cleanupTimer;
    let deadlineTimer;
    const error = (reason) =>
      new Error(`[build] ${label} ${reason} after ${Date.now() - started}ms`);
    const finish = (problem, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(drainTimer);
      clearTimeout(cleanupTimer);
      producerAbort.signal.removeEventListener("abort", onAbort);
      child?.stdin?.destroy();
      if (problem) reject(problem);
      else {
        process.stderr.write(`[build] ${label} completed in ${Date.now() - started}ms\n`);
        resolve(value);
      }
    };
    const terminate = (problem) => {
      if (settled || failure) return;
      failure = problem;
      clearTimeout(deadlineTimer);
      clearTimeout(drainTimer);
      // ChildProcess.kill uses the owned process handle on Windows, not a PID lookup.
      // The supervisor's non-inherited job handle closes with it and kills its entire job.
      if (child?.pid && !exited) {
        try {
          if (!child.kill("SIGKILL"))
            failure = error(`${problem.message}; owned process termination was unavailable`);
        } catch {
          failure = error(`${problem.message}; owned process termination failed`);
        }
      }
      cleanupTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        finish(
          error(
            `${failure.message}; owned process/pipes did not close within ${drainMs}ms of termination`,
          ),
        );
      }, drainMs);
    };
    const onAbort = () => terminate(error("interrupted"));
    producerAbort.signal.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(
      () => terminate(error(`exceeded its ${timeoutMs}ms deadline`)),
      timeoutMs,
    );
    try {
      child = spawn(commandSupervisor ?? command, commandSupervisor ? [command, ...args] : args, {
        cwd,
        env,
        windowsHide: true,
        // The supervisor's stdin is an ownership lease; its target receives NUL.
        stdio: [
          commandSupervisor ? "pipe" : "ignore",
          capture ? "pipe" : "inherit",
          capture ? "pipe" : "inherit",
        ],
      });
    } catch (problem) {
      finish(error(`could not start (${problem.code ?? "spawn failure"})`));
      return;
    }
    if (capture) {
      const captureData = (data, isStderr) => {
        if (settled) return;
        outputBytes += data.length;
        if (outputBytes > captureLimit) {
          terminate(
            error(`exceeded the ${captureLimit}-byte combined stdout/stderr capture limit`),
          );
          return;
        }
        if (isStderr) process.stderr.write(data);
        else if (!failure) stdout.push(data);
      };
      child.stdout.on("data", (data) => captureData(data, false));
      child.stderr.on("data", (data) => captureData(data, true));
      child.stdout.on("error", () => terminate(error("stdout capture failed")));
      child.stderr.on("error", () => terminate(error("stderr capture failed")));
    }
    child.once("error", (problem) =>
      terminate(error(`could not start or terminate (${problem.code ?? "process error"})`)),
    );
    child.stdin?.on("error", () => terminate(error("owned process lease failed")));
    child.once("exit", () => {
      exited = true;
      if (failure || settled) return;
      // Resolve only on close (including pipe EOF), but never wait indefinitely for inherited pipes.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(error(`stdout/stderr did not reach EOF within ${drainMs}ms of process exit`));
      }, drainMs);
    });
    child.once("close", (code, signal) => {
      if (failure) finish(failure);
      else if (code !== 0) finish(error(`failed (${signal ?? code})`));
      else finish(null, capture ? Buffer.concat(stdout).toString("utf8") : "");
    });
  });
}

async function prepareCommandSupervisor() {
  const source = path.join(work, "owned-command.cs");
  const executable = path.join(work, "owned-command.exe");
  // Build-only helper: atomically assign targets to a kill-on-close Job Object at
  // CreateProcess time, including the interval before the target starts executing.
  // No process-name/PID-tree termination, suspended orphan, or shipped runtime dependency.
  await writeFile(
    source,
    String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class OwnedCommand {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfo {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort ShowWindow, ReservedBytes;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfoEx {
    public StartupInfo Startup;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Size;
    public IntPtr Descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  private static string Quote(string value) {
    // Match libuv argv quoting; SFX launchers may parse their own switches.
    if (value.Length > 0 && value.IndexOf(' ') < 0 && value.IndexOf('\t') < 0 && value.IndexOf('"') < 0)
      return value;
    var text = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') text.Append('\\', slashes * 2 + 1).Append('"');
      else text.Append('\\', slashes).Append(character);
      slashes = 0;
    }
    return text.Append('\\', slashes * 2).Append('"').ToString();
  }
  private static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static int Main(string[] args) {
    IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobValue = IntPtr.Zero, input = IntPtr.Zero;
    bool attributesInitialized = false;
    ProcessInfo process = new ProcessInfo();
    try {
      if (args.Length == 0) return 125;
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero);
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      // Parent pipe EOF also closes our job if the producer is killed without a signal.
      var lease = new System.Threading.Thread(delegate() {
        try { Console.OpenStandardInput().ReadByte(); } catch { }
        Environment.Exit(125);
      });
      lease.IsBackground = true;
      lease.Start();
      var security = new SecurityAttributes();
      security.Size = Marshal.SizeOf(typeof(SecurityAttributes));
      security.Inherit = true;
      input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
      Check(input != new IntPtr(-1));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      Check(size != IntPtr.Zero);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
      attributesInitialized = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobValue, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: supported by Windows 10 / Server 2016+.
      Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x0002000D, jobValue, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
      var startup = new StartupInfoEx();
      startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Startup.Flags = 0x00000101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW (SW_HIDE)
      startup.Startup.Input = input;
      startup.Startup.Output = GetStdHandle(-11);
      startup.Startup.Error = GetStdHandle(-12);
      startup.Attributes = attributes;
      var command = new StringBuilder(String.Join(" ", Array.ConvertAll(args, Quote)));
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW. Environment/CWD are inherited.
      Check(CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out process));
      Check(WaitForSingleObject(process.Process, 0xffffffff) == 0);
      uint exitCode;
      Check(GetExitCodeProcess(process.Process, out exitCode));
      return unchecked((int)exitCode);
    } catch (Win32Exception error) {
      Console.Error.WriteLine("owned-command startup/wait failed (Win32 " + error.NativeErrorCode + ")");
      return 125;
    } catch {
      Console.Error.WriteLine("owned-command supervisor failed");
      return 125;
    } finally {
      // Kill any remaining descendants before closing our inherited output handles.
      if (job != IntPtr.Zero) CloseHandle(job);
      if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
    }
  }
}
`,
  );
  // Inbox Framework csc is a single owned process, without a shell or compiler server.
  await run(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    ),
    ["/nologo", "/optimize+", "/platform:x64", "/target:exe", `/out:${executable}`, source],
    { phase: "compile-owned-command.exe", timeoutMs: 60000 },
  );
  commandSupervisor = executable;
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
    signal: AbortSignal.any([producerAbort.signal, AbortSignal.timeout(600000)]),
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
  const members = (
    await run(systemTar, ["-tf", archive], {
      capture: true,
      phase: `${path.basename(destination)}-list`,
    })
  )
    .split(/\r?\n/)
    .filter(Boolean);
  for (const member of members) assertSafeMember(member);
  let selection = [];
  if (include) {
    const selected = members.filter((member) => !member.endsWith("/") && include(member));
    if (!selected.length)
      throw new Error("Required source notices are absent from the pinned archive");
    const list = path.join(work, "archive-selection.txt");
    await writeFile(list, `${selected.join("\n")}\n`);
    selection = ["-T", list];
  }
  await run(
    systemTar,
    [
      "-xmf",
      archive,
      "-C",
      destination,
      ...(strip ? ["--strip-components", String(strip)] : []),
      ...selection,
    ],
    { phase: `${path.basename(destination)}-extract` },
  );
  await tree(destination); // Reject every link, including links that point inside the tree.
}
function assertSafeMember(member) {
  const normalized = member.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  )
    throw new Error(`Unsafe archive member: ${member}`);
}
// Pinned 7-Zip reads archive formats Windows tar cannot (7z SFX, NSIS) without executing them.
async function unpack(tool, archive, destination) {
  await mkdir(destination, { recursive: true });
  const members = (
    await run(tool, ["l", "-slt", "-ba", "-sccUTF-8", archive], {
      capture: true,
      phase: `${path.basename(destination)}-list`,
    })
  )
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length));
  if (!members.length) throw new Error(`No members listed in ${path.basename(archive)}`);
  for (const member of members) assertSafeMember(member);
  await run(tool, ["x", "-y", "-bd", "-sccUTF-8", `-o${destination}`, archive], {
    capture: true,
    phase: `${path.basename(destination)}-extract`,
  });
  return tree(destination); // Reject every link, including links that point inside the tree.
}
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Both Passession payloads carry upstream identity markers; they must match the pinned release.
async function passessionIdentity(directory, installationKind) {
  const pin = inputs.assets.passessionDaemon;
  const relative = path.relative(output, directory).replaceAll("\\", "/");
  const runtime = JSON.parse(await readFile(path.join(directory, "paseo-runtime.json"), "utf8"));
  const provenance = JSON.parse(
    await readFile(path.join(directory, "bundle-provenance.json"), "utf8"),
  );
  for (const marker of [runtime, provenance]) {
    if (
      marker.version !== pin.version ||
      marker.sourceSha !== pin.commit ||
      marker.installationKind !== installationKind ||
      marker.platform !== "windows" ||
      marker.arch !== "x64" ||
      marker.runtime !== "rust" ||
      marker.release !== true
    )
      throw new Error(`Passession identity marker differs from the pinned release: ${relative}`);
  }
  if (provenance.repository !== "emotionbug/Passession" || provenance.sourceDirty !== false)
    throw new Error(`Passession provenance is not the official clean release: ${relative}`);
  const sha256 = await digest(path.join(directory, "paseo.exe"));
  if (sha256 !== provenance.executableSha256 || sha256 !== pin.executableSha256)
    throw new Error(`Passession executable digest differs from provenance/pin: ${relative}`);
  return {
    version: pin.version,
    commit: pin.commit,
    root: relative,
    executable: `${relative}/paseo.exe`,
    sha256,
    installationKind,
  };
}
// Static ESM import closure from package entries. Relative modules must exist inside the package;
// bare specifiers must be host-provided (Node/Bun builtins, OMP's @oh-my-pi/pi-ai). Fail closed.
async function moduleClosure(root, entries) {
  const files = new Set();
  const hostModules = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift();
    if (files.has(name)) continue;
    const text = await readFile(path.join(root, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") throw new Error(`Plugin module missing: ${name}`);
      throw error;
    });
    files.add(name);
    for (const match of text.matchAll(
      /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm,
    )) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
        if (resolved.startsWith("../"))
          throw new Error(`Plugin module escapes its package: ${name} -> ${specifier}`);
        queue.push(resolved);
      } else if (/^(?:node|bun):/.test(specifier) || specifier === "@oh-my-pi/pi-ai") {
        hostModules.add(specifier);
      } else {
        throw new Error(`Plugin OMP closure imports an unbundled package: ${name} -> ${specifier}`);
      }
    }
  }
  return { files, hostModules };
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
  checkpoint("owned-process-supervisor");
  await prepareCommandSupervisor();
  checkpoint("payload");
  const payload = path.join(repo, "payload");
  await guardPayload(payload);
  await mkdir(output);
  await copyTree(payload, output);
  const acquired = {};
  for (const name of Object.keys(inputs.assets)) {
    checkpoint(`acquire-${name}`);
    acquired[name] = await acquire(name);
  }
  checkpoint("node");
  const nodeExtract = path.join(work, "node");
  await extract(acquired.node, nodeExtract, 1);
  await copyTree(nodeExtract, path.join(output, "runtime/node"));
  checkpoint("git");
  const gitRoot = path.join(output, "runtime/git");
  await mkdir(gitRoot, { recursive: true });
  await run(acquired.git, ["-y", `-o${gitRoot}`], { phase: "PortableGit.exe", timeoutMs: 180000 });
  checkpoint("utilities");
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
  checkpoint("native-proxy");
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
  checkpoint("seven-zip");
  // Build-host tool only: 7zr.exe reads the official 7-Zip 7z archive, whose full 7z.exe/7z.dll
  // then read the NSIS desktop installer. No installer is executed and 7-Zip is not shipped.
  const sevenZipRoot = path.join(work, "7-zip");
  const sevenZipFiles = (await unpack(acquired.sevenZipBootstrap, acquired.sevenZip, sevenZipRoot))
    .map((file) => file.path);
  for (const required of ["7z.exe", "7z.dll"])
    if (!sevenZipFiles.includes(required)) throw new Error(`Pinned 7-Zip lacks ${required}`);
  const sevenZip = path.join(sevenZipRoot, "7z.exe");
  checkpoint("passession-daemon");
  const passessionRoot = path.join(output, "runtime/passession");
  await extract(acquired.passessionDaemon, passessionRoot);
  const passessionDaemon = await passessionIdentity(passessionRoot, "standalone-archive");
  checkpoint("passession-app");
  const installer = path.join(work, "passession-app-installer");
  const installerFiles = (await unpack(sevenZip, acquired.passessionApp, installer))
    .map((file) => file.path)
    .filter((name) => !name.startsWith("$PLUGINSDIR/")); // NSIS installer UI plugins
  const inventoryName = ".paseo-sessions-owned-files";
  // The installer's own inventory is the authority for its payload; any drift fails the build.
  const owned = (await readFile(path.join(installer, inventoryName), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((name) => name.replaceAll("\\", "/"))
    .sort(ordinal);
  if (JSON.stringify(owned) !== JSON.stringify([...installerFiles].sort(ordinal)))
    throw new Error("Desktop installer payload differs from its owned-file inventory");
  const installerOnly = ["Uninstall.exe", inventoryName];
  const passessionAppRoot = path.join(output, "runtime/passession-app");
  await copyTree(
    installer,
    passessionAppRoot,
    (name) => !installerOnly.includes(name) && owned.includes(name),
  );
  const passessionAppDaemon = await passessionIdentity(
    path.join(passessionAppRoot, "runtime"),
    "desktop-bundled",
  );
  const desktopDescriptor = JSON.parse(
    await readFile(path.join(passessionAppRoot, "runtime/desktop-runtime.json"), "utf8"),
  );
  if (desktopDescriptor.executable !== "paseo.exe")
    throw new Error("Desktop runtime descriptor does not name its bundled daemon");
  checkpoint("omp");
  const ompExecutable = path.join(output, "runtime/omp/omp.exe");
  await mkdir(path.dirname(ompExecutable), { recursive: true });
  await copyFile(acquired.omp, ompExecutable);
  checkpoint("omp-network-policy");
  for (const name of ["ompCatalog", "ompProviderRules"])
    if (inputs.assets[name].version !== inputs.assets.omp.version)
      throw new Error(`${name} must match the pinned OMP executable version`);
  const ompCatalog = JSON.parse(await readFile(acquired.ompCatalog, "utf8"));
  const ompRules = JSON.parse(await readFile(acquired.ompProviderRules, "utf8"));
  if (ompCatalog.version !== 1 || !Array.isArray(ompCatalog.providers) ||
      !ompRules.providers || typeof ompRules.providers !== "object" || Array.isArray(ompRules.providers))
    throw new Error("Unsupported OMP provider inventory format");
  const disabledProviders = [...new Set([
    ...ompCatalog.providers.map((row) => row[0]),
    ...Object.keys(ompRules.providers),
  ])].sort();
  if (!disabledProviders.length ||
      disabledProviders.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id) || id === "kiro-http"))
    throw new Error("Invalid built-in OMP provider inventory");
  await json(path.join(output, "app/omp-network-policy.json"), {
    disabledProviders,
    startup: { checkUpdate: false, setupWizard: false },
    update: { auto: false },
    marketplace: { autoUpdate: "off" },
  });
  checkpoint("native-runtime-imports");
  // Upstream executables are shipped unmodified; their direct DLL imports are recorded, not shimmed.
  const nativeRuntimeImports = [];
  for (const relative of [
    "runtime/passession/paseo.exe",
    "runtime/passession-app/paseo_sessions.exe",
    "runtime/passession-app/runtime/paseo.exe",
    "runtime/omp/omp.exe",
  ]) {
    const executable = path.join(output, relative);
    const dependents = await run("dumpbin.exe", ["/nologo", "/dependents", executable], {
      capture: true,
    });
    const importedDlls = [
      ...new Set(
        [...dependents.matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gim)].map((match) =>
          match[1].toLowerCase(),
        ),
      ),
    ].sort();
    if (!importedDlls.length) throw new Error(`No direct imports read from ${relative}`);
    const besideExecutable = new Set(
      (await readdir(path.dirname(executable))).map((name) => name.toLowerCase()),
    );
    nativeRuntimeImports.push({
      path: relative,
      sha256: await digest(executable),
      importedDlls,
      bundledBesideExecutable: importedDlls.filter((name) => besideExecutable.has(name)),
    });
  }
  const desktopImports = nativeRuntimeImports.find(
    (item) => item.path === "runtime/passession-app/paseo_sessions.exe",
  ).importedDlls;
  const desktopRequiresMediaFoundation = desktopImports.some((name) =>
    /^(?:mfplat|mf|mfreadwrite)\.dll$/.test(name),
  );
  checkpoint("plugin");
  const source = path.join(work, "plugin");
  await extract(acquired.plugin, source, 1);
  const plugin = path.join(output, "app/plugin/omp-kiro");
  const published = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  if (published.version !== inputs.assets.plugin.version)
    throw new Error("Plugin source version does not match pin");
  if (JSON.stringify(published.omp?.extensions) !== JSON.stringify(["./index.js"]))
    throw new Error("Plugin OMP extension entry changed");
  // Passession 0.13.15 loads only native Rust plugins, so omp-kiro's JavaScript Paseo provider
  // (index.server.ts, server/provider|tools|mcp|usage-source.mjs) cannot load and is not shipped.
  // Ship the exact static module closure of the OMP extension and the auth CLI.
  const pluginClosure = await moduleClosure(source, ["index.js", "auth-cli.mjs"]);
  const pluginShipped = (name) =>
    pluginClosure.files.has(name) || /^(?:docs\/|LICENSE$|README\.md$|icon\.svg$)/.test(name);
  await copyTree(source, plugin, pluginShipped);
  const {
    scripts,
    dependencies: pluginDependencies,
    devDependencies,
    files: publishedFiles,
    ...productionManifest
  } = published;
  await json(path.join(plugin, "package.json"), productionManifest);
  await json(path.join(plugin, "BUNDLE-PROJECTION.json"), {
    upstream: inputs.assets.plugin,
    entries: ["index.js", "auth-cli.mjs"],
    moduleClosure: [...pluginClosure.files].sort(ordinal),
    hostModules: [...pluginClosure.hostModules].sort(ordinal),
    omittedFiles: (await tree(source))
      .map((file) => file.path)
      .filter((name) => !pluginShipped(name)),
    modifications: [
      "Only the static module closure of the OMP extension (index.js) and auth CLI (auth-cli.mjs), with docs, README, LICENSE and icon, is shipped; the JavaScript Paseo provider files are omitted because Passession loads only native plugins",
      "package.json: removed scripts, devDependencies, the publish file list and npm dependencies (@modelcontextprotocol/sdk, ajv), which only the omitted Paseo provider imports; @oh-my-pi/pi-ai remains a host-supplied optional peer",
    ],
    originalPackageManifest: published,
  });
  checkpoint("npm-ci");
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
    { cwd: app, env, phase: "npm-cli.js", timeoutMs: 180000 },
  );
  checkpoint("required-payload");
  for (const relative of [
    "paseo.cmd",
    "omp.cmd",
    "app.cmd",
    "app/lib/run.mjs",
    "app/omp-network-policy.json",
    "runtime/node/node.exe",
    "runtime/git/bin/bash.exe",
    "runtime/git/cmd/git.exe",
    "runtime/proxy/kiro-proxy.exe",
    "runtime/passession/paseo.exe",
    "runtime/passession/LICENSE",
    "runtime/passession/THIRD-PARTY-NOTICES.txt",
    "runtime/passession-app/paseo_sessions.exe",
    "runtime/passession-app/LICENSE",
    "runtime/passession-app/THIRD-PARTY-NOTICES.txt",
    "runtime/passession-app/runtime/paseo.exe",
    "runtime/passession-app/runtime/desktop-runtime.json",
    "runtime/omp/omp.exe",
    "app/plugin/omp-kiro/index.js",
    "app/plugin/omp-kiro/auth-cli.mjs",
    "app/plugin/omp-kiro/server/auth.mjs",
    "app/plugin/omp-kiro/server/model-catalog.mjs",
    "app/plugin/omp-kiro/server/http.mjs",
    "app/plugin/omp-kiro/server/usage.mjs",
    "app/node_modules/@clack/prompts/package.json",
    "app/node_modules/proxy-agent/package.json",
    "app/node_modules/undici/package.json",
  ])
    await assertFile(relative);
  const probeEnv = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    WINDIR: process.env.WINDIR,
    SystemDrive: process.env.SystemDrive,
    ProgramFiles: process.env.ProgramFiles,
    "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
    ProgramW6432: process.env.ProgramW6432,
    PSModulePath: process.env.PSModulePath,
    TEMP: work,
    TMP: work,
    USERPROFILE: work,
    LOCALAPPDATA: work,
    APPDATA: work,
    PATH: env.PATH,
  };
  checkpoint("native-validation");
  const validationText = await run(node, [path.join(repo, "build/validate-windows.mjs"), output], {
    cwd: app,
    env: probeEnv,
    capture: true,
    phase: "validate-windows.mjs",
    timeoutMs: 300000,
  });
  const validation = JSON.parse(validationText.trim().split(/\r?\n/).at(-1));
  checkpoint("native-proxy-probe");
  const proxyValidationText = await run(
    node,
    [path.join(repo, "build/probe-native-proxy.mjs"), output],
    { cwd: app, env: probeEnv, capture: true, phase: "probe-native-proxy.mjs", timeoutMs: 180000 },
  );
  const proxyValidation = JSON.parse(proxyValidationText.trim().split(/\r?\n/).at(-1));
  checkpoint("git-probes");
  await run(path.join(gitRoot, "cmd/git.exe"), ["--version"], { env: probeEnv, capture: true });
  await run(
    path.join(gitRoot, "bin/bash.exe"),
    ["--noprofile", "--norc", "-c", "printf KIRO_BASH_READY"],
    { env: probeEnv, capture: true },
  );
  checkpoint("licenses");
  // Only safe structured validation evidence is shipped; temporary compiler results stay in work.
  const licenses = path.join(output, "LICENSES");
  await mkdir(path.join(licenses, "sources"), { recursive: true });
  const gitSourceName = path.posix.basename(new URL(inputs.assets.gitSource.url).pathname);
  await copyFile(acquired.gitSource, path.join(licenses, "sources", gitSourceName));
  await copyFile(acquired.ompLicense, path.join(licenses, "OMP-LICENSE.txt"));
  await copyFile(path.join(passessionRoot, "LICENSE"), path.join(licenses, "PASSESSION-LICENSE.txt"));
  await copyFile(
    path.join(output, "runtime/node/LICENSE"),
    path.join(licenses, "NODE-LICENSE.txt"),
  );
  await copyFile(path.join(plugin, "LICENSE"), path.join(licenses, "KIRO-HTTP-PLUGIN-LICENSE.txt"));
  const daemonPin = inputs.assets.passessionDaemon;
  await writeFile(
    path.join(licenses, "SOURCE-AVAILABILITY.txt"),
    `Git for Windows is redistributed as its complete, unmodified PortableGit distribution; licenses and third-party notices remain under runtime/git. The upstream Git source package is included in LICENSES/sources/${gitSourceName}. Additional bundled MSYS2 component sources/build recipes are available from https://gitforwindows.org/third-party.html and https://github.com/git-for-windows/MSYS2-packages and https://github.com/git-for-windows/MINGW-packages . Preserve these notices when redistributing.\nPassession ${daemonPin.version} (Apache-2.0) native daemon and desktop client are the unmodified official release binaries of ${daemonPin.repository} at ${daemonPin.commit}; source is available at ${daemonPin.repository}/tree/${daemonPin.commit}. runtime/passession is the complete daemon release ZIP. runtime/passession-app is the complete payload of the official NSIS installer as listed by its own owned-file inventory, unpacked with 7-Zip without running the installer; the installer-generated Uninstall.exe and the inventory file are omitted. Their LICENSE, THIRD-PARTY-NOTICES, Rust third-party notices and font licenses remain in place.\nOMP ${inputs.assets.omp.version} is the unmodified official standalone executable from ${inputs.assets.omp.repository} (MIT, LICENSES/OMP-LICENSE.txt); it embeds its own JavaScript runtime.\nNode.js LICENSE contains its third-party notices. npm package licenses remain with every installed package; NPM-PACKAGES.json records exact public registry integrity pins. The native WinHTTP/SSPI helper source and build/import provenance are included. The Kiro HTTP plugin retains its upstream Apache-2.0 license; app/plugin/omp-kiro/BUNDLE-PROJECTION.json records the shipped module closure and manifest changes.\n`,
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
    windowsApiTarget:
      "Windows 10 API level (_WIN32_WINNT 0x0A00); actual Server 2019 execution unverified",
  });
  await json(path.join(licenses, "NATIVE-PROXY-IMPORTS.json"), nativeImports);
  await json(path.join(licenses, "NATIVE-RUNTIME-IMPORTS.json"), {
    scope:
      "Direct DLL imports of unmodified upstream executables, read with dumpbin /dependents. Delay-loaded/dynamic resolution and minimum OS are not established here.",
    files: nativeRuntimeImports,
  });
  await json(path.join(output, "native-proxy-validation.json"), proxyValidation);
  checkpoint("npm-inventory");
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
      license: installed.license ?? item.license ?? "See package notices",
    });
  }
  if (packages.some((item) => item.name?.startsWith("@getpaseo/")))
    throw new Error("Obsolete Paseo JavaScript packages must not be shipped");
  await json(path.join(licenses, "NPM-PACKAGES.json"), packages);
  await json(path.join(licenses, "DOWNLOAD-INPUTS.json"), inputs);
  checkpoint("payload-hashes");
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
  const pluginPin = inputs.assets.plugin;
  const manifest = {
    schemaVersion: 1,
    packageVersion: JSON.parse(await readFile(path.join(app, "package.json"), "utf8")).version,
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
    native: {
      passessionDaemon,
      passessionApp: {
        version: inputs.assets.passessionApp.version,
        commit: inputs.assets.passessionApp.commit,
        root: "runtime/passession-app",
        executable: "runtime/passession-app/paseo_sessions.exe",
        sha256: await digest(path.join(passessionAppRoot, "paseo_sessions.exe")),
        bundledDaemon: passessionAppDaemon.executable,
        bundledDaemonSha256: passessionAppDaemon.sha256,
        descriptor: "runtime/passession-app/runtime/desktop-runtime.json",
        installerSha256: inputs.assets.passessionApp.sha256,
        unpackedBy: `7-Zip ${inputs.assets.sevenZip.version} (build host only; installer not executed)`,
        excludedInstallerMembers: [...installerOnly, "$PLUGINSDIR/*"],
      },
      omp: {
        version: inputs.assets.omp.version,
        executable: "runtime/omp/omp.exe",
        sha256: inputs.assets.omp.sha256,
        networkPolicy: "app/omp-network-policy.json",
        disabledBuiltInProviders: disabledProviders.length,
        policySources: ["ompCatalog", "ompProviderRules"],
      },
      plugin: {
        version: pluginPin.version,
        commit: pluginPin.commit,
        root: "app/plugin/omp-kiro",
        extension: "app/plugin/omp-kiro/index.js",
        projection: "app/plugin/omp-kiro/BUNDLE-PROJECTION.json",
      },
      node: { version: inputs.assets.node.version, executable: "runtime/node/node.exe" },
      imports: "LICENSES/NATIVE-RUNTIME-IMPORTS.json",
    },
    nativeValidation: {
      ...validation,
      windowsRelease: os.release(),
      scope: `${validation.scope} Not Windows Server 2019/build 17763 execution evidence.`,
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
      intended:
        "Windows 10/11 x64 desktop sessions; only the build host is exercised by the producer",
      server2019Supported: false,
      server2019Verified: false,
      minimumOsFromRuntimeExecution: null,
      windowsServer:
        "Not claimed. Current Node.js, CPython, OMP and Passession releases are not qualified on Windows Server here.",
      desktopRequiresMediaFoundation,
      desktopImports,
      noFakeNativeDlls: true,
      browser: "Not required: native Passession desktop client; no browser or Electron bundled",
    },
    componentInventory: {
      pythonInterpreterFiles,
      retainedRuntime: [
        "Passession native daemon/CLI",
        "Passession native desktop client",
        "OMP standalone executable",
        "Kiro HTTP OMP extension",
        "Node.js (wrapper/auth)",
        "CPython standard library",
        "ripgrep",
        "jq",
        "Complete PortableGit",
        "WinHTTP/SSPI helper",
      ],
      scope:
        "Conventional Python/PyPy EXE/DLL names across every staged file; not proof against an embedded or renamed interpreter. Complete paths and hashes remain in files. No package-wide Python-free claim is made.",
    },
    privacy: {
      userDataIncluded: false,
      sourcePayloadGuard: true,
      linksAllowed: false,
      sourceProjection:
        "Only pinned public release archives and registry packages plus repository payload; no host installations, installer side effects or user configuration copied",
    },
    files,
    manifestSelfHash:
      "Excluded to avoid recursion; the ZIP SHA-256 authenticates this manifest too.",
  };
  checkpoint("manifest");
  await json(path.join(output, "bundle-manifest.json"), manifest);
  const archiveFiles = await tree(output);
  checkpoint("zip");
  await writeZip(output, archiveFiles, zipPath, inputs.sourceDateEpoch);
  checkpoint("zip-checksum");
  const sha256 = await digest(zipPath);
  await writeFile(`${zipPath}.sha256`, `${sha256}  ${path.basename(zipPath)}\n`, { flag: "wx" });
  checkpoint("complete");
  console.log(
    JSON.stringify({
      root: output,
      zip: zipPath,
      checksum: `${zipPath}.sha256`,
      sha256,
      files: archiveFiles.length,
      target: inputs.target,
      server2019Verified: false,
      native: {
        passession: passessionDaemon.version,
        omp: inputs.assets.omp.version,
        plugin: pluginPin.version,
        node: inputs.assets.node.version,
      },
      pythonInterpreterFiles: pythonInterpreterFiles.map((file) => file.path),
    }),
  );
} catch (error) {
  process.stderr.write(`[build] ${producerStage} failed\n`);
  throw error;
} finally {
  try {
    await rm(work, { recursive: true, force: true });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
