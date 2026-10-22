#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(repositoryRoot, "desktop/renderer/src/studio/generationProgressCore.ts");
const esbuild = join(repositoryRoot, "web/node_modules/.bin/esbuild");
const outputDirectory = resolve(process.env.OIP_PROGRESS_VERIFY_OUT || "/tmp/miaoimg-progress-dom");
const compileDirectory = mkdtempSync(join(tmpdir(), "miaoimg-progress-core-"));
const compiledCore = join(compileDirectory, "generationProgressCore.ts");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ringMarkup(framework, view, label) {
  const visibleText = view.showPercent ? `${view.estimated ? "≈" : ""}${view.percent}%` : "";
  const valueText = view.showPercent
    ? framework === "vue" ? `${label} · ${visibleText}` : visibleText
    : label;
  const numericAttributes = view.showPercent
    ? ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.percent}"`
    : "";
  return `<div data-framework="${framework}" role="progressbar"${numericAttributes} aria-valuetext="${valueText}" aria-label="${label}">
    <span data-visible-text>${visibleText}</span>
  </div>`;
}

try {
  execFileSync(esbuild, [source, "--format=esm", "--platform=browser", `--outfile=${compiledCore}`], { stdio: "ignore" });
  const { progressView } = await import(pathToFileURL(compiledCore).href);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  const states = [
    {
      name: "进行中",
      file: "running.png",
      label: "正在生成",
      input: { phase: "running", realPercent: null, elapsedSeconds: 9, modelId: "gpt-image-2", kind: "image" },
      expected: {
        vue: { valueNow: "36", valueText: "正在生成 · ≈36%", visibleText: "≈36%" },
        react: { valueNow: "36", valueText: "≈36%", visibleText: "≈36%" },
      },
    },
    {
      name: "成功",
      file: "succeeded.png",
      label: "完成",
      input: { phase: "succeeded", realPercent: null, elapsedSeconds: 0, modelId: "gpt-image-2", kind: "image" },
      expected: {
        vue: { valueNow: "100", valueText: "完成 · 100%", visibleText: "100%" },
        react: { valueNow: "100", valueText: "100%", visibleText: "100%" },
      },
    },
    {
      name: "失败",
      file: "failed.png",
      label: "图片生成失败",
      input: { phase: "failed", realPercent: null, elapsedSeconds: 0, modelId: "gpt-image-2", kind: "image" },
      expected: {
        vue: { valueNow: null, valueText: "图片生成失败", visibleText: "" },
        react: { valueNow: null, valueText: "图片生成失败", visibleText: "" },
      },
    },
  ];

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 220 }, deviceScaleFactor: 1 });
    for (const state of states) {
      const view = progressView(state.input);
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; padding: 32px; display: flex; gap: 24px; font: 16px system-ui; }
        [role=progressbar] { width: 260px; min-height: 90px; border: 3px solid #e2a75b; border-radius: 16px; padding: 16px; box-sizing: border-box; }
        [data-framework=vue] { border-color: #34d399; }
        [data-framework=react] { border-color: #60a5fa; }
        [data-visible-text] { display: block; margin-top: 28px; text-align: center; }
      </style>${ringMarkup("vue", view, state.label)}${ringMarkup("react", view, state.label)}`);

      const actual = await page.locator("[data-framework]").evaluateAll((rings) => Object.fromEntries(
        rings.map((ring) => [ring.dataset.framework, {
          valueNow: ring.getAttribute("aria-valuenow"),
          valueText: ring.getAttribute("aria-valuetext"),
          visibleText: ring.querySelector("[data-visible-text]")?.textContent || "",
        }]),
      ));
      for (const framework of ["vue", "react"]) {
        assert(JSON.stringify(actual[framework]) === JSON.stringify(state.expected[framework]),
          `${state.name}/${framework} DOM mismatch: ${JSON.stringify(actual[framework])}`);
      }
      const screenshot = join(outputDirectory, state.file);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(`${state.name}: ${JSON.stringify(actual)} screenshot=${screenshot}`);
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(compileDirectory, { recursive: true, force: true });
}
