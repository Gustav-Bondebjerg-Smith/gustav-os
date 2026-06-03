#!/usr/bin/env node

import { importWorkspace, isCliEntrypoint, PROJECT_ROOT, WORKSPACE_ROOT } from './memory-core.mjs'

function hasFlag(name) {
  return process.argv.includes(name)
}

function readOption(name, fallback = null) {
  const prefix = `${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const i = process.argv.indexOf(name)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

if (isCliEntrypoint(import.meta.url)) {
  const dry_run = hasFlag('--dry-run')
  const verbose = hasFlag('--verbose')
  const root = readOption('--root', null)
  const source_key_prefix = readOption('--source-key-prefix', '')
  const brain_id = readOption('--brain', 'personal')

  const targets = root
    ? [{ root, source_key_prefix }]
    : [
        { root: WORKSPACE_ROOT, source_key_prefix: '' },
        { root: PROJECT_ROOT, source_key_prefix: 'gustav-os' },
      ]

  const results = []
  for (const target of targets) {
    results.push(await importWorkspace({
      dry_run,
      root: target.root,
      source_key_prefix: target.source_key_prefix,
      brain_id,
      actor: 'cli',
      verbose,
    }))
  }

  const result = root ? results[0] : {
    roots: results.map((r) => ({
      root: r.root,
      source_key_prefix: r.source_key_prefix,
      discovered: r.discovered,
      imported: r.imported,
      unchanged: r.unchanged,
      failed_count: r.failed.length,
    })),
    dry_run,
    discovered: results.reduce((sum, r) => sum + r.discovered, 0),
    imported: results.reduce((sum, r) => sum + r.imported, 0),
    unchanged: results.reduce((sum, r) => sum + r.unchanged, 0),
    failed: results.flatMap((r) => r.failed),
    ...(dry_run ? { sources: results.flatMap((r) => r.sources || []) } : {}),
  }

  console.log(JSON.stringify(result, null, 2))
}
