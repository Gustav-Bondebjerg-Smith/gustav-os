#!/usr/bin/env node

import { BACKUP_ROOT, exportBackup, isCliEntrypoint } from './memory-core.mjs'

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
  const backup_root = readOption('--backup-root', BACKUP_ROOT)
  const include_deleted = hasFlag('--include-deleted')
  const result = await exportBackup({ backup_root, include_deleted, actor: 'cli' })
  console.log(JSON.stringify(result, null, 2))
}
