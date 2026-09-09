import React, { useEffect, useMemo, useState } from "react";
import { Button, FormField, InlineAlert, PageHeader, StatusTag, Textarea } from "@hatch/ui";
import { getFactoryReview, submitFactoryReview } from "./creatorFactory.js";
import { createCreatorTranslator } from "./creatorI18n.js";
import { WebLanguagePicker, useWebLocale } from "./WebLocaleProvider.jsx";
import { formatWebDate, webErrorMessage } from "./webI18n.js";
import "./creatorReview.css";

export function CreatorReviewPage({ token, request, runId, onBack, onRevision, onRelease }) {
  const { locale } = useWebLocale();
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [review, setReview] = useState(null);
  const [state, setState] = useState({ loading: true, busy: "", error: "" });
  const [drafts, setDrafts] = useState({});

  async function refresh() {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      setReview(await getFactoryReview(token, runId, request));
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: webErrorMessage(error, locale) }));
    }
  }

  useEffect(() => { refresh(); }, [token, runId, locale]);

  const cases = useMemo(() => [...(review?.cases ?? [])].sort((left, right) => {
    const priority = (item) => item.status === "needs_review" ? 0 : item.status === "judge_disputed" ? 1 : 2;
    return priority(left) - priority(right);
  }), [review]);

  async function act(item, action) {
    const draft = drafts[item.id] ?? {};
    if (action === "correct" && (!draft.correction?.trim() || !draft.why?.trim())) {
      setState((current) => ({ ...current, error: t("correctionDetailsRequired") }));
      return;
    }
    if (action === "judge_dispute" && !draft.why?.trim()) {
      setState((current) => ({ ...current, error: t("evaluationDetailsRequired") }));
      return;
    }
    setState({ loading: false, busy: `${action}:${item.id}`, error: "" });
    try {
      const result = await submitFactoryReview(token, { id: runId, version: review?.version }, {
        action,
        caseId: item.id,
        caseDigest: item.case_digest,
        candidateDigest: review.candidate_digest,
        correction: draft.correction,
        why: draft.why
      }, crypto.randomUUID(), request);
      if (result.next_run && typeof onRevision === "function") {
        onRevision(result.next_run);
        return;
      }
      setReview(result.review ?? review);
      setState({ loading: false, busy: "", error: "" });
    } catch (error) {
      setState({ loading: false, busy: "", error: webErrorMessage(error, locale) });
    }
  }

  async function confirmHeldout() {
    setState({ loading: false, busy: "heldout_correction", error: "" });
    try {
      const result = await submitFactoryReview(token, { id: runId, version: review?.version }, {
        action: "heldout_correction",
        candidateDigest: review.candidate_digest,
        correction: t("heldoutCorrectionText"),
        why: t("heldoutCorrectionWhy")
      }, crypto.randomUUID(), request);
      if (result.next_run && typeof onRevision === "function") onRevision(result.next_run);
    } catch (error) {
      setState({ loading: false, busy: "", error: webErrorMessage(error, locale) });
    }
  }

  if (state.loading && !review) return <div className="creator-review-page"><p>{t("loadingCandidateReview")}</p></div>;
  if (state.error && !review) return <div className="creator-review-page"><InlineAlert tone="error">{state.error}</InlineAlert><Button type="button" onClick={refresh}>{t("retry")}</Button></div>;
  if (!review) return null;

  return <section className="creator-review-page">
    <div className="creator-review-topbar"><Button variant="link" type="button" onClick={onBack}>{t("backToFactory")}</Button><StatusTag tone={review.release_ready ? "success" : "neutral"}>{review.release_ready ? t("readyToRelease") : t("needsReview")}</StatusTag><WebLanguagePicker className="creator-review-language-picker" /></div>
    <PageHeader eyebrow={t("candidateReview")} title={t("candidateReviewTitle", review.candidate_version)} body={t("candidateReviewBody")} />
    {state.error ? <InlineAlert tone="error">{state.error}</InlineAlert> : null}
    <div className="creator-review-summary">
      <Summary label={t("knownCasesReviewed")} value={`${review.cases.filter((item) => item.status !== "needs_review" && item.status !== "judge_disputed").length} / ${review.cases.length}`} />
      <Summary label={t("needsYourReview")} value={String(review.unresolved_count)} />
      <Summary label={t("blindCases")} value={t("blindCasesPassed", review.blind.passed, review.blind.total)} detail={t("questionsAnswersSealed")} />
    </div>
    <CorpusPanel corpus={review.corpus} locale={locale} t={t} />
    {cases.length ? <div className="creator-review-cases">{cases.map((item) => <ReviewCase key={item.id} item={item} draft={drafts[item.id] ?? {}} setDraft={(next) => setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? {}), ...next } }))} busy={state.busy} onAction={act} t={t} />)}</div> : <article className="creator-review-empty"><h2>{t("noKnownCasesYet")}</h2><p>{t("knownCasesWillAppear")}</p></article>}
    <article className="creator-review-blind"><div><span className="creator-review-eyebrow">{t("sealedHeldout")}</span><h2>{review.blind.failed ? t("creatorConfirmationRequired") : t("generalizationCheck")}</h2><p>{review.blind.failed ? t("blindFailureBody", review.blind.failed) : t("blindPassBody", review.blind.passed, review.blind.total)}</p></div><div className="creator-review-actions">{review.blind.needs_creator_action ? <Button type="button" loading={state.busy === "heldout_correction"} disabled={Boolean(state.busy)} onClick={confirmHeldout}>{t("confirmStartCorrection")}</Button> : null}{review.release_ready && onRelease ? <Button type="button" onClick={onRelease}>{t("openReleasePreview")}</Button> : null}</div></article>
  </section>;
}

