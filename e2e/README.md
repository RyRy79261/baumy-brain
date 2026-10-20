# End-to-end tests (`pnpm test:e2e`)

The whole Baumy stack on this machine, driven like Telegram drives it. No phone, no cloud account, no
API key, nothing shared with production. CI runs it on every PR (`.github/workflows/e2e.yml`).

| Piece | What runs |
| --- | --- |
| The app | A production `next build` of this checkout, served by `next start` |
| Database | Postgres 17 + pgvector in Docker, migrated by the real `pnpm db:migrate`, reached through the two Neon proxies so the app uses the SAME `@neondatabase/serverless` drivers as on Neon (`db/local-proxy.ts`) |
| Background work | The Inngest dev server in Docker: the same steps, retries, per-chat concurrency, `sleepUntil` and crons |
| Claude | `fake-anthropic.ts`: Anthropic's Messages API answered from `script.ts` — the SAME scripted fixtures as the offline scenarios (`scenarios/fake-model.ts`). The model is not under test; the plumbing is. It fails on demand (429 / 500 / 529, slow answers) |
| Voyage | The fake server's `/voyage/v1/embeddings`: `embedSync` vectors, the offline suite's embedder |
| Telegram | `fake-telegram.ts`: the Bot API calls Baumy makes, answered with Telegram's shapes and errors (reply ids, "message is not modified", 429 + `retry_after`, chat not found); faults and latency on demand |
| Baumy Olympics | `scenarios/olympics-fake.ts`, the same fake the offline scenarios use |

A test speaks as a housemate: a real-shaped Telegram Update POSTed to `/api/telegram/webhook` with the
secret header. It checks facts only, never a model's opinion: the Bot API calls the fake recorded, the
rows in the database, and the run's outcome in the update ledger (`baumy_telegram_updates.status` =
`processed` / `dead_letter`, `outcome` = what the turn decided).

## Run it

Needs Docker only.

```bash
pnpm test:e2e                       # build, start the stack, run e2e/*.e2e.ts, tear it all down
E2E_SKIP_BUILD=1 pnpm test:e2e      # reuse the last .next build
E2E_APP_LOG=1 pnpm test:e2e         # print the app's log at the end
E2E_KEEP=1 pnpm test:e2e            # leave the stack up to poke at
```

The build goes into `.next`, like `pnpm build`.

## Write a test

```ts
const h = house()
const start = await h.mark()
await h.say('Marco', `@${h.stack.bot.username} remind me in 2 minutes to take the bread out`)
const run = await h.done()                 // waits for the ledger to say the run ended
expect(run.outcome).toMatchObject({ reminderSet: true })
await h.waitFor((c) => c.method === 'sendMessage' && /bread/.test(String(c.params.text)), { since: start })
```

`h.tap()` taps a card button, `h.fault()` makes the fake Telegram fail a call, `h.aiFault()` makes the
fake Claude fail one, `h.db` reads the test database. A new message needs its answers in `script.ts`;
a prompt the script does not know fails the test at once. The house (Chloe the owner, Marco, Ryan) is onboarded once per run, the real way.
