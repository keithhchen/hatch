import React, { useEffect, useMemo, useState } from "react";
import {
  createFactoryRun,
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

const EMPTY_DRAFT = {
  taskName: "",
  taskBrief: "",
  sources: [{ id: "S1", title: "", authority: "private_material", content: "" }]
};

export function CreatorFactoryRuns({ token, initialRunId, onNavigateRun, onReviewCandidate }) {
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
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

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const run = await createFactoryRun(token, {
        task_name: draft.taskName,
        task_brief: draft.taskBrief,
        sources: draft.sources
      });
      setDraft(EMPTY_DRAFT);
      if (typeof onNavigateRun === "function") onNavigateRun(run.id);
      else await openRun(run.id);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

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
      <header className="page-heading">
        <span className="eyebrow">Creator Factory</span>
        <h1>Turn one method into one working task.</h1>
        <p>Hatch builds a candidate, asks for your reference answers, and keeps sealed answers out of every model-visible Corpus context.</p>
      </header>
      {error ? <div className="notice" role="alert">{error}</div> : null}
      <div className="factory-layout">
        <aside className="factory-runs-panel">
          <div className="factory-panel-title"><h2>Runs</h2><button onClick={refreshList}>Refresh</button></div>
          <div className="factory-run-list">
            {runs.map((run) => (
              <button key={run.id} className={selected?.id === run.id ? "selected" : ""} aria-current={selected?.id === run.id ? "page" : undefined} onClick={() => {
                if (typeof onNavigateRun === "function") onNavigateRun(run.id);
                else openRun(run.id).catch((nextError) => setError(nextError.message));
              }}>
                <strong>{run.task_name}</strong>
                <span>{factoryStageLabel(run)}</span>
              </button>
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
          ) : <CreateFactoryRun draft={draft} setDraft={setDraft} busy={busy} onSubmit={create} />}
        </div>
      </div>
    </section>
  );
}

function CreateFactoryRun({ draft, setDraft, busy, onSubmit }) {
  const update = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  const updateSource = (index, field) => (event) => setDraft((current) => ({
    ...current,
    sources: current.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, [field]: event.target.value } : source)
  }));
  const addSource = () => setDraft((current) => ({
    ...current,
    sources: [...current.sources, { id: `S${current.sources.length + 1}`, title: "", authority: "private_material", content: "" }]
  }));
  const removeSource = (index) => setDraft((current) => ({
    ...current,
    sources: current.sources.filter((_, sourceIndex) => sourceIndex !== index).map((source, sourceIndex) => ({ ...source, id: `S${sourceIndex + 1}` }))
  }));
  return (
    <form className="factory-create" onSubmit={onSubmit}>
      <span className="eyebrow">New run</span>
      <h2>Define one Task</h2>
      <p>The unit is one Creator × one deliverable—not a general digital twin.</p>
      <label>Task name<input required value={draft.taskName} onChange={update("taskName")} placeholder="e.g. Publishable offer critique" /></label>
      <label>Task promise<textarea required value={draft.taskBrief} onChange={update("taskBrief")} placeholder="What does the customer submit, what finished result do they receive, and what tradeoff matters?" /></label>
      <div className="factory-source-heading"><h3>Authorized sources</h3><button type="button" onClick={addSource}>+ Add source</button></div>
      {draft.sources.map((source, index) => <fieldset className="factory-source" key={source.id}>
        <legend>{source.id}</legend>
        {draft.sources.length > 1 ? <button className="factory-remove-source" type="button" onClick={() => removeSource(index)}>Remove</button> : null}
        <label>Source title<input required value={source.title} onChange={updateSource(index, "title")} /></label>
        <label>Authority<select value={source.authority} onChange={updateSource(index, "authority")}><option value="creator_current">Current correction or demonstration</option><option value="creator_example">Canonical example</option><option value="private_material">Private course or document</option><option value="public_context">Public context</option></select></label>
        <label>Source content<textarea className="source-content" required value={source.content} onChange={updateSource(index, "content")} /></label>
      </fieldset>)}
      <button className="primary" disabled={busy}>{busy ? "Creating…" : "Start distillation"}</button>
    </form>
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
        <div><span className="eyebrow">{run.status}</span><h2>{run.task_name}</h2></div>
        <span className={`factory-stage ${run.status}`}>{factoryStageLabel(run)}</span>
      </div>
      {run.status === "waiting_for_creator" ? (
        <form className="factory-questions" onSubmit={onSubmit}>
          <div><h3>Your reference answers</h3><p>Answer each generated task directly. Hatch—not another synthetic answer—will be judged against these answers.</p></div>
          {answerRecovery ? (
            <aside className="factory-answer-recovery" aria-labelledby="factory-answer-recovery-title">
              <div className="factory-answer-recovery-heading">
                <div>
                  <h4 id="factory-answer-recovery-title">The question batch changed</h4>
                  <p>Your earlier answers were not submitted to the new batch. Copy anything useful; Hatch will never apply it automatically.</p>
                </div>
                <button type="button" onClick={onDismissRecovery}>Dismiss</button>
              </div>
              <div className="factory-answer-recovery-list">
                {answerRecovery.entries.map((entry, index) => (
                  <div key={`${entry.question_id}-${index}`}>
                    <strong>{entry.question}</strong>
                    <textarea readOnly value={entry.answer} aria-label={`Earlier answer ${index + 1}`} />
                    <button type="button" onClick={() => copyRecoveredAnswer(entry)}>
                      {copiedAnswerId === entry.question_id ? "Copied" : "Copy answer"}
                    </button>
                  </div>
                ))}
              </div>
              {copiedAnswerId === "unavailable" ? <p role="status">Clipboard access is unavailable. Select the answer text and copy it manually.</p> : null}
            </aside>
          ) : null}
          {run.pending_questions.map((question, index) => (
            <label key={question.id}>
              <span>{index + 1}. {question.question}</span>
              <textarea value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Give the finished deliverable or decisive recommendation you would stand behind." />
            </label>
          ))}
          <button className="primary" disabled={busy || !allAnswered}>{busy ? "Submitting…" : "Submit all answers"}</button>
        </form>
      ) : null}
      {factoryShouldPoll(run) ? <div className="factory-progress"><span className="factory-spinner" /><div><h3>Hatch is advancing the graph</h3><p>No monitoring agent is required. The worker will pause here automatically when it needs your answers.</p></div></div> : null}
      {run.status === "ready" ? <div className="factory-ready"><span>✓</span><div><h3>Candidate v{run.candidate?.version} passed</h3><p>Verified Agent Corpus: <code>{run.candidate?.corpus_digest}</code></p><p>System asset: <code>{run.candidate?.system_digest}</code></p><small>The complete bundle passed the Registry verifier. It has not been published; Creator approval remains separate.</small>{onReview ? <button className="primary" type="button" onClick={onReview}>Review candidate</button> : null}</div></div> : null}
      {run.status === "needs_attention" ? <div className="factory-attention"><h3>The run needs attention</h3><p>{run.last_error}</p>{run.retryable ? <button className="primary" disabled={busy} onClick={onRetry}>Retry the failed stage</button> : <small>This checkpoint cannot be retried safely. Start a new run after correcting the source or configuration.</small>}</div> : null}
      <button className="factory-new-run" onClick={onNew}>Start another run</button>
    </div>
  );
}
