import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, FormField, InlineAlert, Input, PageHeader, Skeleton, StatusTag, Textarea } from "@hatch/ui";
import {
  getDistillationTask,
  getFactoryRun,
  getFactoryReview,
  listSourceDocuments,
  listFactoryRuns,
  retryFactoryRun,
  saveFactoryAnswerDraft,
  startFactoryRunFromSources,
  submitFactoryAnswers,
  submitFactoryReview,
  updateTaskBrief,
  uploadSourceDocument
} from "./creatorFactory.js";
import { createCreatorTranslator } from "./creatorI18n.js";
import "./creatorProductWorkspace.css";

const TAB_KEYS = ["files", "about-you", "review", "complete"];

export function CreatorProductWorkspace({ token, request, productId, tab = "files", navigate, locale = "en" }) {
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [product, setProduct] = useState(null);
  const [task, setTask] = useState(null);
  const [runs, setRuns] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [run, setRun] = useState(null);
  const [review, setReview] = useState(null);
  const [state, setState] = useState({ loading: true, busy: "", error: "", notice: "" });
  const [selectedTab, setSelectedTab] = useState(TAB_KEYS.includes(tab) ? tab : "files");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [promiseDraft, setPromiseDraft] = useState("");

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const productResponse = await request(`/v1/creator/products/${encodeURIComponent(productId)}`, { token });
      const nextProduct = productResponse?.product ?? productResponse;
      const taskId = nextProduct?.task_id;
      const [nextTask, nextRuns] = await Promise.all([
        taskId ? getDistillationTask(token, taskId) : Promise.resolve(null),
        listFactoryRuns(token)
      ]);
      const productRuns = (nextRuns.runs ?? []).filter((item) => (
        item.product_id === productId || item.product?.id === productId || (taskId && item.task_id === taskId)
      ));
      const sortedRuns = [...productRuns].sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
      const nextRunId = selectedRunId && sortedRuns.some((item) => item.id === selectedRunId)
        ? selectedRunId
        : sortedRuns[0]?.id ?? "";
      const nextRun = nextRunId ? await getFactoryRun(token, nextRunId) : null;
      const nextDocuments = taskId ? await listSourceDocuments(token, taskId) : { documents: [] };
      let nextReview = null;
      if (nextRunId && (nextRun?.candidate || nextRun?.status === "ready" || nextRun?.stage === "review_required")) {
        try { nextReview = await getFactoryReview(token, nextRunId, request); } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
        }
      }
      setProduct(nextProduct);
      setTask(nextTask);
      setPromiseDraft(nextTask?.brief ?? nextProduct?.promise ?? nextProduct?.description ?? "");
      setRuns(sortedRuns);
      setSelectedRunId(nextRunId);
      setRun(nextRun);
      setDocuments(nextDocuments.documents ?? []);
      setReview(nextReview);
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [productId, request, selectedRunId, token]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setSelectedTab(TAB_KEYS.includes(tab) ? tab : "files"); }, [tab]);

  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return undefined;
    const timer = setInterval(() => {
      getFactoryRun(token, run.id).then(setRun).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [run?.id, run?.status, token]);

  function goTab(nextTab) {
    setSelectedTab(nextTab);
    navigate(`/studio/products/${encodeURIComponent(productId)}/${nextTab}`);
  }

  async function selectRun(nextRunId) {
    setSelectedRunId(nextRunId);
    setState((current) => ({ ...current, busy: "select-run", error: "" }));
    try {
      const nextRun = await getFactoryRun(token, nextRunId);
      setRun(nextRun);
      if (nextRun.candidate || nextRun.status === "ready" || nextRun.stage === "review_required") {
        setReview(await getFactoryReview(token, nextRunId, request));
      } else setReview(null);
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setState((current) => ({ ...current, busy: "" })); }
  }

  async function upload(files) {
    if (!task || !files?.length) return;
    setState((current) => ({ ...current, busy: "upload", error: "", notice: "" }));
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await uploadSourceDocument(token, task.id, file));
      setDocuments((current) => [...uploaded, ...current]);
      setState((current) => ({ ...current, notice: t("filesReady", uploaded.length) }));
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setState((current) => ({ ...current, busy: "" })); }
  }

  async function startRun() {
    if (!task || !documents.length || state.busy) return;
    setState((current) => ({ ...current, busy: "start", error: "", notice: "" }));
    try {
      const created = await startFactoryRunFromSources(token, task, documents.map((item) => item.id));
      const nextRun = await getFactoryRun(token, created.id);
      setRun(nextRun);
      setSelectedRunId(nextRun.id);
      setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]);
      goTab("about-you");
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setState((current) => ({ ...current, busy: "" })); }
  }

  if (state.loading && !product) return <section className="cpv2-loading" aria-busy="true"><Skeleton lines={5} /></section>;
  if (state.error && !product) return <section className="cpv2-workspace-error"><InlineAlert tone="error">{state.error}</InlineAlert><Button type="button" onClick={() => void refresh()}>Retry</Button></section>;

  return <section className="cpv2-product-workspace">
    <div className="cpv2-workspace-topline"><button type="button" className="cpv2-back-link" onClick={() => navigate("/studio/products")}>Products</button><div className="cpv2-version-browser"><label htmlFor="workspace-version">Browse</label><select id="workspace-version" value={selectedRunId} onChange={(event) => void selectRun(event.target.value)} disabled={!runs.length || state.busy === "select-run"}><option value="">Current version</option>{runs.map((item) => <option key={item.id} value={item.id}>{`Version ${item.revision_number ?? "—"} · ${versionStatus(item)}`}</option>)}</select></div></div>
    <PageHeader className="cpv2-workspace-header" label={product?.status === "published" ? t("published") : t("product")} title={product?.name ?? task?.name ?? t("product")} body={task?.brief ?? product?.promise ?? product?.description ?? ""} />
    {task ? <ProductPromiseForm t={t} token={token} task={task} value={promiseDraft} onChange={setPromiseDraft} onSaved={(nextTask) => { setTask(nextTask); setPromiseDraft(nextTask.brief); setState((current) => ({ ...current, notice: t("productPromiseSaved") })); }} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    <div className="cpv2-workspace-tabs" role="tablist" aria-label="Product workflow">{TAB_KEYS.map((key) => <button key={key} type="button" role="tab" aria-selected={selectedTab === key} className={selectedTab === key ? "is-active" : ""} onClick={() => goTab(key)}>{t(key === "about-you" ? "aboutYou" : key)}</button>)}</div>
    {state.error ? <InlineAlert tone="error">{state.error}</InlineAlert> : null}
    {state.notice ? <InlineAlert tone="success">{state.notice}</InlineAlert> : null}
    {selectedTab === "files" ? <FilesPanel t={t} task={task} documents={documents} busy={state.busy} onUpload={upload} onStart={startRun} hasRun={Boolean(run)} /> : null}
    {selectedTab === "about-you" ? <AboutYouPanel t={t} token={token} run={run} busy={state.busy} onSaved={(nextRun) => { setRun(nextRun); if (nextRun.status === "queued") setState((current) => ({ ...current, notice: t("waiting") })); }} onFinish={(nextRun) => { setRun(nextRun); goTab("review"); }} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    {selectedTab === "review" ? <ReviewPanel t={t} token={token} run={run} review={review} busy={state.busy} setBusy={(busy) => setState((current) => ({ ...current, busy }))} onReviewChanged={setReview} onRerun={(nextRun) => { setRun(nextRun); setReview(null); setSelectedRunId(nextRun.id); goTab("about-you"); }} onComplete={() => goTab("complete")} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    {selectedTab === "complete" ? <CompletePanel t={t} product={product} run={run} review={review} busy={state.busy} setBusy={(busy) => setState((current) => ({ ...current, busy }))} onRerun={(nextRun) => { setRun(nextRun); setReview(null); setSelectedRunId(nextRun.id); goTab("about-you"); }} onPublished={() => void refresh()} onReview={() => goTab("review")} request={request} token={token} productId={productId} /> : null}
  </section>;
}

function FilesPanel({ t, task, documents, busy, onUpload, onStart, hasRun }) {
  return <section className="cpv2-workspace-panel">
    <div className="cpv2-panel-heading"><div><h2>{t("giveMaterial")}</h2><p>{t("localFilesOnly")}</p></div><label className="cpv2-upload-button">{t("uploadFiles")}<input type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.html,.htm,.png,.jpg,.jpeg,.webp" onChange={(event) => { void onUpload([...event.target.files]); event.target.value = ""; }} disabled={Boolean(busy)} /></label></div>
    <div className="cpv2-file-list">{documents.map((document) => <div className="cpv2-file-row" key={document.id}><div><strong>{document.display_name}</strong><small>{document.projection?.kind === "image" ? t("imageNative") : t("markdownProjection")}</small></div><StatusTag tone="success">{t("ready")}</StatusTag></div>)}</div>
    {!documents.length ? <p className="cpv2-empty-inline">{t("uploadForProduct")}</p> : null}
    <p className="cpv2-source-note">PDF, DOCX, XLSX, CSV, TXT, Markdown, JSON and HTML become Markdown. Images stay native for Kimi K2.6.</p>
    <div className="cpv2-workspace-actions"><Button type="button" loading={busy === "start"} disabled={!documents.length || Boolean(busy)} onClick={onStart}>{hasRun ? t("continueWithFiles") : t("startDistillation")}</Button></div>
  </section>;
}

function ProductPromiseForm({ t, token, task, value, onChange, onSaved, onError }) {
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      onSaved(await updateTaskBrief(token, task, value));
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Unable to save the product promise"));
    } finally {
      setBusy(false);
    }
  }
  return <form className="cpv2-product-promise" onSubmit={save}><FormField label={t("whatProductDelivers")}><Textarea value={value} onChange={(event) => onChange(event.target.value)} /></FormField><Button type="submit" loading={busy} disabled={!value.trim() || value.trim() === task.brief.trim()}>{t("saveProductPromise")}</Button></form>;
}

