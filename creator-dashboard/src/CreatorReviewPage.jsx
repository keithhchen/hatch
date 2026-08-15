import React, { useEffect, useMemo, useState } from "react";
import { Button, FormField, InlineAlert, PageHeader, StatusTag, Textarea } from "@hatch/ui";
import { getFactoryReview, submitFactoryReview } from "./creatorFactory.js";
import "./creatorReview.css";

export function CreatorReviewPage({ token, request, runId, onBack, onRevision, onRelease }) {
  const [review, setReview] = useState(null);
  const [state, setState] = useState({ loading: true, busy: "", error: "" });
  const [drafts, setDrafts] = useState({});

  async function refresh() {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      setReview(await getFactoryReview(token, runId, request));
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }

  useEffect(() => { refresh(); }, [token, runId]);

  const cases = useMemo(() => (review?.cases ?? []).filter((item) => item.status === "needs_review"), [review]);

  async function act(item, action) {
    const draft = drafts[item.id] ?? {};
    if (action === "correct" && (!draft.correction?.trim() || !draft.why?.trim())) {
      setState((current) => ({ ...current, error: "Correction and why are required." }));
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
      setState({ loading: false, busy: "", error: error.message });
    }
  }

  async function confirmHeldout() {
    setState({ loading: false, busy: "heldout_correction", error: "" });
    try {
      const result = await submitFactoryReview(token, { id: runId, version: review?.version }, {
        action: "heldout_correction",
        candidateDigest: review.candidate_digest,
        correction: "Confirmed sealed failure; incorporate the Creator correction loop before re-evaluating.",
        why: "The sealed case failed and must be promoted only after explicit Creator confirmation."
      }, crypto.randomUUID(), request);
      if (result.next_run && typeof onRevision === "function") onRevision(result.next_run);
    } catch (error) {
      setState({ loading: false, busy: "", error: error.message });
    }
  }

  if (state.loading && !review) return <div className="creator-review-page"><p>Loading candidate review…</p></div>;
  if (state.error && !review) return <div className="creator-review-page"><InlineAlert tone="error">{state.error}</InlineAlert><Button type="button" onClick={refresh}>Retry</Button></div>;
  if (!review) return null;

  return <section className="creator-review-page">
    <div className="creator-review-topbar"><Button variant="link" type="button" onClick={onBack}>Back to Factory</Button><StatusTag tone={review.release_ready ? "success" : "neutral"}>{review.release_ready ? "Ready to release" : "Needs review"}</StatusTag></div>
    <PageHeader eyebrow="Candidate review" title={`Candidate v${review.candidate_version}`} body="Review the behavior against your reference. Evaluation is an assistant; your correction is the authority for this revision." />
    {state.error ? <InlineAlert tone="error">{state.error}</InlineAlert> : null}
    <div className="creator-review-summary">
      <Summary label="Known cases" value={`${review.cases.filter((item) => item.status !== "needs_review").length} / ${review.cases.length}`} />
      <Summary label="Needs your review" value={String(review.unresolved_count)} />
      <Summary label="Blind cases" value={`${review.blind.passed} / ${review.blind.total} passed`} detail="Questions and answers stay sealed." />
    </div>
    {cases.length ? <div className="creator-review-cases">{cases.map((item) => <ReviewCase key={item.id} item={item} draft={drafts[item.id] ?? {}} setDraft={(next) => setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? {}), ...next } }))} busy={state.busy} onAction={act} />)}</div> : <article className="creator-review-empty"><h2>No unresolved known cases</h2><p>All evaluated cases are accepted. The sealed blind summary remains visible without revealing its contents.</p></article>}
    <article className="creator-review-blind"><div><span className="creator-review-eyebrow">Sealed held-out</span><h2>{review.blind.failed ? "Creator confirmation required" : "Generalization check"}</h2><p>{review.blind.failed ? `${review.blind.failed} sealed case(s) failed. The case text, answer, and candidate output stay hidden until you confirm the correction loop.` : `${review.blind.passed} / ${review.blind.total} sealed cases passed. Held-out content is not included in the Corpus.`}</p></div><div className="creator-review-actions">{review.blind.needs_creator_action ? <Button type="button" loading={state.busy === "heldout_correction"} disabled={Boolean(state.busy)} onClick={confirmHeldout}>Confirm and start correction</Button> : null}{review.release_ready && onRelease ? <Button type="button" onClick={onRelease}>Open Release preview</Button> : null}</div></article>
  </section>;
}

function ReviewCase({ item, draft, setDraft, busy, onAction }) {
  const correcting = Boolean(draft.open);
  const actionBusy = busy?.endsWith(`:${item.id}`);
  return <article className="creator-review-case">
    <div className="creator-review-case-heading"><div><span className="creator-review-eyebrow">Known case · {item.verdict === "FAIL" ? "Eval failed" : "Eval passed"}</span><h2>{item.question}</h2></div><StatusTag tone={item.verdict === "FAIL" ? "error" : "success"}>{item.verdict}</StatusTag></div>
    <div className="creator-review-columns"><div><label>Your reference</label><p>{item.creator_reference}</p></div><div><label>Candidate output</label><p>{item.candidate_output}</p></div></div>
    <div className="creator-review-diagnosis"><label>Eval diagnosis</label><p>{item.diagnosis}</p></div>
    {correcting ? <div className="creator-review-correction"><FormField label="What should the Agent have done?" required><Textarea value={draft.correction ?? ""} onChange={(event) => setDraft({ correction: event.target.value })} /></FormField><FormField label="Why is this the correct behavior?" required><Textarea value={draft.why ?? ""} onChange={(event) => setDraft({ why: event.target.value })} /></FormField><div className="creator-review-actions"><Button type="button" loading={actionBusy} disabled={Boolean(busy)} onClick={() => onAction(item, "correct")}>Submit correction</Button><Button variant="link" type="button" disabled={Boolean(busy)} onClick={() => setDraft({ open: false })}>Cancel</Button></div></div> : <div className="creator-review-actions"><Button type="button" disabled={Boolean(busy) || item.verdict === "FAIL"} onClick={() => onAction(item, "accept")}>Accept</Button><Button variant="secondary" type="button" disabled={Boolean(busy)} onClick={() => setDraft({ open: true })}>Correct this answer</Button><Button variant="link" type="button" disabled={Boolean(busy)} onClick={() => onAction(item, "reject_question")}>Reject this question</Button></div>}
  </article>;
}

function Summary({ label, value, detail }) { return <div><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>; }
