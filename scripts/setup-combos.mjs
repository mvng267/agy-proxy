#!/usr/bin/env node
// Tạo sẵn các combos theo task type cho agy-proxy
// Chạy: node scripts/setup-combos.mjs
import { upsertComboRow } from '../src/store/db.ts';

const combos = [
  {
    id: 'code',
    name: 'Code & Refactor',
    strategy: 'priority',
    targets: [
      { model: 'agy/claude-opus-4-6-thinking', weight: 2 },
      { model: 'kr/claude-sonnet-4.5', weight: 1 },
    ],
  },
  {
    id: 'fast',
    name: 'Fast & Cheap',
    strategy: 'priority',
    targets: [
      { model: 'kr/claude-haiku-4.5', weight: 1 },
      { model: 'agy/gemini-3.1-flash-lite', weight: 1 },
    ],
  },
  {
    id: 'research',
    name: 'Research & Analysis',
    strategy: 'priority',
    targets: [
      { model: 'agy/claude-opus-4-6-thinking', weight: 2 },
      { model: 'agy/gemini-3-pro-high', weight: 1 },
    ],
  },
  {
    id: 'agent',
    name: 'Agent Tasks',
    strategy: 'priority',
    targets: [
      { model: 'kr/claude-sonnet-4.5', weight: 2 },
      { model: 'agy/claude-opus-4-6-thinking', weight: 1 },
    ],
  },
  {
    id: 'vision',
    name: 'Vision & Image',
    strategy: 'priority',
    targets: [
      { model: 'agy/gemini-3-pro-high', weight: 1 },
      { model: 'kr/claude-sonnet-4.5', weight: 1 },
    ],
  },
];

for (const c of combos) {
  upsertComboRow({ ...c, enabled: true });
  console.log(`✓ combo/${c.id} → ${c.targets.map((t) => t.model).join(' → ')}`);
}
console.log(`\nDone. ${combos.length} combos created.`);
