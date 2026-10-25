import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SRC = resolve(ROOT, "src");
const DIST = resolve(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
mkdirSync(resolve(DIST, "icons"), { recursive: true });

// background 用 ESM（manifest 里 type: module）
await build({
  entryPoints: [resolve(SRC, "background-parts.js")],
  outfile: resolve(DIST, "background.js"),
  bundle: true,
  format: "esm",
  target: ["chrome102"],
  platform: "browser",
  logLevel: "info",
  sourcemap: false,
});

// content script 必须是非模块的 IIFE
await build({
  entryPoints: [resolve(SRC, "content.js")],
  outfile: resolve(DIST, "content.js"),
  bundle: true,
  format: "iife",
  target: ["chrome102"],
  logLevel: "info",
});

await build({
  entryPoints: [resolve(SRC, "popup.js")],
  outfile: resolve(DIST, "popup.js"),
  bundle: true,
  format: "esm",
  target: ["chrome102"],
  logLevel: "info",
});

// 静态资源
const manifest = JSON.parse(readFileSync(resolve(SRC, "manifest.json"), "utf8"));
writeFileSync(resolve(DIST, "manifest.json"), JSON.stringify(manifest, null, 2));
cpSync(resolve(SRC, "popup.html"), resolve(DIST, "popup.html"));

// 图标：用 Python/PIL 或 sips 生成；没有就跳过（manifest 引用了图标，必须存在）
const iconScript = resolve(ROOT, "scripts", "make_icons.py");
if (existsSync(iconScript)) {
  // 用系统 python3 并清掉 venv 环境变量：Hermes 的 venv 里 PIL 可能是无 C 扩展的半残安装
  const env = { ...process.env };
  delete env.PYTHONPATH;
  delete env.VIRTUAL_ENV;
  delete env.PYTHONHOME;
  execFileSync("/usr/bin/python3", [iconScript, resolve(DIST, "icons")], { stdio: "inherit", env });
}

console.log("✅ build done ->", DIST);