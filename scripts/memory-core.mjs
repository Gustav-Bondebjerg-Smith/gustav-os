import './load-env.mjs'

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { embedText } from './embed.mjs'

export const WORKSPACE_ROOT = '/Users/gustavbondebjergsmith/Documents/AI assistent'
export const PROJECT_ROOT = '/Users/gustavbondebjergsmith/Developer/gustav-os'
export const BACKUP_ROOT = '/Users/gustavbondebjergsmith/Documents/AI assistent/supabase-memory-backup'

const CHUNK_SIZE = 3600
const CHUNK_OVERLAP = 450
const DEFAULT_BRAIN_ID = 'personal'
const execFileAsync = promisify(execFile)

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.text', '.json', '.jsonl', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.css', '.scss', '.html', '.xml', '.sql', '.toml', '.yaml',
  '.yml', '.csv', '.tsv', '.sh', '.zsh', '.bash', '.gitignore', '.example',
])

const DOCX_EXTENSIONS = new Set(['.docx'])
const PDF_EXTENSIONS = new Set(['.pdf'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico'])

const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.next', '.vercel', '.turbo', '.cache', 'dist',
  'build', 'coverage', 'supabase-memory-backup', '.codex-log',
])

const EXCLUDED_FILES = new Set([
  '.env', '.env.local', '.env.development', '.env.production',
  'package-lock.json', 'tsconfig.tsbuildinfo', '.DS_Store',
])

let _supabase = null

export function getSupabase() {
  if (_supabase) return _supabase
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Mangler NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i .env.local')
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } })
  return _supabase
}

export function hashText(value) {
  return createHash('sha256').update(value || '').digest('hex')
}

export function normalizeBrainId(value) {
  return (value || DEFAULT_BRAIN_ID).trim().toLowerCase()
}

export function makeSourceKey({ uri, source_key }) {
  return (source_key || uri || '').trim()
}

export function slugify(value) {
  return String(value || 'source')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'source'
}

export function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  if (clean.length <= chunkSize) return [clean]

  const chunks = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(clean.length, start + chunkSize)
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('\n\n', end)
      if (boundary > start + chunkSize * 0.55) end = boundary
    }
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(0, end - overlap)
  }
  return chunks.filter(Boolean)
}

function sourceTitleFromKey(sourceKey) {
  const base = path.basename(sourceKey)
  return base || sourceKey || 'memory source'
}

function inferArea(metadata = {}) {
  const area = metadata.area
  return typeof area === 'string' && area.trim() ? area.trim() : null
}

export async function auditMemory({ action, tool_name = null, memory_source_id = null, payload = {}, status = 'ok', actor = 'agent' }) {
  const sb = getSupabase()
  await sb.from('memory_audit_log').insert({
    actor,
    tool_name,
    action,
    memory_source_id,
    payload,
    status,
  })
}

export async function upsertSource({
  brain_id = DEFAULT_BRAIN_ID,
  source_type = 'manual',
  source_key,
  title,
  uri = null,
  content = '',
  metadata = {},
  actor = 'agent',
  tool_name = 'memory_upsert_source',
  reindex = true,
}) {
  const sb = getSupabase()
  const brainId = normalizeBrainId(brain_id)
  const key = makeSourceKey({ uri, source_key })
  if (!key) throw new Error('source_key eller uri er påkrævet')
  const finalTitle = title || sourceTitleFromKey(key)
  const finalContent = String(content || '')
  const contentHash = hashText(finalContent)

  const { data, error } = await sb
    .from('memory_sources')
    .upsert({
      brain_id: brainId,
      source_type,
      source_key: key,
      title: finalTitle,
      uri,
      content: finalContent || null,
      content_hash: contentHash,
      metadata,
      deleted_at: null,
    }, { onConflict: 'brain_id,source_type,source_key' })
    .select('*')
    .single()

  if (error) throw new Error(`memory_sources upsert-fejl: ${error.message}`)

  let chunkCount = null
  if (reindex) {
    const indexed = await reindexSource({
      memory_source_id: data.id,
      actor,
      tool_name: `${tool_name}:reindex`,
      audit: false,
    })
    chunkCount = indexed.chunk_count
  }

  await auditMemory({
    action: 'upsert_source',
    tool_name,
    memory_source_id: data.id,
    payload: { brain_id: brainId, source_type, source_key: key, chunk_count: chunkCount },
    actor,
  })

  return { source: data, chunk_count: chunkCount }
}

