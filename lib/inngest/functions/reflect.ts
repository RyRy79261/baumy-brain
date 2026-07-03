import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { reconcileFact } from '@/lib/memory/facts'
import { reflectPerson } from '@/lib/ai/reflect'
import { pickPeopleToReflect, gatherPersonMaterial, PROFILE_PREDICATE } from '@/lib/memory/reflect'

// Sleep-time reflection (memory v2 §4) — the "it learns" step. On a slow cron (not the
// hot path), Baumy consolidates what it already knows: for each person with fresh
// activity since their last profile, it re-reads their OWN facts + attributed notes and
// synthesises a durable, plain-language profile, stored back as a 'system'-trust fact
// (so it supersedes the prior profile and grounds future answers).
//
// Security: this reads ALREADY-TRUSTED rows only — reconcileFact never runs on group
// text here (the material was captured through the injection wall), secrets are filtered
// out of the material (never in a profile / digest), and quarantined content is excluded.
// A 'system'-trust profile can only be superseded by another system reflection, so no
// group message can overwrite it. Idempotent-ish: an unchanged person is not re-picked.
export const reflectSweep = inngest.createFunction(
  { id: 'reflect-sweep', retries: 1 },
  { cron: '0 */6 * * *' },
  async ({ step }) => {
    const groupId = (await step.run('house', async () => getHouseChatId(createHttpDb()))) as string
    if (!groupId) return { skipped: 'no-house' as const }

    // Bound the batch — reflection is a Sonnet call per person, and the house is small.
    const people = (await step.run('pick', async () => pickPeopleToReflect(createHttpDb(), groupId, 8))) as Array<{
      id: string
      name: string
    }>

    let reflected = 0
    for (const p of people) {
      const did = (await step.run(`reflect:${p.id}`, async () => {
        const db = createHttpDb()
        const { facts, notes } = await gatherPersonMaterial(db, groupId, p.id)
        if (facts.length < 2) return false // guard: nothing durable to consolidate
        const profile = await reflectPerson(p.name, facts, notes)
        if (!profile) return false
        // Store as a system-trust profile fact; reconcileFact supersedes the prior one.
        // neverSecret: the profile is a readable summary of already-secret-filtered
        // material, so it must never be encrypted if a paraphrase trips the secret scan.
        await reconcileFact(db, {
          groupId,
          fact: { subject: p.name, subjectKind: 'person', predicate: PROFILE_PREDICATE, object: profile },
          authoredBy: null,
          trustLevel: 'system',
          neverSecret: true,
        })
        return true
      })) as boolean
      if (did) reflected += 1
    }

    return { people: people.length, reflected }
  },
)
