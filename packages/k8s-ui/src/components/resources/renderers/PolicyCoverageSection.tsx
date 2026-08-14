import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Section } from '../../ui/drawer-components'
import { SEVERITY_BADGE } from '../../../utils/badge-colors'
import { isForbiddenError } from '../../../types/fetch-error'
import {
  getKyvernoPolicyFamily,
  getKyvernoEnforcementPosture,
  getKyvernoResourceRules,
  getKyvernoFailurePolicy,
  type KyvernoPolicyFamily,
} from '../resource-utils-kyverno-modern'
import { getKyvernoPolicyAction } from '../resource-utils-kyverno'
import type {
  PolicyCoverageResponse,
  PolicyCoverageRule,
  PolicyCoverageSubject,
} from '../../../types/policy'

interface PolicyCoverageSectionProps {
  /** The policy resource itself — enforcement consequence is a property of the
   *  policy's spec, not of the report data. */
  resource: any
  data: PolicyCoverageResponse | null
  loading?: boolean
  error?: Error | null
  onSelectSubject?: (subject: PolicyCoverageSubject) => void
  /**
   * Re-fetch the coverage with a higher subject bound.
   *
   * The default response bounds each rule's list so an ordinary drawer open
   * stays small. Without a way to raise it, a rule with more subjects than the
   * bound ends at a sentence — the count is honest and the resources behind it
   * are unreachable, which is the dead end this closes. Hosts that cannot
   * re-fetch simply omit it and keep the sentence.
   */
  onLoadMore?: () => void
  loadingMore?: boolean
}

const TITLE = 'Resources'

// Matches RELATIONSHIP_TRUNCATE_LIMIT in drawer-components: the point at which
// a list of related resources folds behind "Show all N".
const SUBJECT_FOLD_LIMIT = 10

export interface OutcomeWords {
  /** Sentence form, e.g. "13 not mutated". */
  bad: string
  good: string
  /** Badge form, e.g. "Not mutated". */
  badBadge: string
  goodBadge: string
}

/**
 * Outcome vocabulary by policy family.
 *
 * The report says `result: fail` for every family, but it does not mean the same
 * thing in each. A validating policy's `fail` is a violation. A mutating
 * policy's `fail` carries the message "mutation is not applied" — nothing
 * violated anything, a label simply never got added. Printing "Fail" there tells
 * an operator their resource is non-compliant when it isn't.
 *
 * Validating keeps the upstream words verbatim: they are what
 * `kubectl get policyreport` prints, and matching them is what lets someone
 * correlate this screen with the CLI.
 */
export function outcomeWords(family: KyvernoPolicyFamily | undefined): OutcomeWords {
  switch (family) {
    case 'mutating':
      return { bad: 'not mutated', good: 'mutated', badBadge: 'Not mutated', goodBadge: 'Mutated' }
    case 'generating':
      // The subject of a generate result is the TRIGGER, not the object the
      // rule produced — Kyverno records the resource that caused generation and
      // never names the target here. "Generated" on that row states the exact
      // opposite of what happened: it reads as "this ConfigMap was generated"
      // about the ConfigMap that caused a NetworkPolicy to be generated. The
      // wording has to keep the subject in its real role.
      return {
        bad: 'failed to generate',
        good: 'triggered generation',
        badBadge: 'Generate failed',
        goodBadge: 'Triggered',
      }
    default:
      return { bad: 'failing', good: 'passing', badBadge: 'Fail', goodBadge: 'Pass' }
  }
}

function resultTone(result: string, words: OutcomeWords): { badge: string; label: string } {
  switch (result.toLowerCase()) {
    case 'fail':
      return { badge: SEVERITY_BADGE.error, label: words.badBadge }
    case 'pass':
      return { badge: SEVERITY_BADGE.success, label: words.goodBadge }
    // warn / error / skip mean the same thing whatever the family: the rule
    // flagged it, the engine broke, or the rule declined to look.
    case 'warn':
      return { badge: SEVERITY_BADGE.warning, label: 'Warn' }
    case 'error':
      return { badge: SEVERITY_BADGE.alert, label: 'Error' }
    case 'skip':
      return { badge: SEVERITY_BADGE.neutral, label: 'Skipped' }
    default:
      return { badge: SEVERITY_BADGE.neutral, label: result }
  }
}