function AboutYouPanel({ t, token, run, busy, onSaved, onFinish, onError }) {
  const questions = run?.pending_questions ?? [];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [saveState, setSaveState] = useState("");

  useEffect(() => {
    const next = Object.fromEntries((run?.answer_drafts ?? []).map((item) => [item.question_id, item.answer]));
    setAnswers((current) => ({ ...next, ...current }));
    setIndex((current) => Math.min(current, Math.max(questions.length - 1, 0)));
  }, [run?.id, run?.question_batch_id]);

  async function save(nextIndex) {
    if (!run || !questions.length) return;
    setSaveState("saving");
    try {
      const saved = await saveFactoryAnswerDraft(token, run, answers);
      onSaved(saved);
      setSaveState("saved");
      if (nextIndex >= questions.length) {
        const completed = await submitFactoryAnswers(token, saved, answers);
        onFinish(completed);
      } else setIndex(nextIndex);
    } catch (error) {
      setSaveState("");
      onError?.(error instanceof Error ? error : new Error("Unable to save this answer"));
    }
  }

  if (!run) return <section className="cpv2-workspace-panel"><h2>{t("aboutYou")}</h2><p>{t("noRun")}</p></section>;
  if (run.status === "needs_attention") return <section className="cpv2-workspace-panel"><h2>{t("aboutYou")}</h2><p>{run.last_error}</p></section>;
  if (!questions.length) return <section className="cpv2-workspace-panel"><h2>{t("aboutYou")}</h2><p>{["queued", "running"].includes(run.status) ? t("waiting") : t("noQuestions")}</p></section>;
  const question = questions[index];
  const answer = answers[question.id] ?? "";
  const canAdvance = answer.trim().length > 0;
  return <section className="cpv2-workspace-panel cpv2-about-panel"><div className="cpv2-panel-heading"><div><h2>{t("helpUnderstand")}</h2><p>{t("questionOf", index + 1, questions.length)}</p></div><div className="cpv2-carousel-nav"><button type="button" disabled={index === 0} onClick={() => setIndex((current) => current - 1)}>←</button><button type="button" disabled={index === questions.length - 1} onClick={() => setIndex((current) => current + 1)}>→</button></div></div><div className="cpv2-about-question"><h3>{question.question}</h3><div className="cpv2-about-columns"><article><span>{t("sourceEvidence")}</span><h4>{t("whatHatchFound")}</h4><p>{question.intent ?? ""}</p></article><article className="is-answer"><FormField label={t("yourContext")}><Textarea value={answer} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={t("addContext")} /></FormField></article></div><div className="cpv2-workspace-actions"><Button type="button" loading={saveState === "saving" || busy === "answer"} disabled={!canAdvance || Boolean(busy)} onClick={() => { void save(index + 1); }}>{index === questions.length - 1 ? t("finishAndReview") : t("saveAndNext")}</Button>{saveState === "saved" ? <span className="cpv2-save-status">{t("saved")}</span> : null}</div></div></section>;
}