function CorpusPanel({ corpus, locale, t }) {
  if (!corpus?.available) {
    return <article className="creator-review-corpus creator-review-corpus-unavailable">
      <div><span className="creator-review-eyebrow">{t("fullCorpus")}</span><h2>{t("corpusUnavailable")}</h2><p>{corpus?.reason ?? t("runtimeCorpusUnavailable")}</p></div>
    </article>;
  }
  return <section className="creator-review-corpus">
    <div className="creator-review-corpus-heading"><div><span className="creator-review-eyebrow">{t("fullCorpus")} · {t("candidateVersion", corpus.version)}</span><h2>{t("whatAgentWillReceive")}</h2><p>{t("immutableRuntimeAssets")}</p></div><StatusTag tone="success">{t("verified")}</StatusTag></div>
    <div className="creator-review-corpus-meta"><code>{corpus.digest}</code><span>{corpus.verifiedAt ? t("verifiedAt", formatWebDate(corpus.verifiedAt, locale)) : t("notProvided")}</span></div>
    <div className="creator-review-corpus-assets">{corpus.assets.map((asset) => <article className="creator-review-corpus-asset" key={`${asset.layer}:${asset.path}`}>
      <div className="creator-review-corpus-asset-heading"><div><span className="creator-review-eyebrow">{asset.layer}{asset.kind ? ` · ${asset.kind}` : ""}</span><h3>{asset.id}</h3></div><code>{asset.path}</code></div>
      <pre>{asset.content}</pre>
    </article>)}</div>
    <p className="creator-review-corpus-note">{t("evaluationAssetsSealed")}</p>
  </section>;
}

