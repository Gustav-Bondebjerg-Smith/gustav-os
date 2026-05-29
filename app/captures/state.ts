// Client-safe types til /captures' web-capture form. Holdes adskilt fra
// actions.ts (`'use server'`-filer må kun eksportere async funktioner).

export type CreateCaptureState = {
  ok: boolean
  message: string
  area: string | null
  type: string | null
}

export const initialCreateCaptureState: CreateCaptureState = {
  ok: false,
  message: '',
  area: null,
  type: null,
}