/**
 * Whether the policy's match rules cover updates to an existing object.
 *
 * This is what decides the consequence of enforcing, and it is not intuitive: a
 * CREATE-only policy never rejects a change to something that already exists, so
 * resources currently failing it are grandfathered until they are recreated.
 * Verified against Kyverno 1.18.2 — annotating a ConfigMap that fails a
 * CREATE-only Deny policy is admitted, while creating an identical one is
 * rejected.
 */
function matchesUpdates(resource: any): boolean {
  if (isLegacyKyvernoPolicy(resource)) return legacyMatchesUpdates(resource)
  const rules = getKyvernoResourceRules(resource)
  if (rules.length === 0) return true
  return rules.some((r) => r.operations.length === 0 || r.operations.includes('UPDATE'))
}

/**
 * The same question for a legacy policy, whose operations live somewhere else
 * entirely: `spec.rules[].match.any[].resources.operations`, not
 * `spec.matchConstraints`. Reading only the modern shape returns no rules at
 * all, which defaults to "matches updates" — and states the consequence
 * backwards for a CREATE-only legacy rule.
 *
 * Unset means CREATE and UPDATE in Kyverno, so an absent list is a match.
 */
function legacyMatchesUpdates(resource: any): boolean {
  return legacyRuleUpdateMatches(resource).some(Boolean)
}

/** One answer per rule, in `spec.rules` order. */
function legacyRuleUpdateMatches(resource: any): boolean[] {
  const rules: any[] = resource?.spec?.rules ?? []
  if (rules.length === 0) return [true]
  return rules.map((rule: any) => {
    const blocks = [
      ...(rule?.match?.any ?? []),
      ...(rule?.match?.all ?? []),
      ...(rule?.match?.resources ? [rule.match] : []),
    ]
    if (blocks.length === 0) return true
    return blocks.some((b: any) => {
      const ops = b?.resources?.operations
      return !Array.isArray(ops) || ops.length === 0 || ops.includes('UPDATE')
    })
  })
}

/**
 * Whether every rule of a legacy policy answers the update question the same
 * way.
 *
 * The consequence sentence is written once, above the rules, and applies to the
 * failing count as a whole. A policy with one CREATE-only rule and one that also
 * matches updates has two different answers, and stating either one asserts
 * something false about the resources failing the other.
 */
function legacyOperationsAgree(resource: any): boolean {
  const answers = legacyRuleUpdateMatches(resource)
  return answers.every((a) => a === answers[0])
}

/**
 * What to call a bucket of results.
 *
 * Kyverno does not only put authored rule names in `results[].rule`. The CEL
 * family writes an EMPTY rule for ordinary results, and writes the literal
 * `evaluation` when the engine itself failed — verified against 1.18.2, which
 * emits `rule: 'evaluation'` with `result: error` for a broken expression.
 * Rendering that string in the same slot as `validate-image-tag` presents a
 * rule the policy does not contain, and sends the reader looking for it.
 *
 * So a name is only shown when the policy actually declares it. Otherwise the
 * bucket is described by what it holds.
 */
function ruleHeading(resource: any, rule: PolicyCoverageRule): string | undefined {
  const name = rule.rule
  if (!name) return undefined
  const declared: string[] = (resource?.spec?.rules ?? [])
    .map((r: any) => r?.name)
    .filter(Boolean)
  if (declared.includes(name)) return name
  // Not a rule of this policy. If everything in it is an engine error, say so;
  // anything else keeps the raw name rather than inventing a description.
  const c = rule.counts
  if (c.error > 0 && c.fail === 0 && c.pass === 0 && c.warn === 0 && c.skip === 0) {
    return 'Engine errors'
  }
  return name
}

/** A legacy kyverno.io Policy / ClusterPolicy, as opposed to the modern CEL family. */
function isLegacyKyvernoPolicy(resource: any): boolean {
  return typeof resource?.apiVersion === 'string' && resource.apiVersion.startsWith('kyverno.io/')
}

/** The family a single legacy rule belongs to, read from which block it carries. */
function legacyRuleFamily(rule: any): KyvernoPolicyFamily | undefined {
  if (rule?.generate) return 'generating'
  if (rule?.mutate) return 'mutating'
  if (rule?.verifyImages) return 'imageValidating'
  if (rule?.validate) return 'validating'
  return undefined
}

