import { useEffect, useState } from 'react'

export function DashboardAuthNotice() {
  const [state, setState] = useState<'checking' | 'required' | 'workspace-auth' | 'unavailable' | 'healthy'>('checking')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const cancelled = () => controller.signal.aborted
    let pending = false
    async function check() {
      if (pending || cancelled()) return
      pending = true
      try {
        const response = await fetch('/api/dashboard-auth', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
        const data = await response.json().catch(() => null)
        if (cancelled()) return
        setState(response.status === 401 ? 'workspace-auth' : !response.ok || !data || typeof data.authRequired !== 'boolean' ? 'unavailable' : data.authRequired && !data.connected ? 'required' : 'healthy')
      } catch { if (!cancelled()) setState('unavailable') }
      finally { pending = false }
    }
    function visible() { if (document.visibilityState === 'visible') void check() }
    void check()
    window.addEventListener('hermes:dashboard-auth-changed', check)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller.abort()
      window.removeEventListener('hermes:dashboard-auth-changed', check)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [revision])
  return state !== 'healthy' ? (
    <aside role="status" className="shrink-0 border-b bg-background px-4 py-2 text-sm">
      <strong>{state === 'unavailable' ? 'Hermes Dashboard connection unavailable; status unknown.' : state === 'workspace-auth' ? 'Workspace password login required.' : state === 'checking' ? 'Checking Hermes Dashboard connection…' : 'Hermes Dashboard connection required.'}</strong>{' '}
      {state !== 'workspace-auth' ? <a className="underline" href="/dashboard-connect">Connect to Dashboard</a> : <a className="underline" href="/">Sign in to Workspace</a>}
      <button type="button" className="ml-3 underline" onClick={() => setRevision((value) => value + 1)}>Check connection</button>
      <p className="text-xs">Nous Portal authenticates Dashboard access only; it does not select Nous models or change your inference provider or subscription. Workspace password login is separate.</p>
    </aside>
  ) : null
}
