import { describe, it, expect } from 'vitest'
import { enforcementConsequence, outcomeWords, __testing } from './PolicyCoverageSection'

/**
 * These strings are the feature. Verified against Kyverno 1.18.2 on a kind
 * cluster: a Deny policy declaring `operations: [CREATE]` admitted an update to
 * a ConfigMap that fails it, and rejected the creation of an identical one. Any
 * wording that implies what already exists is about to be blocked is wrong.
 */
describe('enforcementConsequence', () => {
  it('says a blocking CREATE+UPDATE policy rejects the next update', () => {
    const s = enforcementConsequence(7, true, true)
    expect(s).toBe(
      '7 resources already exist, so this policy does not affect them today. The next update to any of them will be rejected.',
    )
    expect(s).not.toMatch(/would be blocked|blocks these/i)
  })

  // A policy matches ConfigMaps and ClusterRoles as readily as Pods, and none of
  // those run. The claim is that the resource exists, not that it executes.
  it('never says a resource is "running"', () => {
    for (const blocks of [true, false]) {
      for (const upd of [true, false]) {
        for (const n of [1, 7]) {
          expect(enforcementConsequence(n, blocks, upd)).not.toMatch(/running|keep running/i)
        }
      }
    }
  })

  it('says a blocking CREATE-only policy grandfathers what already exists', () => {
    const s = enforcementConsequence(7, true, false)
    expect(s).toContain('stay as they are')
    expect(s).toContain('only checks creation')
    // The dangerous misreading: that these are rejected on their next change.
    expect(s).not.toContain('next update')
  })

  it('frames an audit-mode policy as a dry run, not a current block', () => {
    const s = enforcementConsequence(3, false, true)
    expect(s).toContain('Nothing is rejected today')
    expect(s).toContain('would reject the next update')
  })

  it('does not claim audit-mode CREATE-only would break what already exists', () => {
    const s = enforcementConsequence(3, false, false)
    expect(s).toContain('as they are')
    expect(s).toContain('only newly created')
  })

  it('agrees in number for a single resource', () => {
    expect(enforcementConsequence(1, true, true)).toBe(
      '1 resource already exists, so this policy does not affect it today. The next update to it will be rejected.',
    )
    expect(enforcementConsequence(1, true, false)).toContain('it is rejected only if recreated')
    expect(enforcementConsequence(1, false, true)).toContain('the next update to this resource')
    // Singular verb agreement — "1 resource already exists and stay as it is" shipped once.
    expect(enforcementConsequence(1, true, false)).toContain('exists and stays as it is')
    expect(enforcementConsequence(4, true, false)).toContain('exist and stay as they are')
  })
})

/**
 * Kyverno writes `result: fail` for every family, but a mutating policy's fail
 * carries the message "mutation is not applied" — nothing violated anything.
 */
describe('outcomeWords', () => {
  it('keeps the upstream vocabulary for validating policies', () => {
    const w = outcomeWords('validating')
    expect(w.badBadge).toBe('Fail')
    expect(w.goodBadge).toBe('Pass')
  })

  it('does not call an unapplied mutation a failure', () => {
    const w = outcomeWords('mutating')
    expect(w.badBadge).toBe('Not mutated')
    expect(w.bad).toBe('not mutated')
    expect(w.badBadge).not.toMatch(/fail/i)
  })

  it('does not call an ungenerated resource a failure', () => {
    expect(outcomeWords('generating').badBadge).toBe('Generate failed')
    // The subject is the trigger, never the generated object. "Generated" here
    // asserted the opposite of what happened.
    expect(outcomeWords('generating').goodBadge).toBe('Triggered')
    expect(outcomeWords('generating').goodBadge).not.toBe('Generated')
  })

  // Badge and headline must not disagree — the bug was a headline reading
  // "13 not mutated" above 13 rows each labelled "Fail".
  it('keeps badge and sentence wording in the same vocabulary', () => {
    for (const f of ['mutating', 'generating', 'validating'] as const) {
      const w = outcomeWords(f)
      expect(w.badBadge.toLowerCase()).toContain(w.bad.split(' ').slice(-1)[0].slice(0, 4))
    }
  })
})