/**
 * Family for a legacy policy, or for one rule of it.
 *
 * The modern API puts the family in the kind, so `getKyvernoPolicyFamily` is
 * enough there. A legacy ClusterPolicy is one kind carrying any mix of rules,
 * and reading the kind alone returns nothing — which falls back to Pass/Fail and
 * tells the reader a generate rule "failed" when nothing was generated.
 *
 * With no rule name, the answer is the family the whole policy agrees on;
 * a policy mixing families has no single answer and gets the neutral wording.
 */
export function policyFamilyFor(
  resource: any,
  ruleName?: string,
): KyvernoPolicyFamily | undefined {
  if (!isLegacyKyvernoPolicy(resource)) return getKyvernoPolicyFamily(resource?.kind)
  const rules: any[] = resource?.spec?.rules ?? []
  if (rules.length === 0) return undefined
  if (ruleName) {
    // Autogen rules carry the source rule's block, but Kyverno names them
    // `autogen-<rule>` (and `autogen-cronjob-<rule>`), so the report's rule
    // name does not match `spec.rules[].name` verbatim.
    const base = ruleName.replace(/^autogen-(cronjob-)?/, '')
    const rule = rules.find((r) => r?.name === ruleName) ?? rules.find((r) => r?.name === base)
    if (rule) return legacyRuleFamily(rule)
  }
  const families = rules.map(legacyRuleFamily)
  const first = families[0]
  return families.every((f) => f === first) ? first : undefined
}

/**
 * Whether this policy blocks admission today.
 *
 * The two families answer this from different fields and the modern helper reads
 * neither of the legacy ones. A legacy ClusterPolicy carries
 * `spec.validationFailureAction` (or a per-rule `validate.failureAction`), while
 * `getKyvernoEnforcementPosture` looks at `spec.validationActions` — absent on
 * legacy, which makes an Enforce policy read as audit-only and produces the exact
 * inversion this section exists to prevent.
 */
function blocksAdmission(resource: any, family: KyvernoPolicyFamily | undefined): boolean {
  if (isLegacyKyvernoPolicy(resource)) {
    return getKyvernoPolicyAction(resource) === 'Enforce'
  }
  return getKyvernoEnforcementPosture(resource, family).blocks
}

/**
 * Whether the consequence sentence can be stated at all.
 *
 * A legacy ClusterPolicy can carry validate, mutate and generate rules at once,
 * so "what enforcing does" has no single answer. Rather than pick one and be
 * confidently wrong, the sentence is withheld and the counts speak for
 * themselves.
 */
function canStateConsequence(resource: any, family: KyvernoPolicyFamily | undefined): boolean {
  if (!isLegacyKyvernoPolicy(resource)) {
    return family === 'validating' || family === 'imageValidating' || family === undefined
  }
  const rules: any[] = resource?.spec?.rules ?? []
  if (rules.length === 0) return false
  // Every rule has to validate AND agree on whether updates are matched; the
  // sentence is one claim about one failing count and cannot straddle both.
  return rules.every((rule) => !!rule?.validate) && legacyOperationsAgree(resource)
}

/**
 * The sentence an operator acts on, and the one easiest to get wrong.
 *
 * Two plausible phrasings are both false. "Enforcing would block these N" — no,
 * admission acts on requests, and these resources already exist. "Their next
 * update is rejected" — only when the policy matches UPDATE; a CREATE-only
 * policy grandfathers them until something recreates them.
 *
 * Exported for tests: this wording is the feature, so it is pinned rather than
 * asserted through the DOM.
 */
export function enforcementConsequence(
  failing: number,
  blocks: boolean,
  matchesUpdate: boolean,
): string {
  // Deliberately kind-neutral. A policy can match ConfigMaps, Secrets or
  // ClusterRoles as readily as Pods, and none of those "run" — the fact being
  // stated is that the resource already exists, not that it is executing.
  const one = failing === 1
  const exists = one ? '1 resource already exists' : `${failing} resources already exist`
  const it = one ? 'it' : 'them'
  const itIs = one ? 'it is' : 'they are'

  if (blocks) {
    return matchesUpdate
      ? `${exists}, so this policy does not affect ${it} today. The next update to ${one ? 'it' : 'any of them'} will be rejected.`
      : `${exists} and ${one ? 'stays' : 'stay'} as ${itIs} — this policy only checks creation, so ${itIs} rejected only if recreated.`
  }

  // "Set to enforce" is the legacy family's vocabulary; the modern API spells
  // the same thing `validationActions: [Deny]`, and the posture badge above
  // already says "Deny". Describing the behaviour rather than the field keeps
  // one sentence correct for both.
  const target = one ? 'this resource' : `any of these ${failing}`
  return matchesUpdate
    ? `Nothing is rejected today. Switching this policy to block would reject the next update to ${target}.`
    : `Nothing is rejected today. Switching this policy to block would leave ${
        one ? 'this resource as it is' : `these ${failing} as they are`
      } — only newly created resources would be rejected.`
}

