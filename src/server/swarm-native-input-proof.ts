import type { NativeInputBinding, NativeInputLookup } from './swarm-native-bridge'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, names: Array<string>): boolean {
  return Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key))
}
function hex(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value)
}
function ref(value: unknown): boolean {
  return record(value) && keys(value, ['profile_id', 'session_id'])
    && typeof value.profile_id === 'string' && value.profile_id.length > 0
    && typeof value.session_id === 'string' && value.session_id.length > 0
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function fence(value: unknown): boolean {
  return value === null || (record(value) && keys(value, ['expected_generation']) && integer(value.expected_generation))
}

/** Validate the closed external owner schema before trusting/persisting any binding. */
export function isInputBinding(value: unknown): value is NativeInputBinding {
  return record(value) && keys(value, ['version', 'ref', 'input_id', 'principal_binding', 'payload_fingerprint', 'idle_fence'])
    && value.version === 'original-input-lookup-v1' && ref(value.ref)
    && typeof value.input_id === 'string' && value.input_id.length > 0
    && hex(value.principal_binding) && hex(value.payload_fingerprint) && fence(value.idle_fence)
}

type PositiveLookup = NativeInputLookup & {
  admission: NonNullable<NativeInputLookup['admission']>
  proof: NonNullable<NativeInputLookup['proof']>
}

/** Positive proof only: unknown versions, extra result fields and malformed/stale metadata fail closed. */
export function isPositiveInputLookup(value: unknown): value is PositiveLookup {
  if (!record(value) || !keys(value, ['version', 'state', 'reason', 'ref', 'input_id', 'principal_binding', 'binding', 'admission', 'proof', 'settled'])
      || value.version !== 'original-input-lookup-v1' || value.state !== 'found' || value.binding !== 'exact'
      || value.reason !== null || !ref(value.ref) || typeof value.input_id !== 'string' || !hex(value.principal_binding)) return false
  const a = value.admission
  const p = value.proof
  return record(a) && keys(a, ['admission_id', 'sequence', 'status', 'outcome', 'authority_epoch', 'execution_generation'])
    && typeof a.admission_id === 'string' && a.admission_id.length > 0
    && integer(a.sequence) && a.sequence > 0 && integer(a.authority_epoch)
    && (a.execution_generation === null || integer(a.execution_generation))
    && typeof a.status === 'string' && ['queued', 'started', 'unknown', 'terminal'].includes(a.status)
    && (a.status === 'terminal' ? value.settled === true && typeof a.outcome === 'string' && a.outcome.length > 0 : value.settled === false && a.outcome === null)
    && record(p) && keys(p, ['payload_fingerprint', 'idle_fence']) && hex(p.payload_fingerprint) && fence(p.idle_fence)
}
