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
import { createCreatorTranslator } from "./creatorI18n.js";
import { WebLanguagePicker, useWebLocale } from "./WebLocaleProvider.jsx";
import { webErrorMessage } from "./webI18n.js";
import "./creatorFactory.css";

export function CreatorFactoryRuns({ token, initialRunId, onNavigateRun, onReviewCandidate, onCreateProduct }) {
  const { locale } = useWebLocale();
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
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
    load().catch((nextError) => { if (active) setError(webErrorMessage(nextError, locale)); });
    return () => { active = false; };
  }, [token, initialRunId, locale]);

  useEffect(() => {
    const interval = factoryPollInterval(selected);
    if (!selected || !interval) return undefined;
    const timer = setInterval(() => {
      openRun(selected.id).catch((nextError) => setError(webErrorMessage(nextError, locale)));
    }, interval);
    return () => clearInterval(timer);
  }, [selected?.id, selected?.status, selected?.question_batch_id, token, locale]);

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
      setError(webErrorMessage(nextError, locale));
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
      setError(webErrorMessage(nextError, locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="factory-page">
      <WebLanguagePicker className="factory-page__language-picker" />
      <PageHeader className="factory-page-heading" label={t("factoryLabel")} title={t("factoryTitle")} body={t("factoryBody")} />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="factory-layout">
        <aside className="factory-runs-panel">
          <div className="factory-panel-title"><h2>{t("factoryRuns")}</h2><Button type="button" variant="link" size="small" onClick={refreshList}>{t("refresh")}</Button></div>
          <div className="factory-run-list">
            {runs.map((run) => (
              <NavigationItem key={run.id} active={selected?.id === run.id} className={selected?.id === run.id ? "selected" : ""} onClick={() => {
                if (typeof onNavigateRun === "function") onNavigateRun(run.id);
                else openRun(run.id).catch((nextError) => setError(webErrorMessage(nextError, locale)));
              }}>
                <strong>{run.product_name ?? run.product?.name}</strong>
                <span>{factoryStageLabel(run, t)}</span>
              </NavigationItem>
            ))}
            {!runs.length ? <p>{t("noFactoryRuns")}</p> : null}
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
              t={t}
            />
          ) : <CreateFactoryRun onCreateProduct={onCreateProduct} t={t} />}
        </div>
      </div>
    </section>
  );
}

function CreateFactoryRun({ onCreateProduct, t }) {
  return (
    <div className="factory-create factory-source-redirect">
      <span className="cpv2-kicker">{t("newDistillation")}</span>
      <h2>{t("createProductFirst")}</h2>
      <p>{t("createProductFirstBody")}</p>
      <Button type="button" onClick={onCreateProduct}>{t("createProduct")}</Button>
    </div>
  );
}

function FactoryRunDetail({ run, answers, setAnswers, answerRecovery, onDismissRecovery, allAnswered, busy, onSubmit, onRetry, onReview, onNew, t }) {
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
        <StatusTag tone={run.status === "ready" ? "success" : run.status === "needs_attention" ? "error" : "neutral"}>{factoryStageLabel(run, t)}</StatusTag>
      </div>
      {run.status === "waiting_for_creator" && run.stage !== "review_required" ? (
        <form className="factory-questions" onSubmit={onSubmit}>
          <div><h3>{t("referenceAnswers")}</h3><p>{t("referenceAnswersBody")}</p></div>
          {answerRecovery ? (
            <aside className="factory-answer-recovery" aria-labelledby="factory-answer-recovery-title">
              <div className="factory-answer-recovery-heading">
                <div>
                  <h4 id="factory-answer-recovery-title">{t("questionBatchChanged")}</h4>
                  <p>{t("questionBatchChangedBody")}</p>
                </div>
                <Button type="button" variant="link" size="small" onClick={onDismissRecovery}>{t("dismiss")}</Button>
              </div>
              <div className="factory-answer-recovery-list">
                {answerRecovery.entries.map((entry, index) => (
                  <div key={`${entry.question_id}-${index}`}>
                    <strong>{entry.question}</strong>
                    <Textarea readOnly value={entry.answer} aria-label={t("earlierAnswer", index + 1)} />
                    <Button type="button" variant="link" size="small" onClick={() => copyRecoveredAnswer(entry)}>
                      {copiedAnswerId === entry.question_id ? t("copied") : t("copyAnswer")}
                    </Button>
                  </div>
                ))}
              </div>
              {copiedAnswerId === "unavailable" ? <p role="status">{t("clipboardUnavailable")}</p> : null}
            </aside>
          ) : null}
          {run.pending_questions.map((question, index) => (
            <FormField key={question.id} label={t("questionLabel", index + 1, question.kind === "provenance_confirmation" ? t("confirmSourceHypothesis") : "", question.question)}>
              <Textarea value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={question.kind === "provenance_confirmation" ? t("sourceHypothesisPlaceholder") : t("deliverablePlaceholder")} />
            </FormField>
          ))}
          <Button type="submit" loading={busy} disabled={!allAnswered}>{t("submitAllAnswers")}</Button>
        </form>
      ) : null}
      {factoryShouldPoll(run) ? <div className="factory-progress"><Spinner label={t("factoryRunInProgress")} /><div><h3>{t("hatchAdvancingGraph")}</h3><p>{t("noMonitoringAgent")}</p></div></div> : null}
      {run.status === "ready" ? <div className="factory-ready"><StatusTag tone="success">{t("passed")}</StatusTag><div><h3>{t("candidateVersionPassed", run.candidate?.version)}</h3><p>{t("verifiedAgentCorpus")}: <code>{run.candidate?.corpus_digest}</code></p><p>{t("systemAsset")}: <code>{run.candidate?.system_digest}</code></p><small>{t("bundlePassedNotPublished")}</small>{onReview ? <Button type="button" onClick={onReview}>{t("reviewCandidate")}</Button> : null}</div></div> : null}
      {run.stage === "review_required" ? <div className="factory-attention"><h3>{t("creatorCorrectionRequired")}</h3><p>{t("sealedEvaluationBoundary")} {t("reviewKnownCases")}</p>{onReview ? <Button type="button" onClick={onReview}>{t("openReview")}</Button> : null}</div> : null}
      {run.status === "needs_attention" ? <div className="factory-attention"><h3>{t("factoryStageNeedsAttention")}</h3><p>{run.last_error}</p>{run.retryable ? <Button type="button" loading={busy} onClick={onRetry}>{t("retryFailedStage")}</Button> : <small>{t("checkpointCannotRetry")}</small>}</div> : null}
      <Button className="factory-new-run" type="button" variant="link" onClick={onNew}>{t("startAnotherRun")}</Button>
    </div>
  );
}
