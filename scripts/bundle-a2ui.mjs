import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p) {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const hasRenderer = await isDirectory(A2UI_RENDERER_DIR);
  const hasApp = await isDirectory(A2UI_APP_DIR);

  if (!hasRenderer || !hasApp) {
    if (await pathExists(OUTPUT_FILE)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      process.exit(0);
    }
    console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
    process.exit(1);
  }

  const inputPaths = [
    path.join(ROOT_DIR, "package.json"),
    path.join(ROOT_DIR, "pnpm-lock.yaml"),
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR
  ];

  const files = [];
  async function walk(entryPath) {
    const stat = await fs.stat(entryPath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(entryPath);
      for (const entry of entries) {
        await walk(path.join(entryPath, entry));
      }
    } else {
      files.push(entryPath);
    }
  }

  for (const inputPath of inputPaths) {
    if (await pathExists(inputPath)) {
      await walk(inputPath);
    }
  }

  function normalize(p) {
    return path.relative(ROOT_DIR, p).split(path.sep).join("/");
  }

  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(filePath);
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }

  const currentHash = hash.digest("hex");

  if (await pathExists(HASH_FILE) && await pathExists(OUTPUT_FILE)) {
    const previousHash = (await fs.readFile(HASH_FILE, "utf8")).trim();
    if (previousHash === currentHash) {
      console.log("A2UI bundle up to date; skipping.");
      process.exit(0);
    }
  }

  console.log("Bundling A2UI...");

  // Run tsc
  await runCommand("pnpm", ["exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")]);

  // Run rolldown
  await runCommand("pnpm", ["dlx", "rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);

  // Write hash
  await fs.mkdir(path.dirname(HASH_FILE), { recursive: true });
  await fs.writeFile(HASH_FILE, currentHash, "utf8");
  console.log("A2UI bundling completed successfully.");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const cmd = isWin && command === "pnpm" ? "pnpm.cmd" : command;
    const proc = spawn(cmd, args, { cwd: ROOT_DIR, stdio: "inherit", shell: isWin });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command ${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

main().catch((err) => {
  console.error("A2UI bundling failed:", err);
  process.exit(1);
});
