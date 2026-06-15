/**
 * Tracelapse — /api/* proxy (Cloudflare Pages Function).
 *
 * Keeps everything on the brand domain (tracelapse.pista.bike): the Strava OAuth
 * callback, account linking and activity proxy all live on the always-on VPS
 * service, and this Function simply forwards /api/* there. So the Strava
 * "Authorization Callback Domain" stays tracelapse.pista.bike while the stateful
 * logic (token storage, webhook, email) runs on the VPS.
 */
const ORIGIN = 'https://tracelapse.tbrun.dev'

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)
  const target = ORIGIN + url.pathname + url.search // pathname keeps the /api/... prefix

  const headers = new Headers(request.headers)
  headers.delete('host')

  const init = { method: request.method, headers, redirect: 'manual' }
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer()

  const resp = await fetch(target, init)
  // Pass through status, body and headers (incl. 302 Location to Strava / the app).
  const out = new Headers(resp.headers)
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out })
}
