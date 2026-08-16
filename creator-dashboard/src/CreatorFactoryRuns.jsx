import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  FormField,
  InlineAlert,
  NavigationItem,
  PageHeader,
  Spinner,
  StatusTag,
  Textarea
} from "@hatch/ui";
import {
  factoryPollInterval,
  factoryShouldPoll,
  factoryStageLabel,
  getFactoryRun,
  listFactoryRuns,
  reconcileFactoryQuestionBatch,
  retryFactoryRun,
  submitFactoryAnswers
} from "./creatorFactory.js";
import "./creatorFactory.css";

export function CreatorFactoryRuns({ token, initialRunId, onNavigateRun, onReviewCandidate, onCreateProduct }) {
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [answerDraft, setAnswerDraft] = useState({
    runId: "",
    batchId: "",
    questions: [],
    answers: {},
    recovery: null
  });
  const [answerSubmission, setAnswerSubmission] = useState({ batchId: "", id: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshList() {
    const result = await listFactoryRuns(token);
    setRuns(result.runs ?? []);
  }

  async function openRun(runId) {
    const detail = await getFactoryRun(token, runId);
    setSelected(detail);
    setAnswerDraft((current) => reconcileFactoryQuestionBatch(current, detail));
    setAnswerSubmission((current) => {
      const batchId = detail.question_batch_id ?? "";
      if (batchId && current.batchId === batchId) return current;
      return batchId ? { batchId, id: crypto.randomUUID() } : { batchId: "", id: "" };
    });
    await refreshList();
  }

  useEffect(() => {
    let active = true;
    const load = async () => {
      await refreshList();
      if (initialRunId && active) await openRun(initialRunId);
    };
    load().catch((nextError) => { if (active) setError(nextError.message); });
    return () => { active = false; };
  }, [token, initialRunId]);

  useEffect(() => {
    const interval = factoryPollInterval(selected);
    if (!selected || !interval) return undefined;
    const timer = setInterval(() => {
      openRun(selected.id).catch((nextError) => setError(nextError.message));
    }, interval);
    return () => clearInterval(timer);
  }, [selected?.id, selected?.status, selected?.question_batch_id, token]);

  const allAnswered = useMemo(() => (
    (selected?.pending_questions?.length ?? 0) > 0
    && selected.pending_questions.every((question) => answerDraft.answers[question.id]?.trim())
  ), [selected, answerDraft.answers]);

  async function submitAnswers(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const run = await submitFactoryAnswers(token, selected, answerDraft.answers, answerSubmission.id);
      setSelected(run);
      setAnswerDraft((current) => reconcileFactoryQuestionBatch(current, run));
      await refreshList();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError("");
    try {
      setSelected(await retryFactoryRun(token, selected));
      await refreshList();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="factory-page">
      <PageHeader className="factory-page-heading" label="Creator Factory" title="Turn one method into one useful product." body="Hatch builds a candidate, asks for your reference answers, and keeps sealed answers out of every model-visible Corpus context." />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="factory-layout">
        <aside className="factory-runs-panel">
          <div className="factory-panel-title"><h2>Runs</h2><Button type="button" variant="link" size="small" onClick={refreshList}>Refresh</Button></div>
          <div className="factory-run-list">
            {runs.map((run) => (
              <NavigationItem key={run.id} active={selected?.id === run.id} className={selected?.id === run.id ? "selected" : ""} onClick={() => {
                if (typeof onNavigateRun === "function") onNavigateRun(run.id);
                else openRun(run.id).catch((nextError) => setError(nextError.message));
              }}>
                <strong>{run.product_name ?? run.product?.name}</strong>
                <span>{factoryStageLabel(run)}</span>
              </NavigationItem>
            ))}
            {!runs.length ? <p>No Factory runs yet.</p> : null}
          </div>
        </aside>
        <div className="factory-work-panel">
          {selected ? (
            <FactoryRunDetail
              run={selected}
              answers={answerDraft.answers}
              setAnswers={(update) => setAnswerDraft((current) => ({
                ...current,
                answers: typeof update === "function" ? update(current.answers) : update
              }))}
              answerRecovery={answerDraft.recovery}
              onDismissRecovery={() => setAnswerDraft((current) => ({ ...current, recovery: null }))}
              allAnswered={allAnswered}
              busy={busy}
              onSubmit={submitAnswers}
              onRetry={retry}
              onReview={onReviewCandidate ? () => onReviewCandidate(selected) : undefined}
              onNew={() => {
                setSelected(null);
                setAnswerDraft({ runId: "", batchId: "", questions: [], answers: {}, recovery: null });
                onNavigateRun?.(null);
              }}
            />
          ) : <CreateFactoryRun onCreateProduct={onCreateProduct} />}
        </div>
      </div>
    </section>
  );
}

function CreateFactoryRun({ onCreateProduct }) {
  return (
    <div className="factory-create factory-source-redirect">
      <span className="cpv2-kicker">New distillation</span>
      <h2>Create a product first</h2>
      <p>Each Product has its own files. Create the Product, upload local files, then generate a version from that Product.</p>
      <Button type="button" onClick={onCreateProduct}>Create a product</Button>
    </div>
  );
}

function FactoryRunDetail({ run, answers, setAnswers, answerRecovery, onDismissRecovery, allAnswered, busy, onSubmit, onRetry, onReview, onNew }) {
  const [copiedAnswerId, setCopiedAnswerId] = useState("");

  async function copyRecoveredAnswer(entry) {
    try {
      await navigator.clipboard.writeText(entry.answer);
      setCopiedAnswerId(entry.question_id);
    } catch {
      setCopiedAnswerId("unavailable");
    }
  }

  return (
    <div className="factory-detail">
      <div className="factory-detail-heading">
        <div><h2>{run.product_name ?? run.product?.name}</h2></div>
        <StatusTag tone={run.status === "ready" ? "success" : run.status === "needs_attention" ? "error" : "neutral"}>{factoryStageLabel(run)}</StatusTag>
      </div>
      {run.status === "waiting_for_creator" && run.stage !== "review_required" ? (
        <form className="factory-questions" onSubmit={onSubmit}>
          <div><h3>Your reference answers</h3><p>Answer each generated question directly. Hatch—not another synthetic answer—will be judged against these answers.</p></div>
          {answerRecovery ? (
            <aside className="factory-answer-recovery" aria-labelledby="factory-answer-recovery-title">
              <div className="factory-answer-recovery-heading">
                <div>
                  <h4 id="factory-answer-recovery-title">The question batch changed</h4>
                  <p>Your earlier answers were not submitted to the new batch. Copy anything useful; Hatch will never apply it automatically.</p>
                </div>
                <Button type="button" variant="link" size="small" onClick={onDismissRecovery}>Dismiss</Button>
              </div>
              <div className="factory-answer-recovery-list">
                {answerRecovery.entries.map((entry, index) => (
                  <div key={`${entry.question_id}-${index}`}>
                    <strong>{entry.question}</strong>
                    <Textarea readOnly value={entry.answer} aria-label={`Earlier answer ${index + 1}`} />
                    <Button type="button" variant="link" size="small" onClick={() => copyRecoveredAnswer(entry)}>
                      {copiedAnswerId === entry.question_id ? "Copied" : "Copy answer"}
                    </Button>
                  </div>
                ))}
              </div>
              {copiedAnswerId === "unavailable" ? <p role="status">Clipboard access is unavailable. Select the answer text and copy it manually.</p> : null}
            </aside>
          ) : null}
          {run.pending_questions.map((question, index) => (
            <FormField key={question.id} label={`${index + 1}. ${question.kind === "provenance_confirmation" ? "Confirm a source hypothesis · " : ""}${question.question}`}>
              <Textarea value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={question.kind === "provenance_confirmation" ? "Confirm, correct, refine, or reject this hypothesis; add the source if you know it." : "Give the finished deliverable or decisive recommendation you would stand behind."} />
            </FormField>
          ))}
          <Button type="submit" loading={busy} disabled={!allAnswered}>Submit all answers</Button>
        </form>
      ) : null}
      {factoryShouldPoll(run) ? <div className="factory-progress"><Spinner label="Factory run in progress" /><div><h3>Hatch is advancing the graph</h3><p>No monitoring agent is required. The worker will pause here automatically when it needs your answers.</p></div></div> : null}
      {run.status === "ready" ? <div className="factory-ready"><StatusTag tone="success">Passed</StatusTag><div><h3>Candidate v{run.candidate?.version} passed</h3><p>Verified Agent Corpus: <code>{run.candidate?.corpus_digest}</code></p><p>System asset: <code>{run.candidate?.system_digest}</code></p><small>The complete bundle passed the Registry verifier. It has not been published; Creator approval remains separate.</small>{onReview ? <Button type="button" onClick={onReview}>Review candidate</Button> : null}</div></div> : null}
      {run.stage === "review_required" ? <div className="factory-attention"><h3>Creator correction is required</h3><p>The sealed evaluation found a boundary case. Review the known cases and confirm the correction loop; held-out content stays sealed.</p>{onReview ? <Button type="button" onClick={onReview}>Open review</Button> : null}</div> : null}
      {run.status === "needs_attention" ? <div className="factory-attention"><h3>The run needs attention</h3><p>{run.last_error}</p>{run.retryable ? <Button type="button" loading={busy} onClick={onRetry}>Retry the failed stage</Button> : <small>This checkpoint cannot be retried safely. Start a new run after correcting the source or configuration.</small>}</div> : null}
      <Button className="factory-new-run" type="button" variant="link" onClick={onNew}>Start another run</Button>
    </div>
  );
}