function ReviewPanel({ t, token, run, review, busy, setBusy, onReviewChanged, onRerun, onComplete, onError }) {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState({});
  const cases = review?.cases ?? [];
  useEffect(() => setIndex((current) => Math.min(current, Math.max(cases.length - 1, 0))), [cases.length]);
  if (!run || !review) return <section className="cpv2-workspace-panel"><h2>{t("review")}</h2><p>{run?.status === "needs_attention" ? run.last_error : t("waiting")}</p></section>;
  const item = cases[index];
  if (!item) return <section className="cpv2-workspace-panel"><h2>{t("review")}</h2><p>{t("noQuestions")}</p></section>;
  const currentDraft = draft[item.id] ?? {};
  const handled = item.status !== "needs_review";
  async function action(action) {
    if (action === "correct" && (!currentDraft.correction?.trim() || !currentDraft.why?.trim())) return;
    setBusy(`review:${item.id}`);
    try {
      const result = await submitFactoryReview(token, { id: run.id, version: review.version }, {
        action,
        caseId: item.id,
        caseDigest: item.case_digest,
        candidateDigest: review.candidate_digest,
        correction: currentDraft.correction,
        why: currentDraft.why
      });
      onReviewChanged(result.review ?? review);
      setDraft((current) => ({ ...current, [item.id]: {} }));
      if (index < cases.length - 1) setIndex((current) => current + 1);
    } catch (error) { onError?.(error instanceof Error ? error : new Error("Unable to save this review")); }
    finally { setBusy(""); }
  }
  return <section className="cpv2-workspace-panel cpv2-review-panel"><div className="cpv2-panel-heading"><div><h2>{t("reviewResult")}</h2><p>{index + 1} / {cases.length}</p></div><div className="cpv2-carousel-nav"><button type="button" disabled={index === 0} onClick={() => setIndex((current) => current - 1)}>←</button><button type="button" disabled={index === cases.length - 1} onClick={() => setIndex((current) => current + 1)}>→</button></div></div><div className="cpv2-review-case"><div className="cpv2-review-columns"><article className="cpv2-user-situation"><span>{t("userSituation")}</span><p>{item.question}</p></article><article className="cpv2-your-method"><span>{t("yourMethod")}</span><p>{item.creator_reference}</p></article></div><article className="cpv2-current-response"><span>{t("currentResponse")}</span><div>{item.candidate_output}</div></article><div className={`cpv2-eval-note ${item.verdict === "PASS" ? "is-pass" : "is-fail"}`}><strong>{item.verdict === "PASS" ? "Evaluation passed" : "Evaluation failed"}</strong><p>{item.diagnosis}</p></div>{handled ? <StatusTag tone={item.status === "judge_disputed" ? "neutral" : "success"}>{item.status}</StatusTag> : currentDraft.open ? <div className="cpv2-correction-form"><FormField label="What should Hatch have done?" required><Textarea value={currentDraft.correction ?? ""} onChange={(event) => setDraft((current) => ({ ...current, [item.id]: { ...current[item.id], correction: event.target.value } }))} /></FormField><FormField label="Why?" required><Textarea value={currentDraft.why ?? ""} onChange={(event) => setDraft((current) => ({ ...current, [item.id]: { ...current[item.id], why: event.target.value } }))} /></FormField><Button type="button" loading={busy === `review:${item.id}`} onClick={() => void action("correct")}>{t("saveAndNext")}</Button></div> : <div className="cpv2-review-actions"><Button type="button" className="is-success" disabled={Boolean(busy)} onClick={() => void action("accept")}>{t("useResult")}</Button><Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={() => setDraft((current) => ({ ...current, [item.id]: { ...current[item.id], open: true } }))}>{t("correctResult")}</Button><Button type="button" variant="link" disabled={Boolean(busy)} onClick={() => void action("reject_question")}>{t("removeQuestion")}</Button></div>}</div><CorpusPreview t={t} corpus={review.corpus} /><div className="cpv2-workspace-actions">{review.rerun_ready ? <Button type="button" loading={busy === "rerun"} onClick={async () => { setBusy("rerun"); try { const result = await submitFactoryReview(token, { id: run.id, version: review.version }, { action: "rerun", candidateDigest: review.candidate_digest }); if (result.next_run) onRerun(result.next_run); } catch (error) { onError?.(error instanceof Error ? error : new Error("Unable to generate another version")); } finally { setBusy(""); } }}>{t("generateAnotherVersion")}</Button> : review.release_ready ? <Button type="button" onClick={onComplete}>{t("complete")}</Button> : null}</div></section>;
}

