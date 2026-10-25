import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const patches = [
  {
    file: "dist/server/server/agent/providers/omp/cli-runtime.js",
    sha256: "4e66ac097cdeb3e27e4923d2dd2d6237a73d36ffa296aad89d5bafbd2463a971",
    replacements: [[
      "readyTimeoutMs: this.options.readyTimeoutMs,",
      'readyTimeoutMs: launch.env?.KIRO_INTERNAL_DATA_DIR && launch.env?.OMP_KIRO_TRANSPORT === "http" ? JSONL_RPC_NO_TIMEOUT : this.options.readyTimeoutMs,',
    ]],
  },
  {
    file: "dist/server/server/agent/providers/omp/protocol-session.js",
    sha256: "8aa8aa20b024dd886c77285d4408f08130e69e0ba8cd353f253cc9a0c1381b3b",
    replacements: [
      ["import { JSONL_RPC_DEFAULT_TIMEOUT_MS,", "import { JSONL_RPC_NO_TIMEOUT, JSONL_RPC_DEFAULT_TIMEOUT_MS,"],
      ["const readyTimeoutMs = timeouts.readyTimeoutMs ?? OMP_READY_TIMEOUT_MS;", "const readyTimeoutMs = timeouts.readyTimeoutMs === undefined ? OMP_READY_TIMEOUT_MS : timeouts.readyTimeoutMs;"],
      [
        'const timer = setTimeout(() => finish(new Error("Timed out waiting for OMP to become ready")), requestTimeoutMs);',
        'const timer = requestTimeoutMs === JSONL_RPC_NO_TIMEOUT ? undefined : setTimeout(() => finish(new Error("Timed out waiting for OMP to become ready")), requestTimeoutMs);',
      ],
    ],
  },
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Only the owned Kiro HTTP launch waits beyond the ordinary startup deadline.
// Exit and caller cancellation remain active; post-ready RPC deadlines stay intact.
export async function applyPaseoOmpStartupFix(serverRoot) {
  const outputs = [];
  for (const patch of patches) {
    const file = path.join(serverRoot, patch.file);
    const original = await readFile(file);
    if (digest(original) !== patch.sha256)
      throw new Error(`OMP startup projection refused changed public input: ${patch.file}`);
    let source = original.toString("utf8");
    for (const [before, after] of patch.replacements) {
      if (source.split(before).length !== 2)
        throw new Error(`OMP startup projection requires one exact boundary: ${patch.file}`);
      source = source.replace(before, after);
    }
    // Original generated maps no longer describe modified code.
    const mapDirective = `//# sourceMappingURL=${path.basename(file)}.map`;
    source = source.replace(mapDirective, "");
    outputs.push({ file, relative: patch.file, originalSha256: patch.sha256, bytes: Buffer.from(source) });
  }
  for (const { file, bytes } of outputs) {
    await writeFile(file, bytes);
    await rm(`${file}.map`, { force: true });
  }
  return {
    projection: "paseo-0.13.0-owned-kiro-http-cancellable-startup-wait",
    scope: "KIRO_INTERNAL_DATA_DIR and OMP_KIRO_TRANSPORT=http on the resolved OMP launch; unrelated providers retain their deadline",
    readiness: "Wait until ready, exit or user cancellation; no numeric timeout overflow; post-ready RPC deadlines unchanged",
    files: outputs.map(({ relative, originalSha256, bytes }) => ({
      path: relative, originalSha256, patchedSha256: digest(bytes), bytes: bytes.length,
    })),
    obsoleteSourceMapsRemoved: true,
    retained: "All unrelated code and license notices",
  };
}