/**
 * The legacy kyverno.io family answers "does this block" from a different field
 * than the modern CEL one. Reading the modern field on a legacy policy makes an
 * Enforce policy look audit-only — the exact inversion this section exists to
 * prevent.
 */
describe('legacy vs modern policy families', () => {
  const legacy = (spec: any) => ({ apiVersion: 'kyverno.io/v1', kind: 'ClusterPolicy', spec })

  it('reads Enforce from the legacy spec-level field', () => {
    expect(__testing.blocksAdmission(legacy({ validationFailureAction: 'Enforce', rules: [{ validate: {} }] }), undefined)).toBe(true)
  })

  it('reads Audit from the legacy spec-level field', () => {
    expect(__testing.blocksAdmission(legacy({ validationFailureAction: 'Audit', rules: [{ validate: {} }] }), undefined)).toBe(false)
  })

  it('falls back to a per-rule failureAction', () => {
    expect(__testing.blocksAdmission(legacy({ rules: [{ validate: { failureAction: 'Enforce' } }] }), undefined)).toBe(true)
  })

  // A legacy ClusterPolicy can mix validate/mutate/generate rules, so "what
  // enforcing does" has no single answer — better silent than confidently wrong.
  it('withholds the consequence when a legacy policy is not purely validating', () => {
    expect(__testing.canStateConsequence(legacy({ rules: [{ validate: {} }, { mutate: {} }] }), undefined)).toBe(false)
    expect(__testing.canStateConsequence(legacy({ rules: [{ generate: {} }] }), undefined)).toBe(false)
    expect(__testing.canStateConsequence(legacy({ rules: [] }), undefined)).toBe(false)
  })

  it('states the consequence for a purely validating legacy policy', () => {
    expect(__testing.canStateConsequence(legacy({ rules: [{ validate: {} }, { validate: {} }] }), undefined)).toBe(true)
  })

  // failureAction is per rule, so one policy can enforce on one rule and audit
  // on another. The sentence cannot say which rule a failure came from, so on
  // disagreement it would promise rejection for resources that only get audited.
  it('withholds the consequence when rules disagree on blocking', () => {
    expect(
      __testing.canStateConsequence(
        legacy({
          rules: [
            { validate: { failureAction: 'Enforce' } },
            { validate: { failureAction: 'Audit' } },
          ],
        }),
        undefined,
      ),
    ).toBe(false)
  })

  it('states it when a rule-level action merely restates the spec-level one', () => {
    expect(
      __testing.canStateConsequence(
        legacy({
          validationFailureAction: 'Enforce',
          rules: [{ validate: { failureAction: 'Enforce' } }, { validate: {} }],
        }),
        undefined,
      ),
    ).toBe(true)
  })

  it('still states it for the modern validating families', () => {
    const modern = { apiVersion: 'policies.kyverno.io/v1', kind: 'ValidatingPolicy', spec: {} }
    expect(__testing.canStateConsequence(modern, 'validating')).toBe(true)
    expect(__testing.canStateConsequence(modern, 'mutating')).toBe(false)
  })
})

/**
 * The footer describes rows that exist, and there are three ways to get that
 * wrong: a truncation notice above zero rows, a count taken from the wrong
 * population, and a cap notice on a rule where everything listable arrived.
 */