export function PolicyCoverageSection({
  resource,
  data,
  loading,
  error,
  onSelectSubject,
  onLoadMore,
  loadingMore,
}: PolicyCoverageSectionProps) {
  if (loading) {
    return (
      <Section title={TITLE} icon={ShieldQuestion}>
        <div className="text-sm text-theme-text-tertiary">Loading policy results…</div>
      </Section>
    )
  }

  if (error) {
    if (isForbiddenError(error)) {
      return (
        <Section title={TITLE} icon={ShieldQuestion}>
          <div className="text-sm text-theme-text-tertiary">
            You don’t have permission to view policy results.
          </div>
        </Section>
      )
    }
    return (
      <Section title={TITLE} icon={ShieldAlert}>
        <div className="text-sm text-red-400">{`Could not load policy results: ${error.message}`}</div>
      </Section>
    )
  }

  if (!data || data.status === 'not_installed') return null

  if (!data.evaluated) {
    return (
      <Section title={TITLE} icon={ShieldQuestion}>
        <div className="text-sm text-theme-text-tertiary">
          {(data.status === 'warmup'
            ? 'Policy results are still loading from the cluster.'
            : 'Policy results are unavailable, so nothing has been checked against this policy.') +
            (data.reasonCode ? ` (${data.reasonCode})` : '')}
        </div>
      </Section>
    )
  }

  const family = policyFamilyFor(resource)
  const words = outcomeWords(family)
  const { counts } = data
  const examined = counts.pass + counts.fail + counts.warn + counts.error + counts.skip

  if (examined === 0) {
    return (
      <Section title={TITLE} icon={ShieldQuestion}>
        <div className="text-sm text-theme-text-tertiary">
          Nothing has been checked against this policy yet.
        </div>
        <ScopeNote data={data} />
      </Section>
    )
  }

  const bad = counts.fail + counts.warn
  return (
    <Section title={TITLE} icon={bad > 0 ? ShieldAlert : ShieldCheck} defaultExpanded={bad > 0}>
      <Headline data={data} words={words} />
      <ForeignEngines data={data} />
      <Consequence resource={resource} data={data} family={family} />
      <div className="mt-3 space-y-3">
        {data.rules.map((rule, i) => (
          <RuleBlock
            key={rule.rule || `unnamed-${i}`}
            rule={rule}
            heading={ruleHeading(resource, rule)}
            onLoadMore={onLoadMore}
            loadingMore={loadingMore}
            // Per rule, because one legacy policy can validate, mutate and
            // generate at once and each means something different by "fail".
            words={outcomeWords(policyFamilyFor(resource, rule.rule))}
            onSelectSubject={onSelectSubject}
          />
        ))}
      </div>
      <ScopeNote data={data} />
    </Section>
  )
}

/**
 * Attribution, when the results did not all come from Kyverno.
 *
 * `results[].policy` is producer-defined and is not guaranteed to name a policy
 * object — Trivy and Falco write their own identifiers into the same field. The
 * lookup keys on that string, so a same-named producer's results would land on
 * this page. Saying nothing would present another engine's findings as this
 * policy's own, which is the mistake the report schema explicitly warns about.
 *
 * Silent in the ordinary case: one engine, and it is the one that owns the page.
 */
function ForeignEngines({ data }: { data: PolicyCoverageResponse }) {
  const engines = (data.engines ?? []).filter((e) => e !== 'kyverno' && e !== 'unknown')
  if (engines.length === 0) return null
  return (
    <div className="mt-2 text-sm text-theme-text-secondary">
      {`Some of these results were written by ${engines.join(', ')}, not by Kyverno — the reports key them under the same name.`}
    </div>
  )
}

/**
 * Scope before numbers. A total the caller cannot actually see is a lie of
 * omission, so the sentence names the ground it covers first.
 */
