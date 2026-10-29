import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Record a module address, not a copied function. Qualification invokes the real
// export in the rendered Metro runtime, with its production dependencies loaded.
export async function findMetroExport({ sourceRoot, serverRoot, exportName }) {
  const ts = createRequire(path.join(sourceRoot, "package.json"))("typescript");
  const matches = [];
  async function visitDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Browser artifacts must not contain symbolic links");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const bytes = await readFile(file);
      const text = bytes.toString("utf8");
      if (!text.includes(exportName)) continue;
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.endsWith("__d")) {
          const [factory, moduleId] = node.arguments;
          if (factory && (ts.isFunctionExpression(factory) || ts.isArrowFunction(factory)) &&
              moduleId && ts.isNumericLiteral(moduleId)) {
            const exportsBinding = factory.parameters[5]?.name;
            if (exportsBinding && ts.isIdentifier(exportsBinding)) {
              let exportsTarget = false;
              function inspect(child) {
                if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(child.left) && ts.isIdentifier(child.left.expression) &&
                    child.left.expression.text === exportsBinding.text && child.left.name.text === exportName)
                  exportsTarget = true;
                ts.forEachChild(child, inspect);
              }
              inspect(factory.body);
              if (exportsTarget) matches.push({
                assetPath: path.relative(serverRoot, file).split(path.sep).join("/"),
                moduleId: Number(moduleId.text),
                exportName,
                assetSha256: createHash("sha256").update(bytes).digest("hex"),
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  await visitDirectory(path.join(serverRoot, "dist/server/web-ui"));
  if (matches.length !== 1) throw new Error(`Expected one real browser export for ${exportName}; found ${matches.length}`);
  return matches[0];
}
