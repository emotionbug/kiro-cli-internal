import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectionEditor, trustedForkSource } from "./paseo-projection-ast.mjs";

export const PASEO_RECONNECT_PERIOD_MS = 30000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const guards = {
  "packages/client/src/daemon-client.ts": "eb392e7eb517bad90250fa2d2e99b98ba143ae438a3d69c796d9dddd77525299",
  "packages/app/src/composer/actions.ts": "3f8628697bf24c9f77bcefde5e8359393a82a26af1276655a3a23e5030264491",
  "packages/app/src/runtime/host-runtime.ts": "8d017c6f5b6ea956c6116d307359df078650914f1addc3ecb38085c4dbb82eb5",
};

// Run only on the isolated, archive-authenticated source tree before compiling
// both the client workspace and the complete fork web UI. No public UI fallback.
export async function applyForkReconnect(sourceRoot) {
  const source = await trustedForkSource();
  const ts = createRequire(path.join(sourceRoot, "package.json"))("typescript");
  const originals = new Map();
  for (const [file, expected] of Object.entries(guards)) {
    const bytes = await readFile(path.join(sourceRoot, file));
    if (sha256(bytes) !== expected) throw new Error(`Fork reconnect projection refused changed source: ${file}`);
    originals.set(file, bytes.toString("utf8"));
  }
  const outputs = new Map();
  const clientFile = "packages/client/src/daemon-client.ts";
  const client = projectionEditor(ts, clientFile, originals.get(clientFile), ts.ScriptKind.TS);
  client.change("first retry default", (node) => ts.isVariableDeclaration(node) &&
    node.name.getText(client.ast) === "DEFAULT_RECONNECT_BASE_DELAY_MS" && node.initializer?.getText(client.ast) === "1500",
  (node) => `${node.name.getText(client.ast)} = ${PASEO_RECONNECT_PERIOD_MS}`);
  // Keep advertised retry deadlines and actual scheduling identical, including
  // the first attempt. Callers cannot reintroduce a shorter retry via options.
  for (const [property, constant] of [["baseDelayMs", "DEFAULT_RECONNECT_BASE_DELAY_MS"], ["maxDelayMs", "DEFAULT_RECONNECT_MAX_DELAY_MS"]]) {
    client.change(`fixed ${property} deadline and timer`, (node) => ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      node.left.getText(client.ast) === `this.config.reconnect?.${property}` &&
      node.right.getText(client.ast) === constant, constant, 2);
  }
  outputs.set(clientFile, client.finish());

  const actionsFile = "packages/app/src/composer/actions.ts";
  const actions = projectionEditor(ts, actionsFile, originals.get(actionsFile), ts.ScriptKind.TS);
  actions.change("queued delivery catch", (node) => ts.isCatchClause(node) &&
    ts.isBlock(node.parent.parent) && ts.isFunctionDeclaration(node.parent.parent.parent) &&
    node.parent.parent.parent.name?.text === "sendQueuedComposerMessageNow",
  (node) => {
    if (node.variableDeclaration?.name.getText(actions.ast) !== "error" ||
        !node.block.statements.length || !ts.isExpressionStatement(node.block.statements[0]) ||
        !ts.isCallExpression(node.block.statements[0].expression) ||
        node.block.statements[0].expression.expression.getText(actions.ast) !== "input.queue.write")
      throw new Error("Queued recovery must intercept before the original requeue");
    const original = node.getText(actions.ast);
    const opening = original.indexOf("{");
    return original.slice(0, opening + 1) + `
    if (typeof error === "object" && error !== null &&
        (("outcome" in error && error.outcome === "unknown") ||
         ("code" in error && error.code === "DAEMON_REQUEST_TIMEOUT"))) {
      return {
        status: "failed",
        errorMessage: "Delivery outcome unknown. Reconnect and inspect the conversation before sending again.",
      };
    }` + original.slice(opening + 1);
  });
  outputs.set(actionsFile, actions.finish());

  const hostFile = "packages/app/src/runtime/host-runtime.ts";
  const host = projectionEditor(ts, hostFile, originals.get(hostFile), ts.ScriptKind.TS);
  host.change("authoritative initial daemon hint", (node) => ts.isIfStatement(node) &&
    node.expression.getText(host.ast) === "initialHint" &&
    ts.isBlock(node.parent) && ts.isMethodDeclaration(node.parent.parent) &&
    node.parent.parent.name.getText(host.ast) === "runBoot",
  (node) => {
    if (!ts.isBlock(node.thenStatement) || node.elseStatement || node.thenStatement.statements.length !== 2 ||
        !ts.isVariableStatement(node.thenStatement.statements[0]) ||
        node.thenStatement.statements[0].declarationList.declarations[0].initializer?.getText(host.ast) !==
          "await this.bootstrapInitialConnectionHint(initialHint)")
      throw new Error("Initial daemon hint bootstrap boundary changed");
    return "if (initialHint) {\n      await this.bootstrapInitialConnectionHint(initialHint);\n      return;\n    }";
  });
  outputs.set(hostFile, host.finish());
  const files = [];
  for (const [file, text] of outputs) {
    const bytes = Buffer.from(text);
    await writeFile(path.join(sourceRoot, file), bytes);
    files.push({ path: file, originalSha256: guards[file], patchedSha256: sha256(bytes), bytes: bytes.length });
  }
  return {
    projection: "paseo-fork-source-fixed-30s-reconnect-unknown-delivery-no-replay-explicit-hint",
    source,
    reconnect: { baseDelayMs: PASEO_RECONNECT_PERIOD_MS, maxDelayMs: PASEO_RECONNECT_PERIOD_MS,
      attempts: "Unlimited until closed; authentication/security stops retained" },
    queuedDelivery: "Unknown acknowledgement or DAEMON_REQUEST_TIMEOUT never returns to the automatic queue",
    initialConnectionHint: "Supplied daemon is authoritative on failure/password; no unrelated localhost:6767 probe",
    files,
  };
}