function Headline({
  data,
  words,
}: {
  data: PolicyCoverageResponse
  words: OutcomeWords
}) {
  const { counts } = data
  const parts: string[] = []
  if (counts.fail > 0) parts.push(`${counts.fail} ${words.bad}`)
  if (counts.warn > 0) parts.push(`${counts.warn} warned`)
  if (counts.pass > 0) parts.push(`${counts.pass} ${words.good}`)
  if (counts.error > 0) parts.push(`${counts.error} could not be evaluated`)
  if (counts.skip > 0) parts.push(`${counts.skip} skipped`)

  const scope =
    data.scopeNamespaces > 0
      ? `Across ${data.scopeNamespaces} ${data.scopeNamespaces === 1 ? 'namespace' : 'namespaces'}${
          data.clusterScoped ? ' and cluster-scoped resources' : ''
        }`
      : data.clusterScoped
        ? 'Across cluster-scoped resources'
        : 'Across the resources you can read'

  // Leading with the examined total bounds the claim: these counts describe what
  // the engine actually looked at, not the cluster.
  const examined = data.examined || 0
  return (
    <div className="text-sm text-theme-text-secondary">
      {scope}, {examined} {examined === 1 ? 'resource' : 'resources'} examined — {parts.join(', ')}.
    </div>
  )
}

/**
 * What enforcing this policy would actually do.
 *
 * Two claims are tempting and both are false: that enforcing blocks the
 * resources already failing (it does not — they are left alone), and that their
 * next update is rejected (only if the policy matches UPDATE). The honest answer
 * depends on the policy's declared operations, which is why this reads the spec
 * rather than the report.
 */
