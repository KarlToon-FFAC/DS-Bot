import { request } from 'node:https'

// Acceptance-only HTTPS client; trust is confined to the generated test Hub CA.
export function trustedHubFetch(url, options, ca) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options?.method ?? 'GET', headers: options?.headers, signal: options?.signal, ca }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item)
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }))
      })
    })
    req.on('error', reject); req.end(options?.body)
  })
}
