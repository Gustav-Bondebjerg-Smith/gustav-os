// State for /login. Adskilt fra actions.ts fordi 'use server'-filer kun må
// eksportere async funktioner (samme mønster som /ask).
export type LoginState = {
  sent: boolean
  email: string
  error: string | null
}

export const initialLoginState: LoginState = {
  sent: false,
  email: '',
  error: null,
}
