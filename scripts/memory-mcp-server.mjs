#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  BACKUP_ROOT,
  deleteSource,
  exportBackup,
  getSource,
  listSources,
  reindexSource,
  searchMemory,
  updateSource,
  upsertSource,
} from './memory-core.mjs'
import {
  listFacts,
  recallGlobal,
  recallProject,
  saveMemory,
} from './memory-facts-core.mjs'

const ACCESS = (process.env.MEMORY_MCP_ACCESS || 'read_only').trim().toLowerCase()
const IS_FULL = ACCESS === 'full'
const ACTOR = process.env.MEMORY_MCP_ACTOR || 'mcp'

function jsonResult(data) {
  const structuredContent =
    data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent,
  }
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return jsonResult(await handler(args))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      }
    }
  })
}

const server = new McpServer({
  name: 'gustav-supabase-memory',
  version: '1.0.0',
})

registerTool(
  server,
  'memory_search',
  {
    title: 'Search Gustav memory',
    description: 'Semantic search in Gustav OS Supabase memory. Use this before relying on local AGENTS/STATUS files when personal/project context may matter.',
    inputSchema: {
      query: z.string().min(1),
      match_count: z.number().int().min(1).max(20).optional(),
      brain_id: z.string().optional(),
      source_type: z.string().optional(),
    },
  },
  ({ query, match_count = 8, brain_id = null, source_type = null }) =>
    searchMemory({ query, match_count, brain_id, source_type })
)

registerTool(
  server,
  'memory_list_sources',
  {
    title: 'List memory sources',
    description: 'List canonical memory sources in Supabase, optionally filtered by brain/source type.',
    inputSchema: {
      brain_id: z.string().optional(),
      source_type: z.string().optional(),
      include_deleted: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  },
  (args) => listSources(args)
)

registerTool(
  server,
  'memory_get_source',
  {
    title: 'Get memory source',
    description: 'Fetch one canonical source and its active chunks.',
    inputSchema: {
      memory_source_id: z.string().uuid(),
      include_chunks: z.boolean().optional(),
    },
  },
  (args) => getSource(args)
)

registerTool(
  server,
  'memory_export_backup',
  {
    title: 'Export memory backup',
    description: 'Export Supabase memory to local markdown backup. This does not make local files canonical.',
    inputSchema: {
      backup_root: z.string().optional(),
      include_deleted: z.boolean().optional(),
    },
  },
  ({ backup_root = BACKUP_ROOT, include_deleted = false }) =>
    exportBackup({ backup_root, include_deleted, actor: ACTOR })
)

// ---- Lærende fakta-lag (memory_facts) ----
// Lille, kurateret lag adskilt fra dokument-RAG'en ovenfor. Telegram-routeren
// skriver scope 'global'; her kan Claude Code/Codex læse de samme fakta og skrive
// projekt-scopede fakta (scope = projekt-slug).

registerTool(
  server,
  'memory_fact_recall_global',
  {
    title: 'Recall global facts',
    description: 'Load the full set of global learned facts/preferences about Gustav (no vector search). Small, stable identity layer - prefer this for who-Gustav-is context before relying on AGENTS/STATUS.',
    inputSchema: {},
  },
  () => recallGlobal()
)

registerTool(
  server,
  'memory_fact_recall_project',
  {
    title: 'Recall project facts',
    description: 'Semantic search of learned facts within ONE project scope (slug). Use for project-specific conventions/decisions the assistant has saved.',
    inputSchema: {
      query: z.string().min(1),
      scope: z.string().min(1),
      match_count: z.number().int().min(1).max(20).optional(),
    },
  },
  ({ query, scope, match_count = 8 }) => recallProject({ query, scope, match_count })
)

registerTool(
  server,
  'memory_fact_list',
  {
    title: 'List learned facts',
    description: 'List learned facts, optionally filtered by scope. No vector search.',
    inputSchema: {
      scope: z.string().optional(),
    },
  },
  ({ scope = null }) => listFacts({ scope })
)

if (IS_FULL) {
  registerTool(
    server,
    'memory_upsert_source',
    {
      title: 'Upsert memory source',
      description: 'Create or replace a canonical memory source, then reindex chunks.',
      inputSchema: {
        brain_id: z.string().optional(),
        source_type: z.string().optional(),
        source_key: z.string().optional(),
        title: z.string().optional(),
        uri: z.string().optional(),
        content: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        reindex: z.boolean().optional(),
      },
    },
    (args) => upsertSource({ ...args, actor: ACTOR, tool_name: 'memory_upsert_source' })
  )

  registerTool(
    server,
    'memory_update_source',
    {
      title: 'Update memory source',
      description: 'Patch a memory source. If content changes, chunks are reindexed by default.',
      inputSchema: {
        memory_source_id: z.string().uuid(),
        patch: z.object({
          brain_id: z.string().optional(),
          source_type: z.string().optional(),
          source_key: z.string().optional(),
          title: z.string().optional(),
          uri: z.string().optional(),
          content: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
        reindex: z.boolean().optional(),
      },
    },
    (args) => updateSource({ ...args, actor: ACTOR, tool_name: 'memory_update_source' })
  )

  registerTool(
    server,
    'memory_delete_source',
    {
      title: 'Delete memory source',
      description: 'Soft-delete a source and its chunks. Hard delete requires confirm_hard_delete=true.',
      inputSchema: {
        memory_source_id: z.string().uuid(),
        hard_delete: z.boolean().optional(),
        confirm_hard_delete: z.boolean().optional(),
      },
    },
    (args) => deleteSource({ ...args, actor: ACTOR, tool_name: 'memory_delete_source' })
  )

  registerTool(
    server,
    'memory_reindex_source',
    {
      title: 'Reindex memory source',
      description: 'Soft-delete old chunks for a source and regenerate active embedded chunks.',
      inputSchema: {
        memory_source_id: z.string().uuid(),
      },
    },
    (args) => reindexSource({ ...args, actor: ACTOR, tool_name: 'memory_reindex_source' })
  )

  registerTool(
    server,
    'memory_fact_save',
    {
      title: 'Save or correct a fact',
      description: 'Write or correct a learned fact/preference. Upserts on (scope, key) - same key overwrites, never duplicates. Use scope "global" for facts about Gustav, or a project slug for project knowledge. type: user|feedback|project|reference.',
      inputSchema: {
        type: z.enum(['user', 'feedback', 'project', 'reference']),
        key: z.string().min(1),
        content: z.string().min(1),
        scope: z.string().optional(),
        why: z.string().optional(),
      },
    },
    ({ type, key, content, scope = 'global', why = null }) =>
      saveMemory({ type, key, content, scope, why })
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
