#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const wikiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.dirname(wikiRoot);
const failures = [];
const lineCountCache = new Map();

const manifest = await readJson("coverage/manifest.json");
const catalog = await readJson("knowledge/catalog.json");

const actualDomains = (
  await readdir(path.join(repoRoot, "src"), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => `src/${entry.name}`)
  .sort();
const declaredDomains = Object.keys(manifest.sourceDomains).sort();
compareSets("top-level src domain", actualDomains, declaredDomains);

const canonicalPages = new Set();
for (const [domain, coverage] of Object.entries(manifest.sourceDomains)) {
  await requireRepoPath(domain, `source domain ${domain}`);
  await validateCoverage(coverage, `source domain ${domain}`, canonicalPages);
}
for (const [modulePath, coverage] of Object.entries(manifest.rootModules)) {
  await requireRepoPath(modulePath, `root module ${modulePath}`);
  await validateCoverage(coverage, `root module ${modulePath}`, canonicalPages);
}
for (const [system, coverage] of Object.entries(manifest.repositorySystems)) {
  await requireRepoPath(system, `repository system ${system}`);
  await validateCoverage(
    coverage,
    `repository system ${system}`,
    canonicalPages,
  );
}
const workflowIds = new Set();
for (const workflow of manifest.crossCuttingWorkflows) {
  if (workflowIds.has(workflow.id))
    fail(`duplicate workflow id: ${workflow.id}`);
  workflowIds.add(workflow.id);
  if (!Array.isArray(workflow.pages) || workflow.pages.length < 2) {
    fail(`workflow ${workflow.id} must reference at least two pages`);
  }
  for (const page of workflow.pages ?? [])
    await requireWikiPath(page, `workflow ${workflow.id}`);
}

if (catalog.schemaVersion !== 1) fail("catalog schemaVersion must be 1");
const contractIds = new Set();
const catalogPages = new Set();
for (const contract of catalog.contracts ?? []) {
  if (!contract.id || contractIds.has(contract.id))
    fail(`invalid/duplicate contract id: ${contract.id}`);
  contractIds.add(contract.id);
  for (const field of [
    "keywords",
    "pages",
    "implementation",
    "tests",
    "invariants",
    "failureModes",
    "relationships",
    "changeSignals",
    "validation",
  ]) {
    if (!Array.isArray(contract[field]) || contract[field].length === 0) {
      fail(`contract ${contract.id} requires non-empty ${field}`);
    }
  }
  if (!contract.title || !contract.summary)
    fail(`contract ${contract.id} requires title and summary`);
  if (!new Set(["current", "proposed"]).has(contract.status))
    fail(`contract ${contract.id} requires status current or proposed`);
  for (const page of contract.pages ?? []) {
    catalogPages.add(page);
    await requireWikiPath(page, `contract ${contract.id} page`);
  }
  for (const evidence of contract.implementation ?? []) {
    const target = path.join(repoRoot, evidence);
    await requirePath(
      target,
      `contract ${contract.id} implementation ${evidence}`,
    );
  }
  for (const test of contract.tests ?? []) {
    await requireRepoPath(test, `contract ${contract.id} test`);
  }
}
for (const contract of catalog.contracts ?? []) {
  for (const related of contract.relationships ?? []) {
    if (!contractIds.has(related))
      fail(`contract ${contract.id} has unknown relationship ${related}`);
    if (related === contract.id)
      fail(`contract ${contract.id} relates to itself`);
  }
}
for (const page of canonicalPages) {
  if (!catalogPages.has(page))
    fail(`canonical page has no catalog contract: ${page}`);
}

const markdownFiles = await walkMarkdown(wikiRoot);
for (const file of markdownFiles) {
  await validateLinks(file);
  await validateRepoEvidence(file);
}

if (failures.length) {
  globalThis.console.error(
    `OpenWiki agent validation failed (${failures.length}):`,
  );
  for (const failure of failures) globalThis.console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  globalThis.console.log(
    `OpenWiki agent validation passed: ${actualDomains.length} source domains, ${canonicalPages.size} canonical pages, ${contractIds.size} contracts, ${markdownFiles.length} Markdown files.`,
  );
}

async function readJson(relative) {
  try {
    return JSON.parse(await readFile(path.join(wikiRoot, relative), "utf8"));
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`);
    return {};
  }
}

async function validateCoverage(coverage, label, pages) {
  if (!Array.isArray(coverage.pages) || coverage.pages.length === 0)
    fail(`${label} has no pages`);
  if (!Array.isArray(coverage.tests) || coverage.tests.length === 0)
    fail(`${label} has no tests`);
  for (const page of coverage.pages ?? []) {
    pages.add(page);
    await requireWikiPath(page, `${label} page`);
  }
  for (const test of coverage.tests ?? [])
    await requireRepoPath(test, `${label} test`);
}

async function requireWikiPath(relative, label) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
    fail(`${label} is not a contained wiki path: ${relative}`);
    return;
  }
  await requirePath(path.join(wikiRoot, relative), `${label} ${relative}`);
}

async function requireRepoPath(relative, label) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
    fail(`${label} is not a contained repository path: ${relative}`);
    return;
  }
  await requirePath(path.join(repoRoot, relative), label);
}

async function requirePath(target, label) {
  try {
    await stat(target);
  } catch {
    fail(`missing ${label}`);
  }
}

function compareSets(label, actual, declared) {
  for (const item of actual)
    if (!declared.includes(item)) fail(`undeclared ${label}: ${item}`);
  for (const item of declared)
    if (!actual.includes(item)) fail(`missing actual ${label}: ${item}`);
}

async function walkMarkdown(root) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(target);
    }
  }
  await visit(root);
  return found.sort();
}

async function validateLinks(file) {
  const text = await readFile(file, "utf8");
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of text.matchAll(linkPattern)) {
    let destination = match[1].trim();
    if (destination.startsWith("<") && destination.endsWith(">"))
      destination = destination.slice(1, -1);
    destination = destination.split("#", 1)[0];
    if (!destination || /^(?:https?:|mailto:)/u.test(destination)) continue;
    const resolved = path.resolve(
      path.dirname(file),
      decodeURIComponent(destination),
    );
    if (
      resolved !== wikiRoot &&
      !resolved.startsWith(`${wikiRoot}${path.sep}`)
    ) {
      fail(
        `link escapes wiki in ${path.relative(wikiRoot, file)}: ${destination}`,
      );
      continue;
    }
    await requirePath(
      resolved,
      `link target ${destination} from ${path.relative(wikiRoot, file)}`,
    );
  }
}

async function validateRepoEvidence(file) {
  const text = await readFile(file, "utf8");
  const evidencePattern = /repo:\/\/([A-Za-z0-9_./-]+)#L(\d+)(?:-L(\d+))?/gu;
  for (const match of text.matchAll(evidencePattern)) {
    const relative = match[1];
    const start = match[2] ? Number(match[2]) : undefined;
    const end = match[3] ? Number(match[3]) : start;
    const target = path.join(repoRoot, relative);
    if (path.isAbsolute(relative) || relative.split("/").includes("..")) {
      fail(
        `unsafe repository evidence in ${path.relative(wikiRoot, file)}: ${match[0]}`,
      );
      continue;
    }
    try {
      let lineCount = lineCountCache.get(target);
      if (lineCount === undefined) {
        lineCount = (await readFile(target, "utf8")).split(/\r?\n/u).length;
        lineCountCache.set(target, lineCount);
      }
      if (
        start !== undefined &&
        (start < 1 || end < start || end > lineCount)
      ) {
        fail(
          `invalid repository evidence range in ${path.relative(wikiRoot, file)}: ${match[0]} (file has ${lineCount} lines)`,
        );
      }
    } catch {
      fail(
        `missing repository evidence in ${path.relative(wikiRoot, file)}: ${match[0]}`,
      );
    }
  }
}

function fail(message) {
  failures.push(message);
}
