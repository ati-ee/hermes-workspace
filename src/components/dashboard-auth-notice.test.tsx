// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/dom'
import { DashboardConnect } from '../routes/dashboard-connect'
import { DashboardAuthNotice } from './dashboard-auth-notice'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'

vi.mock('@tanstack/react-router', async (original) => ({ ...await original<object>(), createFileRoute: () => (options: unknown) => ({ options }) }))
let root: Root | undefined
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
async function render(node: ReactNode) { root = createRoot(document.body.appendChild(document.createElement('div'))); await act(async () => root!.render(node)) }
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
it('identifies Dashboard auth, not model selection, with a non-overlay action', async () => {
  const http = vi.fn().mockResolvedValue(Response.json({ authRequired: true, connected: false }))
  vi.stubGlobal('fetch', http)
  await render(<DashboardAuthNotice />)
  const action = await screen.findByRole('link', { name: 'Connect to Dashboard' })
  expect(action.getAttribute('href')).toBe('/dashboard-connect')
  expect(action.closest('[role="status"]')?.className).not.toMatch(/fixed|absolute/)
  expect(screen.getByText(/does not select Nous models/i)).toBeTruthy()
  expect(http.mock.calls).toHaveLength(1)
})
it('cancels a pending bounded check on unmount without starting another auth request', async () => {
  const http = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', http)
  await render(<DashboardAuthNotice />)
  const signal = http.mock.calls[0][1]?.signal
  await act(() => root?.unmount())
  root = undefined
  expect(signal?.aborted).toBe(true)
  expect(http.mock.calls).toHaveLength(1)
})
it('updates after a real connection event and keeps unavailable status visible without an auth retry loop', async () => {
  const http = vi.fn().mockResolvedValueOnce(Response.json({ authRequired: true, connected: false })).mockResolvedValueOnce(Response.json({ authRequired: true, connected: true })).mockRejectedValueOnce(new Error('synthetic offline'))
  vi.stubGlobal('fetch', http)
  await render(<DashboardAuthNotice />)
  expect(await screen.findByRole('link', { name: 'Connect to Dashboard' })).toBeTruthy()
  await act(async () => window.dispatchEvent(new Event('hermes:dashboard-auth-changed')))
  expect(screen.queryByRole('link', { name: 'Connect to Dashboard' })).toBeNull()
  await act(async () => window.dispatchEvent(new Event('hermes:dashboard-auth-changed')))
  expect(screen.getByRole('status').textContent).toContain('unavailable')
  expect(http.mock.calls).toHaveLength(3)
})
it('keeps Workspace password, Dashboard login and inference provider explicitly distinct without starting OAuth automatically', async () => {
  const http = vi.fn().mockResolvedValue(Response.json({ connected: false }))
  vi.stubGlobal('fetch', http)
  await render(<DashboardConnect />)
  expect(screen.getByRole('heading', { name: 'Hermes Dashboard connection' })).toBeTruthy()
  expect(screen.getByText(/Workspace password login/i)).toBeTruthy()
  expect(screen.getByText(/does not select Nous models/i)).toBeTruthy()
  const action = screen.getByRole('button', { name: 'Connect to Dashboard via Nous Portal' })
  expect(action).toBeTruthy()
  await screen.findByText(/existing Nous Portal login/i)
  expect(http.mock.calls).toHaveLength(1)
  expect(http.mock.calls[0][0]).toBe('/api/dashboard-auth')
  // Reading the help page is not authorization to start a flow or submit a mission.
  await act(async () => fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '19301' } }))
  expect(http.mock.calls).toHaveLength(1)
})
