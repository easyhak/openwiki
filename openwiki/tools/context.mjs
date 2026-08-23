#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const wikiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const catalog = JSON.parse(
  await readFile(path.join(wikiRoot, "knowledge/catalog.json"), "utf8"),
);

function normalize(value) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .trim();
}

const stopWords = new Set([
  "a",
  "add",
  "an",
  "and",
  "any",
  "be",
  "code",
  "change",
  "create",
  "do",
  "fix",
  "for",
  "from",
  "how",
  "i",
  "implement",
  "in",
  "is",
  "it",
  "make",
  "modify",
  "of",
  "on",
  "or",
  "remove",
  "the",
  "this",
  "to",
  "with",
]);

function terms(value) {
  return [...new Set(normalize(value).split(/\s+/u))].filter(
    (term) => term.length > 1 && !stopWords.has(term),
  );
}

function retrieve(taskValue, contracts, maxContracts) {
  const taskNormalized = normalize(taskValue);
  const taskTerms = terms(taskValue);
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const direct = new Map();

  for (const contract of contracts) {
    let score = 0;
    const reasons = [];
    const title = normalize(`${contract.id} ${contract.title}`);
    const keywords = contract.keywords.map(normalize);
    const summary = normalize(contract.summary);
    const signals = normalize(contract.changeSignals.join(" "));
    const paths = normalize(
      [...contract.pages, ...contract.implementation, ...contract.tests].join(
        " ",
      ),
    );

    for (const keyword of keywords) {
      if (keyword.length > 1 && taskNormalized.includes(keyword)) {
        score += keyword.includes(" ") ? 12 : 8;
        reasons.push(`keyword: ${keyword}`);
      }
    }
    for (const term of taskTerms) {
      if (title.split(/\s+/u).includes(term)) score += 6;
      if (keywords.some((keyword) => keyword.split(/\s+/u).includes(term)))
        score += 5;
      if (summary.includes(term)) score += 2;
      if (signals.includes(term)) score += 2;
      if (paths.includes(term)) score += 2;
    }
    if (taskNormalized.includes(normalize(contract.id))) {
      score += 16;
      reasons.push(`id: ${contract.id}`);
    }
    if (score >= 5) direct.set(contract.id, { contract, score, reasons });
  }

  const expanded = new Map(direct);
  for (const match of direct.values()) {
    if (match.score < 10) continue;
    for (const relatedId of match.contract.relationships ??
      match.contract.related ??
      []) {
      if (expanded.has(relatedId)) continue;
      const related = byId.get(relatedId);
      if (related) {
        expanded.set(relatedId, {
          contract: related,
          score: Math.max(4, Math.floor(match.score * 0.2)),
          reasons: [`related to ${match.contract.id}`],
        });
      }
    }
  }

  const matches = [...expanded.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.contract.id.localeCompare(right.contract.id),
    )
    .slice(0, maxContracts);
  const topScore = matches[0]?.score ?? 0;
  const confidence =
    topScore >= 24
      ? "high"
      : topScore >= 14
        ? "medium"
        : topScore >= 5
          ? "low"
          : "none";
  const accepted = confidence === "none" ? [] : matches;

  return {
    schemaVersion: 1,
    task: taskValue,
    confidence,
    authority: catalog.authority,
    contracts: accepted.map(({ contract, score, reasons }) => ({
      ...contract,
      score,
      reasons: [...new Set(reasons)].slice(0, 4),
    })),
    validation: [
      ...new Set(accepted.flatMap(({ contract }) => contract.validation)),
    ],
  };
}

function renderMarkdown(result) {
  const lines = [
    `# OpenWiki agent context`,
    "",
    `Task: ${result.task}`,
    `Confidence: ${result.confidence}`,
    `Authority: ${result.authority}`,
  ];

  if (result.contracts.length === 0) {
    lines.push(
      "",
      "No useful contract matched. Fall back to repository source/test discovery.",
    );
    return lines.join("\n");
  }

  for (const contract of result.contracts) {
    lines.push(
      "",
      `## ${contract.title} (${contract.id}, score ${contract.score})`,
      "",
      contract.summary,
      "",
      `Why: ${contract.reasons.join("; ") || "relationship expansion"}`,
      `Status: ${contract.status}`,
      `Pages: ${contract.pages.join(", ")}`,
      `Implementation: ${contract.implementation.join(", ")}`,
      `Tests: ${contract.tests.join(", ")}`,
      `Invariants: ${contract.invariants.join(" ")}`,
      `Failures: ${contract.failureModes.join(" ")}`,
      `Impact: ${contract.changeSignals.join(" ")}`,
    );
    if (contract.gaps?.length) lines.push(`Gaps: ${contract.gaps.join(" ")}`);
  }

  lines.push("", "## Narrow validation", "");
  for (const command of result.validation) lines.push(`- \`${command}\``);
  return lines.join("\n");
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const task = args
  .filter((arg) => !arg.startsWith("--"))
  .join(" ")
  .trim();

if (!task) {
  globalThis.console.error(
    'Usage: node openwiki/tools/context.mjs [--json] "exact coding task"',
  );
  process.exitCode = 2;
} else {
  const result = retrieve(task, catalog.contracts, 8);
  if (asJson) {
    globalThis.console.log(JSON.stringify(result, null, 2));
  } else {
    globalThis.console.log(renderMarkdown(result));
  }
}