describe('when the server cap is worth mentioning', () => {
  // notable = non-passing subjects that arrived; notableTotal = every
  // non-passing subject the rule flagged, exact and pre-cap; hidden = the
  // non-passing ones the namespace view filter withheld.
  const capped = __testing.capWorthMentioning

  it('is silent when the cap only removed passing subjects', () => {
    // 250 pass, 1 fails, server capped at 200: the one listable row arrived and
    // the passing count is exact, so there is no gap to report.
    expect(capped(1, 1, 0)).toBe(false)
  })

  it('speaks when listable rows were cut', () => {
    expect(capped(200, 251, 0)).toBe(true)
  })

  it('is silent on a small rule that was never capped', () => {
    expect(capped(3, 3, 0)).toBe(false)
  })

  // Observed live: a policy whose only failing resource sat outside the
  // namespace filter rendered "only the first 0 are available here" over a
  // "Load the rest" button that could never produce it.
  it('does not blame the cap for what the namespace filter withheld', () => {
    expect(capped(0, 1, 1)).toBe(false)
  })

  it('still speaks when the cap bit on top of the filter', () => {
    // 10 flagged: 2 withheld by the filter, 5 arrived, 3 lost to the cap.
    expect(capped(5, 10, 2)).toBe(true)
  })
})

/**
 * The passing count labels a list, so it has to describe the same population
 * the list does. `counts.pass` is deliberately cluster-wide, and using it here
 * both overstated the label and made the missing rows look like a server cap.
 */
describe('how many passed in view', () => {
  const inView = __testing.passingInView

  it('is the cluster count when nothing is filtered out', () => {
    expect(inView(12, 0, 0)).toBe(12)
  })

  it('discounts the passing subjects the filter withheld', () => {
    // 5 withheld, 2 of them failing, so 3 passes went with them.
    expect(inView(12, 5, 2)).toBe(9)
  })

  it('claims nothing passes in view when every pass was withheld', () => {
    expect(inView(3, 4, 1)).toBe(0)
  })

  it('never goes negative on inconsistent counts', () => {
    expect(inView(1, 9, 0)).toBe(0)
    expect(inView(5, 2, 7)).toBe(5)
  })
})

describe('fold button wording', () => {
  const label = (notable: number, notableTotal: number) =>
    notable < notableTotal ? `Show ${notable} of ${notableTotal}` : `Show all ${notable}`

  // "Show all 200" on a rule with 251 flagged subjects is a false promise.
  it('does not claim to show all when the cap cut the list', () => {
    expect(label(200, 251)).toBe('Show 200 of 251')
  })

  it('uses the house wording when the client holds everything', () => {
    expect(label(15, 15)).toBe('Show all 15')
  })
})

/**
 * Verified against Kyverno 1.18.2: `legacy-generate-companion` is a
 * ClusterPolicy whose only rule generates a NetworkPolicy, and its report result
 * for the trigger ConfigMap is `pass`. Reading the kind alone returns no family,
 * so the section called that "1 passing" — the validate vocabulary, on a rule
 * that validates nothing.
 */
describe('policyFamilyFor', () => {
  const { policyFamilyFor } = __testing
  const legacy = (rules: any[]) => ({ apiVersion: 'kyverno.io/v1', kind: 'ClusterPolicy', spec: { rules } })

  it('reads the family off the rule block on a legacy policy', () => {
    expect(policyFamilyFor(legacy([{ name: 'companion', generate: {} }]))).toBe('generating')
    expect(policyFamilyFor(legacy([{ name: 'add-label', mutate: {} }]))).toBe('mutating')
    expect(policyFamilyFor(legacy([{ name: 'no-latest', validate: {} }]))).toBe('validating')
    expect(policyFamilyFor(legacy([{ name: 'signed', verifyImages: {} }]))).toBe('imageValidating')
  })

  // A policy that both validates and generates has no single vocabulary, and
  // picking either one states something false about half its rules.
  it('gives no family to a policy that mixes them', () => {
    expect(
      policyFamilyFor(legacy([{ name: 'a', validate: {} }, { name: 'b', generate: {} }])),
    ).toBeUndefined()
  })

  it('answers per rule when asked, even in a mixed policy', () => {
    const p = legacy([{ name: 'a', validate: {} }, { name: 'b', generate: {} }])
    expect(policyFamilyFor(p, 'b')).toBe('generating')
    expect(policyFamilyFor(p, 'a')).toBe('validating')
  })

  // Report rows carry the autogen name, which never matches spec.rules[].name.
  it('resolves autogen rule names back to their source rule', () => {
    const p = legacy([{ name: 'validate-image-tag', validate: {} }])
    expect(policyFamilyFor(p, 'autogen-validate-image-tag')).toBe('validating')
    expect(policyFamilyFor(p, 'autogen-cronjob-validate-image-tag')).toBe('validating')
  })

  it('still reads the modern family off the kind', () => {
    expect(policyFamilyFor({ apiVersion: 'policies.kyverno.io/v1alpha1', kind: 'MutatingPolicy' })).toBe('mutating')
    expect(policyFamilyFor({ apiVersion: 'policies.kyverno.io/v1alpha1', kind: 'GeneratingPolicy' })).toBe('generating')
  })
})

