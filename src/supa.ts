import { createClient, type User } from '@supabase/supabase-js'
import { reactive } from 'vue'

// Shared Pista account base (self-host Supabase, public anon key).
const PISTA_URL = 'https://api.pista.bike'
const PISTA_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgwMzUwMDAyLCJleHAiOjIwOTU3MTAwMDJ9.QgFqLl2IkRA_gjjX6JF8qIYdUBDT-2XIdnPYOrs5lzc'

export const supabase = createClient(PISTA_URL, PISTA_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

export const auth = reactive<{ user: User | null; ready: boolean }>({ user: null, ready: false })

supabase.auth.getSession().then(({ data }) => {
  auth.user = data.session?.user ?? null
  auth.ready = true
})
supabase.auth.onAuthStateChange((_e, session) => {
  auth.user = session?.user ?? null
})

export function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password })
}
export function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password })
}
export function signInGoogle() {
  return supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.search } })
}
export function signOut() {
  return supabase.auth.signOut()
}
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}