function Consequence({
  resource,
  data,
  family,
}: {
  resource: any
  data: PolicyCoverageResponse
  family: KyvernoPolicyFamily | undefined
}) {
  const lines: string[] = []
  const failing = data.counts.fail

  if (failing > 0 && canStateConsequence(resource, family)) {
    lines.push(
      enforcementConsequence(failing, blocksAdmission(resource, family), matchesUpdates(resource)),
    )
  }

  if (data.counts.error > 0) {
    const failClosed = getKyvernoFailurePolicy(resource) === 'Fail'
    lines.push(
      failClosed
        ? `${data.counts.error} could not be evaluated. This policy fails closed, so those admissions are rejected for an engine error rather than a violation.`
        : `${data.counts.error} could not be evaluated and are being allowed through unchecked.`,
    )
  }

  if (lines.length === 0) return null
  return (
    <div className="mt-2 text-sm text-theme-text-primary space-y-1">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

function RuleBlock({
  rule,
  heading,
  words,
  onSelectSubject,
  onLoadMore,
  loadingMore,
}: {
  rule: PolicyCoverageRule
  /** Undefined when this bucket has no name worth showing. */
  heading?: string
  words: OutcomeWords
  onSelectSubject?: (subject: PolicyCoverageSubject) => void
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  // Passing subjects are collapsed, not discarded: a policy matching every pod
  // in the cluster would bury its failures under a wall of green, but "which
  // resources satisfy this rule" is half the question the view exists to answer
  // and a bare count cannot be clicked, checked, or navigated from.
  const notable = rule.subjects.filter((s) => s.result.toLowerCase() !== 'pass')
  const passingSubjects = rule.subjects.filter((s) => s.result.toLowerCase() === 'pass')
  const passing = rule.counts.pass

  // Same shape as RelationshipGroup: fold at a readable length, then expand in
  // place. The house convention never states a count the reader cannot open.
  const [showAll, setShowAll] = useState(false)
  const folded = !showAll && notable.length > SUBJECT_FOLD_LIMIT
  // Everything the rule flagged, whether or not it survived the server cap.
  const notableTotal = rule.counts.fail + rule.counts.warn + rule.counts.error + rule.counts.skip
  // The cap is only worth mentioning when it removed rows that WOULD have been
  // listed. `rule.truncated` alone is too blunt: a rule where 250 subjects pass
  // and one fails is capped, yet everything listable arrived and the passing
  // count is exact — so a cap notice there implies a gap that does not exist.
  const notableCapped = notable.length < notableTotal
  const visible = folded ? notable.slice(0, SUBJECT_FOLD_LIMIT) : notable

  return (
    <div>
      {heading && (
        <div className="text-xs font-medium text-theme-text-tertiary mb-1">{heading}</div>
      )}
      {notable.length === 0 ? (
        <PassingGroup
          label={`All ${passing} ${passing === 1 ? 'resource' : 'resources'} ${words.good}`}
          subjects={passingSubjects}
          total={passing}
          words={words}
          onSelectSubject={onSelectSubject}
        />
      ) : (
        <div className="space-y-1.5">
          {visible.map((s, i) => (
            <SubjectRow key={`${s.namespace}/${s.kind}/${s.name}/${i}`} subject={s} words={words} onSelect={onSelectSubject} />
          ))}
          {folded && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="px-2 py-0.5 text-xs rounded border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated transition-colors"
            >
              {/* "Show all N" is the house wording, but it is only true when the
                  client holds every subject. Once the server cap has bitten,
                  the button can only offer what arrived. */}
              {notableCapped
                ? `Show ${notable.length} of ${notableTotal}`
                : `Show all ${notable.length}`}
            </button>
          )}
          {passing > 0 && (
            <PassingGroup
              label={`${passing} other ${passing === 1 ? 'resource' : 'resources'} ${words.good}`}
              subjects={passingSubjects}
              total={passing}
              words={words}
              onSelectSubject={onSelectSubject}
            />
          )}
        </div>
      )}
      <RuleFooter
        rule={rule}
        notableCapped={notableCapped}
        onLoadMore={onLoadMore}
        loadingMore={loadingMore}
      />
    </div>
  )
}

/**
 * What is not on screen.
 *
 * The count must describe the rows actually rendered, which is the convention
 * elsewhere (ClusterComplianceReport shows "Showing X of Y" only while a filter
 * is narrowing a visible list). Two mistakes are easy here and both shipped
 * once:
 *
 *  - Announcing truncation when nothing is listed at all. Passing subjects are
 *    summarised rather than listed, so a rule where everything passes renders
 *    zero rows — and "showing the 25 worst of 34" above an empty space is
 *    simply false.
 *  - Counting against the rule's total. The listed rows are only the
 *    non-passing subjects, so the denominator has to be that population, not
 *    every subject the rule examined.
 */
function RuleFooter({
  rule,
  notableCapped,
  onLoadMore,
  loadingMore,
}: {
  rule: PolicyCoverageRule
  /** True when the server cap removed subjects that would have been listed. */
  notableCapped: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  const hidden = rule.hiddenByFilter ?? 0
  // Client-side folding is already announced by the "Show all N" button, which
  // is where the house pattern puts it — repeating it here said the same thing
  // twice. What the button CANNOT say is that the server capped the list, in
  // which case "Show all" would be a promise the client cannot keep.
  if (!notableCapped && hidden === 0) return null
  const parts: string[] = []
  if (notableCapped) {
    parts.push(`only the first ${rule.subjects.length} are available here`)
  }
  if (hidden > 0) {
    parts.push(`${hidden} hidden by your namespace filter`)
  }
  return (
    <div className="flex flex-wrap items-baseline gap-2 pt-1">
      <span className="text-xs text-theme-text-tertiary">{parts.join(', ')}</span>
      {/* The cap is the only part of this the reader can do something about,
          and until there was a way to lift it the sentence was the end of the
          road. */}
      {notableCapped && onLoadMore && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={onLoadMore}
          className="px-2 py-0.5 text-xs rounded border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated transition-colors disabled:opacity-60"
        >
          {loadingMore ? 'Loading…' : 'Load the rest'}
        </button>
      )}
    </div>
  )
}

/**
 * The resources that satisfy the rule.
 *
 * Collapsed by default — a passing list is usually long and rarely the reason
 * someone opened the page — but never reduced to a bare number. "34 passing"
 * with no way to see the 34 answers half the question this view exists for and
 * leaves the reader no route to any of them; the rows are the same clickable
 * subjects the failures use.
 */
function PassingGroup({
  label,
  subjects,
  total,
  words,
  onSelectSubject,
}: {
  label: string
  /** Passing subjects that arrived. May be shorter than `total` if the server capped. */
  subjects: PolicyCoverageSubject[]
  /** Exact passing count, unaffected by the cap. */
  total: number
  words: OutcomeWords
  onSelectSubject?: (subject: PolicyCoverageSubject) => void
}) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Nothing to open: the count is real but the subjects did not survive the
  // server cap, so the label stands alone rather than offering an empty drawer.
  if (subjects.length === 0) {
    return <div className="text-xs text-theme-text-tertiary pt-0.5">{label}</div>
  }

  const folded = !showAll && subjects.length > SUBJECT_FOLD_LIMIT
  const visible = folded ? subjects.slice(0, SUBJECT_FOLD_LIMIT) : subjects
  const capped = subjects.length < total

  return (
    <div className="pt-0.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-theme-text-tertiary hover:text-theme-text-secondary"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {label}
      </button>
      {open && (
        <div className="space-y-1.5 mt-1.5">
          {visible.map((s, i) => (
            <SubjectRow
              key={`${s.namespace}/${s.kind}/${s.name}/${i}`}
              subject={s}
              words={words}
              onSelect={onSelectSubject}
            />
          ))}
          {folded && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="px-2 py-0.5 text-xs rounded border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated transition-colors"
            >
              {capped ? `Show ${subjects.length} of ${total}` : `Show all ${subjects.length}`}
            </button>
          )}
          {capped && !folded && (
            <div className="text-xs text-theme-text-tertiary">
              {`only the first ${subjects.length} are available here`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SubjectRow({
  subject,
  words,
  onSelect,
}: {
  subject: PolicyCoverageSubject
  words: OutcomeWords
  onSelect?: (subject: PolicyCoverageSubject) => void
}) {
  const tone = resultTone(subject.result, words)
  const label = subject.namespace ? `${subject.namespace}/${subject.name}` : subject.name
  const body = (
    <>
      <span className={clsx('badge shrink-0', tone.badge)} title={`Report result: ${subject.result}`}>
        {tone.label}
      </span>
      <div className="min-w-0">
        <div className="text-sm text-theme-text-primary truncate">
          <span className="text-theme-text-tertiary">{subject.kind}</span> {label}
          {subject.autogen && (
            <span
              className="text-theme-text-tertiary"
              title="Matched through a rule Kyverno generated from your Pod rule"
            >
              {' · via controller'}
            </span>
          )}
        </div>
        {subject.message && (
          <div className="text-xs text-theme-text-secondary">{subject.message}</div>
        )}
      </div>
    </>
  )

  if (!onSelect) {
    return <div className="flex items-start gap-2 min-w-0">{body}</div>
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(subject)}
      className="flex items-start gap-2 min-w-0 w-full text-left hover:bg-theme-hover rounded px-1 -mx-1 py-0.5"
    >
      {body}
    </button>
  )
}

/**
 * Three independent ways this answer can be incomplete: report families the
 * caller cannot read, namespaces the caller cannot read, and an index that is no
 * longer updating. Silence on any of them turns a partial view into an implied
 * all-clear.
 */
function ScopeNote({ data }: { data: PolicyCoverageResponse }) {
  const denied = data.deniedGroups ?? []
  const unreadable = data.unreadableFamilies ?? []
  const withheldByFamily = data.withheldByFamily ?? 0
  if (
    denied.length === 0 &&
    unreadable.length === 0 &&
    data.withheldNamespaces === 0 &&
    !data.withheldClusterScoped &&
    data.liveUpdates
  ) {
    return null
  }
  return (
    <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-tertiary space-y-0.5">
      {data.withheldNamespaces > 0 && (
        <div>
          {`${data.withheldNamespaces} ${
            data.withheldNamespaces === 1 ? 'namespace is' : 'namespaces are'
          } not shown because you can’t read policy results there.`}
        </div>
      )}
      {data.withheldClusterScoped && (
        <div>Cluster-scoped results are not shown because you can’t read policy reports at cluster scope.</div>
      )}
      {unreadable.length > 0 && (
        <div>
          {`You can’t read ${unreadable.join(', ')}, so ${withheldByFamily === 1 ? '1 result was' : `${withheldByFamily} results were`} left out of this list.`}
        </div>
      )}
      {denied.length > 0 && (
        <div>{`Some policy results could not be read (${denied.join(', ')}), so this list may be incomplete.`}</div>
      )}
      {!data.liveUpdates && <div>These results are not updating live.</div>}
    </div>
  )
}


/** Internals exposed for tests — family gating is load-bearing and latent
 *  (a legacy Enforce policy with failures is rare in fixtures, common in the
 *  field), so it is pinned directly rather than through the DOM. */
export const __testing = {
  blocksAdmission,
  ruleHeading,
  legacyMatchesUpdates,
  legacyOperationsAgree,
  canStateConsequence,
  isLegacyKyvernoPolicy,
  matchesUpdates,
  policyFamilyFor,
}