/**
 * The consequence sentence is the highest-stakes claim on the page, and the
 * legacy family keeps its operations somewhere the modern accessor cannot see:
 * `spec.rules[].match.any[].resources.operations`, not `spec.matchConstraints`.
 * Reading only the modern shape returns no rules, defaults to "matches
 * updates", and states the consequence backwards.
 */
describe('legacyMatchesUpdates', () => {
  const { legacyMatchesUpdates } = __testing
  const legacy = (ops?: string[]) => ({
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    spec: {
      rules: [
        {
          name: 'r',
          match: { any: [{ resources: ops ? { kinds: ['ConfigMap'], operations: ops } : { kinds: ['ConfigMap'] } }] },
          validate: {},
        },
      ],
    },
  })

  // Kyverno's default when the list is absent is CREATE and UPDATE.
  it('treats an absent operations list as matching updates', () => {
    expect(legacyMatchesUpdates(legacy())).toBe(true)
    expect(legacyMatchesUpdates(legacy([]))).toBe(true)
  })

  it('reports a CREATE-only legacy rule as not matching updates', () => {
    expect(legacyMatchesUpdates(legacy(['CREATE']))).toBe(false)
  })

  it('reads CREATE+UPDATE', () => {
    expect(legacyMatchesUpdates(legacy(['CREATE', 'UPDATE']))).toBe(true)
  })

  it('reads the all[] and bare resources shapes too', () => {
    const all = { apiVersion: 'kyverno.io/v1', spec: { rules: [{ match: { all: [{ resources: { operations: ['CREATE'] } }] } }] } }
    const bare = { apiVersion: 'kyverno.io/v1', spec: { rules: [{ match: { resources: { operations: ['CREATE'] } } }] } }
    expect(legacyMatchesUpdates(all)).toBe(false)
    expect(legacyMatchesUpdates(bare)).toBe(false)
  })

  it('says yes when it cannot tell, matching Kyverno’s own default', () => {
    expect(legacyMatchesUpdates({ apiVersion: 'kyverno.io/v1', spec: {} })).toBe(true)
  })
})

/**
 * The consequence is one sentence above one failing count. A legacy policy
 * whose rules disagree about UPDATE has two answers, and asserting either one
 * says something false about the resources failing the other rule.
 */
describe('legacyOperationsAgree', () => {
  const { legacyOperationsAgree, canStateConsequence } = __testing
  const withRules = (...ops: Array<string[] | undefined>) => ({
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    spec: {
      rules: ops.map((o, i) => ({
        name: `r${i}`,
        validate: {},
        match: { any: [{ resources: o ? { kinds: ['ConfigMap'], operations: o } : { kinds: ['ConfigMap'] } }] },
      })),
    },
  })

  it('agrees when every rule matches updates', () => {
    expect(legacyOperationsAgree(withRules(undefined, ['CREATE', 'UPDATE']))).toBe(true)
  })

  it('agrees when every rule is CREATE-only', () => {
    expect(legacyOperationsAgree(withRules(['CREATE'], ['CREATE']))).toBe(true)
  })

  it('does not agree when one rule is CREATE-only and another matches updates', () => {
    expect(legacyOperationsAgree(withRules(['CREATE'], undefined))).toBe(false)
  })

  // The point of the helper: disagreement withholds the sentence entirely.
  it('withholds the consequence when the rules disagree', () => {
    expect(canStateConsequence(withRules(['CREATE'], undefined), undefined)).toBe(false)
    expect(canStateConsequence(withRules(['CREATE'], ['CREATE']), undefined)).toBe(true)
  })
})

