// Script-indgang til fakta-laget: load-env + egen supabase-klient + re-export.
//
// Al logik ligger nu i lib/memory-facts-core.mjs (delt med Next.js-routerens
// lib/memory-facts.ts), så rettelser laves ét sted. Denne fil binder kun
// scripts-afhængighederne (env-load, egen supabase-klient, embedText fra
// embed.mjs) og bevarer det API som CLI'en (memory-facts.mjs) og MCP-serveren
// (memory-mcp-server.mjs) allerede bruger.
//
// Bevidst forskel fra TS-siden: her KASTER funktionerne ved fejl (CLI/MCP vil
// se fejlen), mens routerens recallGlobal fejler blødt (hot-path).
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { embedText } from './embed.mjs'
import {
  FACTS_TOKEN_THRESHOLD,
  VALID_FACT_TYPES,
  consolidateFactsCore,
  deleteMemoryCore,
  listFactsCore,
  loadAllForScopeCore,
  recallProjectCore,
  saveMemoryCore,
} from '../lib/memory-facts-core.mjs'

export { FACTS_TOKEN_THRESHOLD, VALID_FACT_TYPES }

let _supabase = null
function getSupabase() {
  if (_supabase) return _supabase
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Mangler NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i .env.local')
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } })
  return _supabase
}

function deps() {
  return { sb: getSupabase(), embedText }
}

// Skriv eller ret et faktum (upsert på scope+key).
export function saveMemory(args) {
  return saveMemoryCore(deps(), args)
}

// Slet ét faktum (scope+key). Idempotent.
export function deleteMemory(args) {
  return deleteMemoryCore(deps(), args)
}

// Liste over fakta, evt. filtreret på scope. Stabil ordning (scope, type, key).
export function listFacts(args = {}) {
  return listFactsCore(deps(), args)
}

// Hele det globale lag i fuld (ingen vektor-søgning).
export function recallGlobal() {
  return loadAllForScopeCore(deps(), 'global')
}

// Semantisk søgning inden for ÉT scope (match_memory_facts RPC).
export function recallProject(args) {
  return recallProjectCore(deps(), args)
}

// Manuel konsolidering (v1): rapport over semantisk nære dublet-par. Sletter intet.
export function consolidateFacts(args = {}) {
  return consolidateFactsCore(deps(), args)
}
