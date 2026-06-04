// Klient-sikre returtyper for mål-actions. Adskilt fra actions.ts
// (`'use server'`-filer må kun eksportere async funktioner).
import type { Goal } from '@/lib/goals-shared'

export type GoalActionResult = { ok: boolean; message?: string }
export type AddGoalResult = { ok: boolean; goal?: Goal; message?: string }