export async function updateSource({
  memory_source_id,
  patch = {},
  actor = 'agent',
  tool_name = 'memory_update_source',
  reindex = true,
}) {
  if (!memory_source_id) throw new Error('memory_source_id er påkrævet')
  const allowed = ['brain_id', 'source_type', 'source_key', 'title', 'uri', 'content', 'metadata']
  const update = {}
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) update[key] = patch[key]
  }
  if (Object.prototype.hasOwnProperty.call(update, 'brain_id')) {
    update.brain_id = normalizeBrainId(update.brain_id)
  }
  if (Object.prototype.hasOwnProperty.call(update, 'content')) {
    update.content = String(update.content || '')
    update.content_hash = hashText(update.content)
  }
  if (!Object.keys(update).length) throw new Error('Ingen tilladte felter i patch')

  const sb = getSupabase()
  const { data, error } = await sb
    .from('memory_sources')
    .update(update)
    .eq('id', memory_source_id)
    .select('*')
    .single()

  if (error) throw new Error(`memory_sources update-fejl: ${error.message}`)

  let chunkCount = null
  if (reindex && Object.prototype.hasOwnProperty.call(update, 'content')) {
    const indexed = await reindexSource({
      memory_source_id,
      actor,
      tool_name: `${tool_name}:reindex`,
      audit: false,
    })
    chunkCount = indexed.chunk_count
  }

  await auditMemory({
    action: 'update_source',
    tool_name,
    memory_source_id,
    payload: { fields: Object.keys(update), chunk_count: chunkCount },
    actor,
  })

  return { source: data, chunk_count: chunkCount }
}

export async function reindexSource({
  memory_source_id,
  actor = 'agent',
  tool_name = 'memory_reindex_source',
  audit = true,
}) {
  if (!memory_source_id) throw new Error('memory_source_id er påkrævet')
  const sb = getSupabase()
  const { data: source, error: sourceErr } = await sb
    .from('memory_sources')
    .select('*')
    .eq('id', memory_source_id)
    .single()

  if (sourceErr) throw new Error(`memory_sources select-fejl: ${sourceErr.message}`)
  if (source.deleted_at) throw new Error('Kan ikke reindexe en slettet source')

  const content = String(source.content || '')
  const chunks = chunkText(content)

  await sb
    .from('memory_chunks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('memory_source_id', memory_source_id)
    .is('deleted_at', null)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const embedding = await embedText(chunk)
    const { error } = await sb.from('memory_chunks').insert({
      content: chunk,
      embedding,
      source_type: source.source_type,
      source_id: source.id,
      memory_source_id: source.id,
      brain_id: source.brain_id,
      chunk_index: i,
      content_hash: hashText(chunk),
      area: inferArea(source.metadata),
      metadata: {
        source_key: source.source_key,
        source_title: source.title,
        source_uri: source.uri,
        original_source_type: source.source_type,
      },
    })
    if (error) throw new Error(`memory_chunks insert-fejl: ${error.message}`)
  }

  if (audit) {
    await auditMemory({
      action: 'reindex_source',
      tool_name,
      memory_source_id,
      payload: { chunk_count: chunks.length },
      actor,
    })
  }

  return { source_id: memory_source_id, chunk_count: chunks.length }
}

export async function deleteSource({
  memory_source_id,
  hard_delete = false,
  confirm_hard_delete = false,
  actor = 'agent',
  tool_name = 'memory_delete_source',
}) {
  if (!memory_source_id) throw new Error('memory_source_id er påkrævet')
  const sb = getSupabase()

  if (hard_delete) {
    if (!confirm_hard_delete) {
      throw new Error('Hard delete kræver confirm_hard_delete=true')
    }
    await sb.from('memory_chunks').delete().eq('memory_source_id', memory_source_id)
    const { error } = await sb.from('memory_sources').delete().eq('id', memory_source_id)
    if (error) throw new Error(`memory_sources hard delete-fejl: ${error.message}`)
  } else {
    const deletedAt = new Date().toISOString()
    await sb.from('memory_chunks').update({ deleted_at: deletedAt }).eq('memory_source_id', memory_source_id)
    const { error } = await sb.from('memory_sources').update({ deleted_at: deletedAt }).eq('id', memory_source_id)
    if (error) throw new Error(`memory_sources soft delete-fejl: ${error.message}`)
  }

  await auditMemory({
    action: hard_delete ? 'hard_delete_source' : 'soft_delete_source',
    tool_name,
    memory_source_id,
    payload: { hard_delete },
    actor,
  })

  return { memory_source_id, hard_delete, deleted: true }
}

export async function listSources({
  brain_id = null,
  source_type = null,
  include_deleted = false,
  limit = 50,
  offset = 0,
} = {}) {
  const sb = getSupabase()
  let q = sb
    .from('memory_sources')
    .select('id, brain_id, source_type, source_key, title, uri, content_hash, metadata, created_at, updated_at, deleted_at')
    .order('updated_at', { ascending: false })
    .range(offset, offset + Math.max(1, Math.min(limit, 1000)) - 1)

  if (brain_id) q = q.eq('brain_id', normalizeBrainId(brain_id))
  if (source_type) q = q.eq('source_type', source_type)
  if (!include_deleted) q = q.is('deleted_at', null)

  const { data, error } = await q
  if (error) throw new Error(`memory_sources list-fejl: ${error.message}`)
  return data || []
}

