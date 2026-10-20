// The e2e stack's fake Claude (e2e/README.md): Anthropic's Messages API, answered from the SAME
// scripted fixtures the offline scenarios use (scenarios/fake-model.ts). The model is not what an e2e
// run tests — the plumbing around it is — so the answers are fixed, and the interesting part is what
// the API can do to Baumy: a 429 / 529 / 500, a slow answer. The app reaches it via ANTHROPIC_BASE_URL.

import { MODELS, type Role } from '@/lib/ai/models'
import { scriptedAnswer, FakeModelError, type Fixtures, type CallRole } from '@/scenarios/fake-model'

export interface AiFault {
  /** Only calls of this role (triage, reply, reminder, …); omit for any. */
  role?: CallRole
  status: 429 | 500 | 529
  /** How many calls fail (default 1). */
  times?: number
  delayMs?: number
}

export interface AiCall {
  seq: number
  role: CallRole
  model: string
  /** The message the call was about (the scripted model's `text`). */
  message: string
  status: number
}

type Block = { type: string; text?: string }
interface MessagesRequest {
  model: string
  system?: string | Block[]
  messages: { role: string; content: string | Block[] }[]
  tools?: { name: string }[]
  tool_choice?: { type: string; name?: string }
  output_format?: unknown
}

const text = (c: string | Block[] | undefined): string =>
  typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')

const ERROR_TYPE: Record<number, string> = { 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' }

export class FakeAnthropic {
  readonly calls: AiCall[] = []
  /** Faults in the SCRIPT (a prompt it does not know): the driver fails the test on any. */
  readonly harnessErrors: string[] = []
  private faults: AiFault[] = []
  private seq = 0
  latency: [number, number] = [50, 400]

  constructor(private readonly fixtures: Fixtures) {}

  addFault(f: AiFault): void {
    this.faults.push({ times: 1, ...f })
  }

  /** One POST /v1/messages → [status, body]. */
  async messages(body: MessagesRequest): Promise<[number, unknown]> {
    const tier = (Object.entries(MODELS).find(([, m]) => m.id === body.model)?.[0] ?? 'reply') as Role
    const system = text(body.system)
    const prompt = body.messages.filter((m) => m.role === 'user').map((m) => text(m.content)).join('\n')
    let scripted: ReturnType<typeof scriptedAnswer>
    try {
      scripted = scriptedAnswer(system, prompt, tier, this.fixtures)
    } catch (e) {
      if (!(e instanceof FakeModelError)) throw e
      this.harnessErrors.push(e.message)
      // A 400 is not retried: the run fails at once instead of after Inngest's backoff.
      return [400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } }]
    }
    const { role, text: answer, message } = scripted

    const fault = this.faults.find((f) => (f.times ?? 0) > 0 && (f.role == null || f.role === role))
    const [lo, hi] = this.latency
    await new Promise((r) => setTimeout(r, (fault?.delayMs ?? 0) + lo + Math.random() * (hi - lo)))
    const seq = ++this.seq
    if (fault) {
      fault.times = (fault.times ?? 1) - 1
      this.calls.push({ seq, role, model: body.model, message, status: fault.status })
      return [fault.status, { type: 'error', error: { type: ERROR_TYPE[fault.status], message: 'e2e fault' } }]
    }
    this.calls.push({ seq, role, model: body.model, message, status: 200 })

    // generateObject's default mode forces a tool named "json"; its input IS the object.
    const forced = body.tool_choice?.type === 'tool' ? body.tool_choice.name : undefined
    const content = forced
      ? [{ type: 'tool_use', id: `toolu_e2e_${seq}`, name: forced, input: JSON.parse(answer) as unknown }]
      : answer
        ? [{ type: 'text', text: answer }]
        : []
    return [
      200,
      {
        id: `msg_e2e_${seq}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: forced ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: Math.ceil((system.length + prompt.length) / 4), output_tokens: Math.ceil(answer.length / 4) },
      },
    ]
  }
}