function ReviewCase({ item, draft, setDraft, busy, onAction, t }) {
  const correcting = Boolean(draft.open);
  const disputing = Boolean(draft.disputeOpen);
  const actionBusy = busy?.endsWith(`:${item.id}`);
  const actionable = item.status === "needs_review";
  const verdictLabel = item.status === "judge_disputed" ? t("evaluationReported") : item.verdict === "PASS" ? t("evaluationPassed") : t("evaluationFailed");
  const decisionLabel = item.status === "accepted"
    ? t("reviewStatus_accepted")
    : item.status === "corrected"
      ? t("reviewStatus_corrected")
      : item.status === "question_rejected"
        ? t("reviewStatus_rejected_question")
        : t("waitingForEvaluationReview");
  return <article className="creator-review-case">
    <div className="creator-review-case-heading"><div><span className="creator-review-eyebrow">{t("knownCase")} · {item.verdict === "FAIL" ? t("evaluationFailed") : t("evaluationPassed")}</span><h2>{item.question}</h2></div><StatusTag tone={item.status === "judge_disputed" ? "neutral" : item.verdict === "FAIL" ? "error" : "success"}>{verdictLabel}</StatusTag></div>
    <div className="creator-review-columns"><div><label>{t("yourReference")}</label><p>{item.creator_reference}</p></div><div><label>{t("candidateOutput")}</label><div className="creator-review-output-scroll" tabIndex="0" aria-label={t("candidateOutputAriaLabel")}>{item.candidate_output}</div></div></div>
    <div className="creator-review-diagnosis"><label>{t("whyHatchMadeCall")}</label><p>{item.diagnosis}</p></div>
    {item.status === "judge_disputed" ? <div className="creator-review-resolution"><StatusTag tone="neutral">{t("waitingForEvaluationReview")}</StatusTag><p>{t("evaluationWrongBody")}</p></div> : !actionable ? <div className="creator-review-resolution"><StatusTag tone="success">{decisionLabel}</StatusTag><p>{t("caseAlreadyHandled")}</p></div> : correcting ? <div className="creator-review-correction"><FormField label={t("whatShouldHatchHaveDone")} required><Textarea value={draft.correction ?? ""} onChange={(event) => setDraft({ correction: event.target.value })} /></FormField><FormField label={t("whyCorrectBehavior")} required><Textarea value={draft.why ?? ""} onChange={(event) => setDraft({ why: event.target.value })} /></FormField><div className="creator-review-actions"><Button type="button" loading={actionBusy} disabled={Boolean(busy)} onClick={() => onAction(item, "correct")}>{t("submitCorrection")}</Button><Button variant="link" type="button" disabled={Boolean(busy)} onClick={() => setDraft({ open: false })}>{t("cancel")}</Button></div></div> : disputing ? <div className="creator-review-correction"><FormField label={t("whatEvaluationGotWrong")} required><Textarea value={draft.why ?? ""} onChange={(event) => setDraft({ why: event.target.value })} /></FormField><div className="creator-review-actions"><Button type="button" loading={actionBusy} disabled={Boolean(busy)} onClick={() => onAction(item, "judge_dispute")}>{t("reportEvaluationIssue")}</Button><Button variant="link" type="button" disabled={Boolean(busy)} onClick={() => setDraft({ disputeOpen: false })}>{t("cancel")}</Button></div></div> : <div className="creator-review-actions"><p className="creator-review-action-hint">{item.verdict === "FAIL" ? t("correctionHint") : t("passHint")}</p>{item.verdict === "PASS" ? <Button type="button" disabled={Boolean(busy)} onClick={() => onAction(item, "accept")}>{t("accept")}</Button> : null}<Button variant={item.verdict === "FAIL" ? "primary" : "secondary"} type="button" disabled={Boolean(busy)} onClick={() => setDraft({ open: true })}>{t("correctThisAnswer")}</Button><Button variant="link" type="button" disabled={Boolean(busy)} onClick={() => setDraft({ disputeOpen: true })}>{t("evaluationIsWrong")}</Button><Button variant="link" type="button" disabled={Boolean(busy)} onClick={() => onAction(item, "reject_question")}>{t("questionIsInvalid")}</Button></div>}
  </article>;
}

function Summary({ label, value, detail }) { return <div><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>; }