export async function getSource({ memory_source_id, include_chunks = true }) {
  if (!memory_source_id) throw new Error('memory_source_id er påkrævet')
  const sb = getSupabase()
  const { data: source, error } = await sb
    .from('memory_sources')
    .select('*')
    .eq('id', memory_source_id)
    .single()
  if (error) throw new Error(`memory_sources get-fejl: ${error.message}`)

  if (!include_chunks) return { source, chunks: [] }

  const { data: chunks, error: chunkErr } = await sb
    .from('memory_chunks')
    .select('id, chunk_index, content, content_hash, metadata, created_at, updated_at, deleted_at')
    .eq('memory_source_id', memory_source_id)
    .is('deleted_at', null)
    .order('chunk_index', { ascending: true })

  if (chunkErr) throw new Error(`memory_chunks get-fejl: ${chunkErr.message}`)
  return { source, chunks: chunks || [] }
}

export async function searchMemory({
  query,
  match_count = 8,
  brain_id = null,
  source_type = null,
}) {
  if (!query?.trim()) throw new Error('query er påkrævet')
  const embedding = await embedText(query.trim())
  const sb = getSupabase()
  const { data, error } = await sb.rpc('search_memory_v2', {
    query_embedding: embedding,
    match_count,
    filter_brain_id: brain_id ? normalizeBrainId(brain_id) : null,
    filter_source_type: source_type || null,
  })
  if (error) throw new Error(`search_memory_v2 RPC-fejl: ${error.message}`)
  return data || []
}

function shouldSkipPath(absPath, entryName) {
  if (EXCLUDED_DIRS.has(entryName) || EXCLUDED_FILES.has(entryName)) return true
  if (entryName.startsWith('.env') && entryName !== '.env.local.example') return true
  if (entryName.endsWith('.sqlite') || entryName.endsWith('.sqlite-shm') || entryName.endsWith('.sqlite-wal')) return true
  if (entryName.endsWith('.log') || entryName.endsWith('.lock')) return true
  if (absPath.includes(`${path.sep}.git${path.sep}`)) return true
  if (absPath.includes(`${path.sep}node_modules${path.sep}`)) return true
  if (absPath.includes(`${path.sep}.next${path.sep}`)) return true
  return false
}

async function runTextExtractor(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 15000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return String(stdout || '').trim()
}

async function readDocx(absPath) {
  try {
    const text = await runTextExtractor('textutil', ['-convert', 'txt', '-stdout', absPath])
    if (text) return text
  } catch {
    // Fallback nedenfor.
  }
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: absPath })
  return result.value || ''
}

async function fileToSource(absPath, { root = WORKSPACE_ROOT, source_key_prefix = '' } = {}) {
  const localRel = path.relative(root, absPath)
  const rel = source_key_prefix
    ? path.join(source_key_prefix, localRel)
    : path.relative(WORKSPACE_ROOT, absPath)
  const ext = path.extname(absPath).toLowerCase()
  const name = path.basename(absPath)
  const st = await stat(absPath)
  const uri = pathToFileURL(absPath).href
  const baseMetadata = {
    path: absPath,
    relative_path: rel,
    import_root: root,
    size_bytes: st.size,
    mtime: st.mtime.toISOString(),
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      source_type: 'local_image',
      source_key: rel,
      title: name,
      uri,
      content: '',
      metadata: { ...baseMetadata, import_note: 'Image registered without OCR in v1' },
      skipped_content: false,
    }
  }

  let content = ''
  let sourceType = 'local_file'
  let parseError = null
  try {
    if (DOCX_EXTENSIONS.has(ext)) {
      sourceType = 'local_docx'
      content = await readDocx(absPath)
    } else if (PDF_EXTENSIONS.has(ext)) {
      sourceType = 'local_pdf'
      content = ''
      baseMetadata.import_note = 'PDF registered without text extraction in v1'
    } else if (TEXT_EXTENSIONS.has(ext) || !ext) {
      content = await readFile(absPath, 'utf8')
    } else {
      return null
    }
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e)
  }

  return {
    source_type: sourceType,
    source_key: rel,
    title: name,
    uri,
    content,
    metadata: parseError ? { ...baseMetadata, parse_error: parseError } : baseMetadata,
    skipped_content: false,
  }
}

