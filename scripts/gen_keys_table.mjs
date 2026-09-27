#!/usr/bin/env node
// Generates the "Keyboard shortcuts" markdown table in README.md from the
// single source of truth, everwatch/web/js/keymap.mjs's BINDINGS table
// (docs/DESIGN.md P-30, W-3). Run directly to print the table to stdout,
// or via `make docs-keys` to rewrite the block between the
// `<!-- keys:start -->` / `<!-- keys:end -->` markers in README.md.
//
// This intentionally mirrors the app's own in-app help sheet
// (`keymap.mjs`'s `helpSections()`), so the README can't drift from what
// pressing `?` actually shows.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const keymapPath = path.join(repoRoot, 'everwatch/web/js/keymap.mjs');
const { helpSections } = await import(keymapPath);

const START = '<!-- keys:start -->';
const END = '<!-- keys:end -->';

export function renderMarkdown() {
  const sections = helpSections();
  const lines = [];
  let rowCount = 0;
  for (const { group, items } of sections) {
    if (!items.length) continue;
    lines.push(`**${group}**`, '');
    lines.push('| Keys | Action |', '|---|---|');
    for (const item of items) {
      const keys = item.keys.map((k) => `\`${k}\``).join(' / ');
      lines.push(`| ${keys} | ${item.label} |`);
      rowCount += 1;
    }
    lines.push('');
  }
  return { markdown: lines.join('\n').trimEnd() + '\n', rowCount };
}

function main() {
  const { markdown, rowCount } = renderMarkdown();
  const rewrite = process.argv.includes('--write');
  if (!rewrite) {
    process.stdout.write(markdown);
    return;
  }
  const readmePath = path.join(repoRoot, 'README.md');
  const src = readFileSync(readmePath, 'utf8');
  const startIdx = src.indexOf(START);
  const endIdx = src.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`README.md is missing ${START} / ${END} markers`);
  }
  const before = src.slice(0, startIdx + START.length);
  const after = src.slice(endIdx);
  const next = `${before}\n${markdown}\n${after}`;
  writeFileSync(readmePath, next);
  process.stdout.write(`Wrote ${rowCount} rows into README.md between the keys markers.\n`);
}

main();
