import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/dashboard-connect')({
  component: DashboardConnect,
})

export function DashboardConnect() {
  const [status, setStatus] = useState('Checking connection…')
  const [connected, setConnected] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [port, setPort] = useState(19300)
  const [evidence, setEvidence] = useState('')
  async function check() {
    const r = await fetch('/api/dashboard-auth', { cache: 'no-store' })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Connection unavailable')
    setConnected(d.connected)
    setStatus(
      d.connected
        ? 'Dashboard connection established. Tokens stay in Workspace server memory.'
        : 'Authenticate Dashboard access using its existing Nous Portal login.',
    )
    if (d.connected) setWaiting(false)
    window.dispatchEvent(new Event('hermes:dashboard-auth-changed'))
    return d.connected
  }
  useEffect(() => {
    check().catch((e) => setError(e.message))
  }, [])
  useEffect(() => {
    if (!waiting) return
    const end = Date.now() + 300_000
    const timer = setInterval(() => {
      if (Date.now() > end) {
        setWaiting(false)
        setError('Sign-in timed out. Start a new attempt.')
        return
      }
      check().catch((e) => {
        setWaiting(false)
        setError(e.message)
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [waiting])
  async function verifyLan() {
    const rows = []
    for (const path of [
      '/api/sessions',
      '/api/profiles/list',
      '/api/swarm-kanban',
      '/api/dashboard-auth?verify=1',
    ]) {
      const r = await fetch(path, { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      rows.push({
        path,
        status: r.status,
        sessions: d.sessions?.length,
        profiles: d.profiles?.length,
        cards: d.cards?.length,
        backend: d.backend?.kind,
        checks: d.checks,
        error: r.ok ? undefined : d.error || 'Request failed',
      })
    }
    setEvidence(JSON.stringify(rows, null, 2))
  }
  async function action(name: string) {
    setError('')
    const popup = name === 'start' ? window.open('about:blank', '_blank') : null
    try {
      const r = await fetch('/api/dashboard-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: name, port }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Connection request failed')
      if (name === 'start') {
        if (!popup) throw new Error('Allow this sign-in popup, then try again.')
        popup.location.href = d.launchUrl
        setWaiting(true)
        setStatus(
          'Complete Nous sign-in in the new tab. Keep the temporary localhost tunnel open until this page confirms connection.',
        )
      } else {
        await check()
        if (name === 'renew')
          setStatus(
            'Dashboard accepted session renewal. Continue using the LAN Workspace; no tunnel is required for API calls or renewal.',
          )
      }
    } catch (e) {
      popup?.close()
      setError(e instanceof Error ? e.message : 'Sign-in failed')
    }
  }
  return (
    <main className="p-6 max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Hermes Dashboard connection</h1>
      <p>Workspace password login protects this Workspace. Dashboard authentication grants access to Dashboard APIs. The selected inference provider/model is a separate profile setting.</p>
      <p>This Nous Portal sign-in authenticates Dashboard access only; it does not select Nous models or change your inference provider, selected model, or subscription.</p>
      <p>{status}</p>
      <p>
        Normal access stays on the Workspace LAN address. A temporary SSH
        localhost connection is needed only for the supported native PKCE
        sign-in callback. No OAuth tokens are saved to configuration or sent to
        this page. A Workspace restart requires sign-in again.
      </p>
      <label className="block">
        Temporary localhost port{' '}
        <input
          aria-label="Temporary localhost port"
          className="border rounded p-1 ml-2 w-24"
          type="number"
          min="1024"
          max="65535"
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
        />
      </label>
      <div className="flex gap-4">
        {connected && (
          <button className="border rounded px-3 py-2" onClick={verifyLan}>
            Verify LAN access
          </button>
        )}
        <button
          className="border rounded px-3 py-2"
          disabled={waiting}
          onClick={() => action('start')}
        >
          {waiting ? 'Waiting for Dashboard sign-in…' : 'Connect to Dashboard via Nous Portal'}
        </button>
        {connected && (
          <button
            className="border rounded px-3 py-2"
            onClick={() => action('renew')}
          >
            Renew session
          </button>
        )}
        {connected && (
          <button
            className="border rounded px-3 py-2"
            onClick={() => action('disconnect')}
          >
            Disconnect Workspace
          </button>
        )}
      </div>
      {evidence && (
        <pre
          aria-label="LAN verification results"
          className="overflow-auto text-xs"
        >
          {evidence}
        </pre>
      )}
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      <a className="underline" href="/">
        Return to Workspace
      </a>
    </main>
  )
}