export async function collectWorkspaceSources(root = WORKSPACE_ROOT, {
  verbose = false,
  source_key_prefix = '',
} = {}) {
  const out = []
  const seenDirs = new Set()
  async function walk(dir) {
    const realDir = await realpath(dir).catch(() => dir)
    if (seenDirs.has(realDir)) return
    seenDirs.add(realDir)

    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (shouldSkipPath(abs, entry.name)) continue
      let isRegularFile = entry.isFile()
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (entry.isSymbolicLink()) {
        const targetStat = await stat(abs).catch(() => null)
        if (targetStat?.isDirectory()) {
          await walk(abs)
          continue
        }
        isRegularFile = Boolean(targetStat?.isFile())
        if (!targetStat?.isFile()) continue
      }
      if (!isRegularFile) continue
      if (verbose) console.error(`memory-import: ${path.relative(root, abs)}`)
      const source = await fileToSource(abs, { root, source_key_prefix })
      if (source) out.push(source)
    }
  }
  await walk(root)
  return out
}

export async function importWorkspace({
  dry_run = false,
  root = WORKSPACE_ROOT,
  source_key_prefix = '',
  brain_id = DEFAULT_BRAIN_ID,
  actor = 'agent',
  verbose = false,
} = {}) {
  const sources = await collectWorkspaceSources(root, { verbose, source_key_prefix })
  const summary = {
    root,
    source_key_prefix,
    dry_run,
    discovered: sources.length,
    imported: 0,
    unchanged: 0,
    failed: [],
  }

  if (dry_run) {
    summary.sources = sources.map((s) => ({
      source_type: s.source_type,
      source_key: s.source_key,
      title: s.title,
      content_chars: s.content.length,
      hash: hashText(s.content),
    }))
    return summary
  }

  const existing = await listSources({ brain_id, include_deleted: true, limit: 200 })
  const existingByKey = new Map(existing.map((s) => [`${s.source_type}:${s.source_key}`, s]))

  for (const source of sources) {
    try {
      const key = `${source.source_type}:${source.source_key}`
      const current = existingByKey.get(key)
      const contentHash = hashText(source.content)
      if (current?.content_hash === contentHash && !current.deleted_at) {
        summary.unchanged += 1
        continue
      }
      await upsertSource({ ...source, brain_id, actor, tool_name: 'memory_import_workspace' })
      summary.imported += 1
    } catch (e) {
      summary.failed.push({
        source_key: source.source_key,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await auditMemory({
    action: 'import_workspace',
    tool_name: 'memory_import_workspace',
    payload: { root, imported: summary.imported, unchanged: summary.unchanged, failed: summary.failed.length },
    actor,
  })

  return summary
}

function frontmatterEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"')
}

export async function exportBackup({
  backup_root = BACKUP_ROOT,
  include_deleted = false,
  actor = 'agent',
} = {}) {
  const sources = []
  let offset = 0
  while (true) {
    const batch = await listSources({ include_deleted, limit: 1000, offset })
    sources.push(...batch)
    if (batch.length < 1000) break
    offset += 1000
  }
  let written = 0

  for (const source of sources) {
    const dir = path.join(backup_root, slugify(source.brain_id), slugify(source.source_type))
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${slugify(source.source_key || source.title)}.md`)
    const { source: fullSource, chunks } = await getSource({ memory_source_id: source.id, include_chunks: true })
    const body = [
      '---',
      `id: "${frontmatterEscape(fullSource.id)}"`,
      `brain_id: "${frontmatterEscape(fullSource.brain_id)}"`,
      `source_type: "${frontmatterEscape(fullSource.source_type)}"`,
      `source_key: "${frontmatterEscape(fullSource.source_key)}"`,
      `title: "${frontmatterEscape(fullSource.title)}"`,
      `uri: "${frontmatterEscape(fullSource.uri || '')}"`,
      `content_hash: "${frontmatterEscape(fullSource.content_hash || '')}"`,
      `created_at: "${frontmatterEscape(fullSource.created_at)}"`,
      `updated_at: "${frontmatterEscape(fullSource.updated_at)}"`,
      `deleted_at: "${frontmatterEscape(fullSource.deleted_at || '')}"`,
      '---',
      '',
      fullSource.content || '',
      '',
      '## Chunks',
      '',
      ...chunks.map((chunk) => `### Chunk ${chunk.chunk_index}\n\n${chunk.content}`),
      '',
    ].join('\n')
    await writeFile(file, body, 'utf8')
    written += 1
  }

  await auditMemory({
    action: 'export_backup',
    tool_name: 'memory_export_backup',
    payload: { backup_root, written },
    actor,
  })

  return { backup_root, written }
}

export function isCliEntrypoint(importMetaUrl) {
  return process.argv[1] && fileURLToPath(importMetaUrl) === path.resolve(process.argv[1])
}