/**
 * Kyverno does not only put authored rule names in `results[].rule`. Verified
 * against 1.18.2: the CEL family writes an EMPTY rule for ordinary results and
 * the literal `evaluation` when the engine itself failed. Rendering that in the
 * slot that shows `validate-image-tag` invents a rule the policy has not got.
 */
describe('ruleHeading', () => {
  const { ruleHeading } = __testing
  const counts = (o: Partial<Record<string, number>> = {}) => ({
    pass: 0, fail: 0, warn: 0, error: 0, skip: 0, ...o,
  })
  const policy = { spec: { rules: [{ name: 'validate-image-tag' }] } }

  it('shows a name the policy actually declares', () => {
    expect(ruleHeading(policy, { rule: 'validate-image-tag', counts: counts({ pass: 1 }), subjects: [] } as any))
      .toBe('validate-image-tag')
  })

  it('shows nothing for the empty rule the CEL family writes', () => {
    expect(ruleHeading({ spec: {} }, { rule: '', counts: counts({ fail: 2 }), subjects: [] } as any))
      .toBeUndefined()
  })

  it('describes an all-error bucket instead of naming a rule that does not exist', () => {
    expect(ruleHeading({ spec: {} }, { rule: 'evaluation', counts: counts({ error: 18 }), subjects: [] } as any))
      .toBe('Engine errors')
  })

  // Only when it is unambiguous. A mixed bucket keeps the raw string rather
  // than being relabelled on a guess.
  it('keeps an unknown name when the bucket is not purely errors', () => {
    expect(ruleHeading({ spec: {} }, { rule: 'evaluation', counts: counts({ error: 1, fail: 1 }), subjects: [] } as any))
      .toBe('evaluation')
  })
})

/**
 * A rule that errored reached no verdict, so the policy knows nothing about
 * that resource. Counting only fail and warn leaves an all-errors policy under
 * a green shield, collapsed, claiming the one thing it cannot.
 */
describe('what counts as a problem', () => {
  const counts = (c: Partial<Record<string, number>>) => ({
    pass: 0, fail: 0, warn: 0, error: 0, skip: 0, ...c,
  }) as any

  it('treats engine errors as a problem', () => {
    expect(__testing.problemCount(counts({ error: 3 }))).toBe(3)
  })

  it('does not treat a skipped rule as a problem', () => {
    // The rule did not apply, which is not a problem with anything.
    expect(__testing.problemCount(counts({ pass: 5, skip: 9 }))).toBe(0)
  })

  it('adds up the three that are', () => {
    expect(__testing.problemCount(counts({ fail: 1, warn: 2, error: 4, pass: 8, skip: 3 }))).toBe(7)
  })
})

/**
 * Missing results are dropped before counting, so an examined count of zero
 * means either "nothing was checked" or "something did not reach this
 * response" — opposite claims, and only one of them is about the policy.
 */
describe('telling an empty policy from an incomplete answer', () => {
  const resp = (o: any) => ({
    withheldNamespaces: 0, withheldClusterScoped: false, ...o,
  }) as any

  it('is silent when the whole answer arrived', () => {
    expect(__testing.anythingWithheld(resp({}))).toBe(false)
  })

  it('spots each way results can go missing', () => {
    expect(__testing.anythingWithheld(resp({ withheldNamespaces: 2 }))).toBe(true)
    expect(__testing.anythingWithheld(resp({ withheldClusterScoped: true }))).toBe(true)
    expect(__testing.anythingWithheld(resp({ withheldByFamily: 1 }))).toBe(true)
    // Radar's own probe failing to index a family is not the caller's
    // permissions, but it still means absence cannot be asserted.
    expect(__testing.anythingWithheld(resp({ deniedGroups: ['openreports.io'] }))).toBe(true)
  })
})