function CorpusPreview({ t, corpus }) {
  if (!corpus?.available) return <article className="cpv2-corpus-preview"><h3>{t("fullCorpus")}</h3><p>{corpus?.reason ?? "Corpus unavailable"}</p></article>;
  return <article className="cpv2-corpus-preview"><div className="cpv2-panel-heading"><h3>{t("fullCorpus")}</h3><code>{corpus.digest}</code></div>{corpus.assets.map((asset) => <details key={`${asset.layer}:${asset.path}`}><summary>{asset.id} · {asset.layer}</summary><pre>{asset.content}</pre></details>)}</article>;
}

function CompletePanel({ t, product, run, review, busy, setBusy, onRerun, onPublished, onReview, request, token, productId }) {
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  async function publish() {
    if (!review?.release_ready || !run?.candidate) return;
    setBusy("publish"); setError("");
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/release`, { method: "POST", token, headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ candidate_id: run.id, report_digest: run.candidate.report_digest, expected_version: run.version }) });
      onPublished();
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(""); }
  }
  return <section className="cpv2-workspace-panel cpv2-complete-panel"><h2>{t("complete")}</h2><div className="cpv2-product-detail-preview"><h3>{product?.name ?? "Product"}</h3><p>{product?.promise ?? product?.description ?? ""}</p><Button type="button" variant="link" onClick={() => setShowDetails((current) => !current)}>{t("viewProductDetails")}</Button>{showDetails ? <CorpusPreview t={t} corpus={review?.corpus} /> : null}</div>{error ? <InlineAlert tone="error">{error}</InlineAlert> : null}{review?.release_ready ? <div className="cpv2-complete-actions"><Button type="button" loading={busy === "publish"} onClick={() => void publish()}>{t("publishProduct")}</Button>{review?.rerun_ready ? <Button type="button" variant="secondary" onClick={onReview}>{t("generateAnotherVersion")}</Button> : null}</div> : <div className="cpv2-complete-actions"><p>{review?.rerun_ready ? t("correctionSaved") : t("noRun")}</p>{review?.rerun_ready ? <Button type="button" loading={busy === "rerun"} onClick={async () => { setBusy("rerun"); try { const result = await submitFactoryReview(token, { id: run.id, version: review.version }, { action: "rerun", candidateDigest: review.candidate_digest }); if (result.next_run) onRerun(result.next_run); } catch (nextError) { setError(nextError.message); } finally { setBusy(""); } }}>{t("generateAnotherVersion")}</Button> : <Button type="button" variant="secondary" onClick={onReview}>{t("review")}</Button>}</div>}</section>;
}

function versionStatus(run) {
  if (run.status === "ready") return "Complete";
  if (run.status === "waiting_for_creator") return "About you";
  if (run.stage === "review_required") return "Review";
  return run.status ?? "Working";
}
