// Klient-sikre returtyper for opgave-boardets server actions. Holdes adskilt fra
// actions.ts (`'use server'`-filer må kun eksportere async funktioner).
import type { Task } from '@/lib/tasks-shared'

export type TaskActionResult = { ok: boolean; message?: string }
export type AddTaskResult = { ok: boolean; task?: Task; message?: string }
