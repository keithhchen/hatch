import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, FormField, InlineAlert, PageHeader, Select, Skeleton, StatusTag, Textarea } from "@hatch/ui";
import { UserRound } from "lucide-react";
import {
  getProduct,
  getFactoryRun,
  getFactoryReview,
  listProductFiles,
  listProductVersions,
  saveProductBriefSpec,
  saveFactoryAnswerDraft,
  startFactoryRunFromSources,
  submitFactoryAnswers,
  submitFactoryReview,
  retryFactoryRun,
  updateProductPromise,
  uploadProductFile
} from "./creatorFactory.js";
import { createCreatorTranslator } from "./creatorI18n.js";
import { canAcceptReviewCase, completeReviewMode } from "./creatorReviewUi.js";
import {
  canGenerateProductVersion,
  productFileState,
  shouldPollProductFiles
} from "./creatorProductFilesUi.js";
import {
  runAttentionAction,
  runAttentionError,
  runNeedsAttention
} from "./creatorRunAttentionUi.js";
import {
  CREATOR_WORKFLOW_STEPS,
  deriveCreatorWorkflow
} from "./creatorWorkflowUi.js";
import "./creatorProductWorkspace.css";

const TAB_KEYS = CREATOR_WORKFLOW_STEPS;

export function CreatorProductWorkspace({ token, request, productId, runId = "", tab = "files", navigate, locale = "en", profile }) {
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [product, setProduct] = useState(null);
  const [runs, setRuns] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [run, setRun] = useState(null);
  const [review, setReview] = useState(null);
  const [briefSpec, setBriefSpec] = useState(null);
  const [state, setState] = useState({ loading: true, busy: "", error: "", notice: "" });
  const [selectedTab, setSelectedTab] = useState(TAB_KEYS.includes(tab) ? tab : "files");
  const [selectedRunId, setSelectedRunId] = useState(runId);
  const [promiseDraft, setPromiseDraft] = useState("");
  const persistedWorkflowStep = useMemo(() => deriveCreatorWorkflow({ run, review, briefSpec }).current, [briefSpec, review, run]);
  const workflow = useMemo(() => deriveCreatorWorkflow({ run, review, briefSpec, busy: state.busy }), [briefSpec, review, run, state.busy]);
  const previousWorkflowStep = useRef(null);
  const filesNeedPolling = useMemo(() => shouldPollProductFiles(documents), [documents]);

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const productResponse = await request(`/v1/creator/products/${encodeURIComponent(productId)}`, { token });
      const nextProduct = productResponse?.product ?? productResponse;
      const [nextFiles, nextVersions] = await Promise.all([
        listProductFiles(token, productId),
        listProductVersions(token, productId)
      ]);
      const productRuns = nextVersions.versions ?? nextVersions.runs ?? nextVersions;
      const sortedRuns = [...productRuns].sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
      const nextRunId = selectedRunId && sortedRuns.some((item) => item.id === selectedRunId)
        ? selectedRunId
        : sortedRuns[0]?.id ?? "";
      const nextRun = nextRunId ? await getFactoryRun(token, nextRunId) : null;
      let nextReview = null;
      if (nextRunId && (nextRun?.candidate || nextRun?.status === "ready" || nextRun?.stage === "review_required")) {
        try { nextReview = await getFactoryReview(token, nextRunId, request); } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
        }
      }
      setProduct(nextProduct);
      setBriefSpec(nextProduct?.brief_spec ?? null);
      setPromiseDraft(nextProduct?.promise ?? nextProduct?.description ?? "");
      setRuns(sortedRuns);
      setSelectedRunId(nextRunId);
      setRun(nextRun);
      setDocuments(nextFiles.files ?? nextFiles.documents ?? []);
      setReview(nextReview);
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [productId, request, selectedRunId, token]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const requested = TAB_KEYS.includes(tab) ? tab : "files";
    if (state.loading || !product) {
      setSelectedTab(requested);
      return;
    }
    if (workflow.steps[requested]?.enabled) {
      setSelectedTab(requested);
      return;
    }
    setSelectedTab(workflow.current);
    navigate(`/studio/products/${encodeURIComponent(productId)}/${workflow.current}`);
  }, [navigate, product, productId, state.loading, tab, workflow]);
  useEffect(() => {
    if (state.loading || !product) return;
    const previous = previousWorkflowStep.current;
    previousWorkflowStep.current = persistedWorkflowStep;
    if (!previous || previous === persistedWorkflowStep || selectedTab !== previous) return;
    setSelectedTab(persistedWorkflowStep);
    navigate(`/studio/products/${encodeURIComponent(productId)}/${persistedWorkflowStep}`);
  }, [navigate, persistedWorkflowStep, product, productId, selectedTab, state.loading]);
  useEffect(() => {
    if (runId) setSelectedRunId(runId);
  }, [runId]);

  useEffect(() => {
    if (!filesNeedPolling) return undefined;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await listProductFiles(token, productId);
        if (!cancelled) setDocuments(response.files ?? response.documents ?? []);
      } catch (error) {
        if (!cancelled) setState((current) => ({ ...current, error: error.message }));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [filesNeedPolling, productId, token]);

  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      getFactoryRun(token, run.id).then(async (nextRun) => {
        if (cancelled) return;
        setRun(nextRun);
        setRuns((current) => current.map((item) => item.id === nextRun.id ? nextRun : item));
        // A polling blip must not turn a live Factory run into a user-facing
        // "Failed to fetch" error. The next authoritative run response is
        // the recovery signal; command failures (answer/retry/review writes)
        // still surface through their own handlers.
        setState((current) => ({
          ...current,
          ...(nextRun.status === "queued" || nextRun.status === "running" ? { error: "" } : {})
        }));
        if (nextRun.candidate || nextRun.status === "ready" || nextRun.stage === "review_required") {
          const nextReview = await getFactoryReview(token, nextRun.id, request);
          if (!cancelled) setReview(nextReview);
        }
      }).catch((error) => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            // Keep the prior live status visible while a read-only poll is
            // retrying; do not overwrite it with a transient fetch error.
            ...(run.status === "queued" || run.status === "running" ? {} : { error: error.message })
          }));
        }
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [request, run?.id, run?.status, token]);

  function goTab(nextTab) {
    if (!TAB_KEYS.includes(nextTab) || !workflow.steps[nextTab]?.enabled) return;
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
    if (!product || !files?.length) return;
    setState((current) => ({ ...current, busy: "upload", error: "", notice: "" }));
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await uploadProductFile(token, product.id ?? product.product_id, file));
      setDocuments((current) => [...uploaded, ...current]);
      setState((current) => ({ ...current, notice: t("filesReady", uploaded.length) }));
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setState((current) => ({ ...current, busy: "" })); }
  }

  async function startRun() {
    if (!product || !documents.length || state.busy) return;
    setState((current) => ({ ...current, busy: "start", error: "", notice: "" }));
    try {
      const created = await startFactoryRunFromSources(token, product, documents.map(documentId));
      const createdRun = created?.run ?? created;
      const nextRun = await getFactoryRun(token, createdRun.id);
      setRun(nextRun);
      setSelectedRunId(nextRun.id);
      setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]);
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setState((current) => ({ ...current, busy: "" })); }
  }

  async function retryRun() {
    if (!run?.retryable || state.busy) return;
    setState((current) => ({ ...current, busy: "retry-run", error: "", notice: "" }));
    try {
      const nextRun = await retryFactoryRun(token, run);
      setRun(nextRun);
      setReview(null);
      setRuns((current) => current.map((item) => item.id === nextRun.id ? nextRun : item));
      setState((current) => ({ ...current, notice: t("retryStarted") }));
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  if (state.loading && !product) return <section className="cpv2-loading" aria-busy="true"><Skeleton lines={5} /></section>;
  if (state.error && !product) return <section className="cpv2-workspace-error"><InlineAlert tone="error">{state.error}</InlineAlert><Button type="button" onClick={() => void refresh()}>{t("retry")}</Button></section>;

  return <section className="cpv2-product-workspace">
    <div className="cpv2-workspace-topline"><button type="button" className="cpv2-back-link" onClick={() => navigate("/studio/products")}>{t("products")}</button><div className="cpv2-version-browser"><span className="cpv2-version-label">{t("browse")}</span><Select id="workspace-version" className="cpv2-version-select" label={t("browse")} value={selectedRunId || "current"} onValueChange={(value) => { if (value !== "current") void selectRun(value); }} disabled={!runs.length || state.busy === "select-run" || workflow.working} size="compact" surface="raised" options={[{ value: "current", label: t("currentVersion") }, ...runs.map((item) => ({ value: item.id, label: t("version", item.revision_number ?? item.version ?? "—", versionStatus(item, t)) }))]} /></div></div>
    <PageHeader className="cpv2-workspace-header" label={product?.status === "published" ? t("published") : t("product")} title={product?.name ?? product?.product_name ?? t("product")} body={product?.promise ?? product?.description ?? ""} />
    {product ? <ProductPromiseForm t={t} token={token} product={product} value={promiseDraft} locked={workflow.working} onChange={setPromiseDraft} onSaved={(nextProduct) => { setProduct(nextProduct?.product ?? nextProduct); setPromiseDraft((nextProduct?.product ?? nextProduct).promise ?? ""); setState((current) => ({ ...current, notice: t("productPromiseSaved") })); }} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    <div className="cpv2-workspace-tabs" role="tablist" aria-label={t("productWorkflow")}>{TAB_KEYS.map((key) => {
      const step = workflow.steps[key];
      const label = t(key === "about-you" ? "aboutYou" : key);
      return <button key={key} type="button" role="tab" aria-selected={selectedTab === key} aria-disabled={!step.enabled} aria-busy={step.loading} className={`${selectedTab === key ? "is-active" : ""}${!step.enabled ? " is-disabled" : ""}`} disabled={!step.enabled} onClick={() => goTab(key)}><span>{label}</span>{step.loading ? <span className="cpv2-tab-spinner" aria-label={t("waiting")} /> : null}</button>;
    })}</div>
    {state.error ? <InlineAlert tone="error">{state.error}</InlineAlert> : null}
    {state.notice ? <InlineAlert tone="success">{state.notice}</InlineAlert> : null}
    {selectedTab === "files" ? <FilesPanel t={t} product={product} documents={documents} busy={state.busy} loading={workflow.steps.files.loading} locked={workflow.working && workflow.current !== "files"} onUpload={upload} onStart={startRun} hasRun={Boolean(run)} /> : null}
    {selectedTab === "about-you" ? <AboutYouPanel t={t} token={token} run={run} busy={state.busy} loading={workflow.steps["about-you"].loading} setBusy={(busy) => setState((current) => ({ ...current, busy }))} onRetry={retryRun} onFiles={() => goTab("files")} onSaved={(nextRun) => { setRun(nextRun); if (nextRun.status === "queued") setState((current) => ({ ...current, notice: t("waiting") })); }} onFinish={(nextRun) => { setRun(nextRun); }} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    {selectedTab === "review" ? <ReviewPanel t={t} token={token} profile={profile} run={run} review={review} busy={state.busy} loading={workflow.steps.review.loading} setBusy={(busy) => setState((current) => ({ ...current, busy }))} onRetry={retryRun} onFiles={() => goTab("files")} onReviewChanged={setReview} onRerun={(nextRun) => { setRun(nextRun); setReview(null); setSelectedRunId(nextRun.id); }} onComplete={() => goTab("brief")} onRefresh={refresh} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    {selectedTab === "brief" ? <BriefPanel t={t} token={token} product={product} briefSpec={briefSpec} busy={state.busy} onSaved={(nextProduct) => { const saved = nextProduct?.product ?? nextProduct; setProduct((current) => ({ ...current, ...saved })); setBriefSpec(saved?.brief_spec ?? null); setState((current) => ({ ...current, notice: t("briefSaved") })); }} onError={(error) => setState((current) => ({ ...current, error: error.message }))} /> : null}
    {selectedTab === "complete" ? <CompletePanel t={t} product={product} briefSpec={briefSpec} run={run} review={review} busy={state.busy} setBusy={(busy) => setState((current) => ({ ...current, busy }))} onRetry={retryRun} onRerun={(nextRun) => { setRun(nextRun); setReview(null); setSelectedRunId(nextRun.id); }} onPublished={() => void refresh()} onReview={() => goTab("review")} onBrief={() => goTab("brief")} onFiles={() => goTab("files")} request={request} token={token} productId={productId} /> : null}
  </section>;
}

function FilesPanel({ t, product, documents, busy, loading, locked, onUpload, onStart, hasRun }) {
  return <section className="cpv2-workspace-panel">
    <div className="cpv2-panel-heading"><div><h2>{t("giveMaterial")}</h2><p>{t("localFilesOnly")}</p></div><label className={`cpv2-upload-button${locked || loading ? " is-disabled" : ""}`}>{t("uploadFiles")}<input type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.html,.htm,.png,.jpg,.jpeg,.webp" onChange={(event) => { void onUpload([...event.target.files]); event.target.value = ""; }} disabled={Boolean(busy) || locked || loading} /></label></div>
    <div className="cpv2-file-list">{documents.map((document) => { const status = productFileState(document); return <div className="cpv2-file-row" key={documentId(document)}><div><strong>{document.display_name ?? document.file_name ?? t("unnamedFile")}</strong><small>{document.projection?.kind === "image" ? t("imageNative") : t("markdownProjection")}</small></div><StatusTag tone={statusTone(status)}>{t(`fileStatus_${status}`)}</StatusTag></div>; })}</div>
    {!documents.length ? <p className="cpv2-empty-inline">{t("uploadForProduct")}</p> : null}
    <p className="cpv2-source-note">{t("sourceNote")}</p>
    {loading ? <GenerationStatus t={t} label={t("versionGenerated")} /> : null}
    <div className="cpv2-workspace-actions"><Button type="button" loading={loading || busy === "start"} disabled={!canGenerateProductVersion(documents) || Boolean(busy) || locked || loading} onClick={onStart}>{hasRun ? t("continueWithFiles") : t("startDistillation")}</Button></div>
  </section>;
}

function ProductPromiseForm({ t, token, product, value, locked, onChange, onSaved, onError }) {
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const currentProduct = await latestProductForMutation(token, product);
      onSaved(await updateProductPromise(token, currentProduct, value));
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Unable to save the product promise"));
    } finally {
      setBusy(false);
    }
  }
  return <form className="cpv2-product-promise" onSubmit={save}><FormField label={t("whatProductDelivers")}><Textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={locked || busy} /></FormField><Button type="submit" loading={busy} disabled={locked || !value.trim() || value.trim() === String(product.promise ?? product.description ?? "").trim()}>{t("saveProductPromise")}</Button></form>;
}

async function latestProductForMutation(token, product) {
  const productId = product?.id ?? product?.product_id;
  const response = await getProduct(token, productId);
  return response?.product ?? response;
}

function AboutYouPanel({ t, token, run, busy, loading, setBusy, onRetry, onFiles, onSaved, onFinish, onError }) {
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
    if (!run || !questions.length || loading || busy) return;
    setBusy("answer");
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
    } finally {
      setBusy("");
    }
  }

  if (!run) return <section className="cpv2-workspace-panel"><h2>{t("aboutYou")}</h2><p>{t("noRun")}</p></section>;
  if (runNeedsAttention(run)) return <RunAttentionPanel t={t} run={run} busy={busy} onRetry={onRetry} onFiles={onFiles} />;
  if (loading && !questions.length) return <section className="cpv2-workspace-panel" aria-busy="true"><h2>{t("aboutYou")}</h2><GenerationStatus t={t} label={t("versionGenerated")} /></section>;
  if (!questions.length) return <section className="cpv2-workspace-panel"><h2>{t("aboutYou")}</h2><p>{["queued", "running"].includes(run.status) ? t("waiting") : t("noQuestions")}</p></section>;
  const question = questions[index];
  const answer = answers[question.id] ?? "";
  const canAdvance = answer.trim().length > 0;
  return <section className="cpv2-workspace-panel cpv2-about-panel" aria-busy={loading}><div className="cpv2-panel-heading"><div><h2>{t("helpUnderstand")}</h2><p>{t("questionOf", index + 1, questions.length)}</p></div><div className="cpv2-carousel-nav"><button type="button" disabled={index === 0 || loading} onClick={() => setIndex((current) => current - 1)}>←</button><button type="button" disabled={index === questions.length - 1 || loading} onClick={() => setIndex((current) => current + 1)}>→</button></div></div>{loading ? <GenerationStatus t={t} label={t("versionGenerated")} /> : null}<div className="cpv2-about-question"><h3>{question.question}</h3><div className="cpv2-about-columns"><article><span>{t("sourceEvidence")}</span><h4>{t("whatHatchFound")}</h4><p>{question.intent ?? ""}</p></article><article className="is-answer"><FormField label={t("yourContext")}><Textarea value={answer} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={t("addContext")} disabled={loading} /></FormField></article></div><div className="cpv2-workspace-actions"><Button type="button" loading={saveState === "saving" || busy === "answer" || loading} disabled={!canAdvance || Boolean(busy) || loading} onClick={() => { void save(index + 1); }}>{index === questions.length - 1 ? t("finishAndReview") : t("saveAndNext")}</Button>{saveState === "saved" ? <span className="cpv2-save-status">{t("saved")}</span> : null}</div></div></section>;
}

function BriefPanel({ t, token, product, briefSpec, busy, onSaved, onError }) {
  const [fields, setFields] = useState(() => (Array.isArray(briefSpec?.fields) ? briefSpec.fields.map((field, index) => ({
    id: String(field.id || `question-${index + 1}`),
    label: String(field.label || ""),
    required: field.required === true
  })) : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setFields(Array.isArray(briefSpec?.fields) ? briefSpec.fields.map((field, index) => ({
      id: String(field.id || `question-${index + 1}`),
      label: String(field.label || ""),
      required: field.required === true
    })) : []);
  }, [briefSpec]);

  function addQuestion() {
    if (fields.length >= 16) return;
    setFields((current) => [...current, { id: nextBriefFieldId(current), label: "", required: true }]);
    setError("");
  }

  function updateField(id, patch) {
    setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field));
    setError("");
  }

  function moveField(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    setFields((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save(event) {
    event.preventDefault();
    if (saving || busy) return;
    const normalized = fields.map((field) => ({ ...field, label: field.label.trim() }));
    const ids = new Set();
    const invalid = normalized.length === 0 || normalized.length > 16 || normalized.some((field) => {
      if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(field.id) || field.id.length > 128 || ids.has(field.id)) return true;
      ids.add(field.id);
      return !field.label || field.label.length > 500 || field.label.includes("\u0000") || typeof field.required !== "boolean";
    });
    if (invalid) {
      setError(t("briefRequiredBeforePublish"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Review/rerun work can advance the Product updated_at while this form
      // remains open. Refresh the Product revision immediately before the
      // CAS write so a normal single-creator flow does not surface a stale
      // "refresh before saving" error.
      const currentProduct = await latestProductForMutation(token, product);
      const saved = await saveProductBriefSpec(token, currentProduct, { contract_version: "1", fields: normalized });
      onSaved(saved);
    } catch (nextError) {
      const errorValue = nextError instanceof Error ? nextError : new Error("Unable to save the Brief");
      setError(errorValue.message);
      onError?.(errorValue);
    } finally {
      setSaving(false);
    }
  }

  return <form className="cpv2-workspace-panel cpv2-brief-panel" onSubmit={save}>
    <div className="cpv2-panel-heading"><div><h2>{t("briefTitle")}</h2><p>{t("briefBody")}</p></div><Button type="button" variant="secondary" onClick={addQuestion} disabled={fields.length >= 16 || saving}>{t("addBriefQuestion")}</Button></div>
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    <div className="cpv2-brief-fields">
      {fields.map((field, index) => <div className="cpv2-brief-field" key={field.id}>
        <span className="cpv2-brief-field-number">{index + 1}</span>
        <FormField label={t("briefQuestion")} required><Textarea value={field.label} placeholder={t("briefQuestionPlaceholder")} onChange={(event) => updateField(field.id, { label: event.target.value })} disabled={saving} /></FormField>
        <label className="cpv2-brief-required"><input type="checkbox" checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} disabled={saving} />{t("requiredQuestion")}</label>
        <div className="cpv2-brief-field-actions"><button type="button" onClick={() => moveField(index, -1)} disabled={index === 0 || saving} aria-label={t("moveQuestionUp")}>↑</button><button type="button" onClick={() => moveField(index, 1)} disabled={index === fields.length - 1 || saving} aria-label={t("moveQuestionDown")}>↓</button><button type="button" onClick={() => { setFields((current) => current.filter((item) => item.id !== field.id)); setError(""); }} disabled={saving}>{t("removeQuestion")}</button></div>
      </div>)}
    </div>
    {!fields.length ? <p className="cpv2-empty-inline">{t("briefRequiredBeforePublish")}</p> : null}
    <div className="cpv2-brief-summary"><strong>{t("brief")}</strong><ol>{fields.map((field) => <li key={field.id}>{field.label || t("briefQuestionPlaceholder")} · {field.required ? t("requiredQuestion") : t("optional")}</li>)}</ol></div>
    <div className="cpv2-workspace-actions"><Button type="submit" loading={saving} disabled={saving || Boolean(busy) || fields.length === 0}>{t("saveBriefAndContinue")}</Button></div>
  </form>;
}

function nextBriefFieldId(fields) {
  let index = fields.length + 1;
  while (fields.some((field) => field.id === `question-${index}`)) index += 1;
  return `question-${index}`;
}

function ReviewPanel({ t, token, profile, run, review, busy, loading, setBusy, onRetry, onFiles, onReviewChanged, onRerun, onComplete, onRefresh, onError }) {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState({});
  const [removeOpen, setRemoveOpen] = useState({});
  const cases = review?.cases ?? [];
  useEffect(() => setIndex((current) => Math.min(current, Math.max(cases.length - 1, 0))), [cases.length]);
  if (runNeedsAttention(run)) return <RunAttentionPanel t={t} run={run} busy={busy} onRetry={onRetry} onFiles={onFiles} />;
  if (loading) return <section className="cpv2-workspace-panel" aria-busy="true"><h2>{t("review")}</h2><GenerationStatus t={t} label={t("versionGenerated")} /></section>;
  if (!run || !review) return <section className="cpv2-workspace-panel"><h2>{t("review")}</h2><p>{t("waiting")}</p></section>;
  if (["queued", "running"].includes(run.status)) return <section className="cpv2-workspace-panel"><h2>{t("review")}</h2><p>{t("waiting")}</p></section>;
  const item = cases[index];
  if (!item) return <section className="cpv2-workspace-panel"><h2>{t("review")}</h2><p>{t("noQuestions")}</p></section>;
  const currentDraft = draft[item.id] ?? {};
  const handled = item.status !== "needs_review";
  async function action(actionName) {
    if (actionName === "correct" && (!currentDraft.correction?.trim() || !currentDraft.why?.trim())) return;
    setBusy(`review:${item.id}`);
    try {
      const result = await submitFactoryReview(token, { id: run.id, version: review.version }, {
        action: actionName,
        caseId: item.id,
        caseDigest: item.case_digest,
        candidateDigest: review.candidate_digest,
        correction: currentDraft.correction,
        why: currentDraft.why
      });
      onReviewChanged(result.review ?? review);
      setDraft((current) => ({ ...current, [item.id]: {} }));
      setRemoveOpen((current) => ({ ...current, [item.id]: false }));
      if (index < cases.length - 1) setIndex((current) => current + 1);
    } catch (error) {
      // The provider may settle a candidate between the initial review GET and
      // this write. Refresh the authoritative projection automatically while
      // keeping the local correction draft, instead of forcing a manual page
      // reload or dropping the creator's work.
      if (error?.status === 409 || error?.code === "version_conflict") await onRefresh?.();
      onError?.(error instanceof Error ? error : new Error("Unable to save this review"));
    } finally {
      setBusy("");
    }
  }
  async function rerun() {
    setBusy("rerun");
    try {
      const result = await submitFactoryReview(token, { id: run.id, version: review.version }, { action: "rerun", candidateDigest: review.candidate_digest });
      if (result.next_run) onRerun(result.next_run);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Unable to generate another version"));
    } finally {
      setBusy("");
    }
  }
  return <section className="cpv2-workspace-panel cpv2-review-panel">
    <div className="cpv2-panel-heading"><div><h2>{t("reviewResult")}</h2><p>{index + 1} / {cases.length}</p></div><div className="cpv2-carousel-nav"><button type="button" disabled={index === 0} onClick={() => setIndex((current) => current - 1)}>←</button><button type="button" disabled={index === cases.length - 1} onClick={() => setIndex((current) => current + 1)}>→</button></div></div>
    <div className="cpv2-review-case">
      <div className="cpv2-review-columns">
        <article className="cpv2-user-situation"><span className="cpv2-review-label"><span className="cpv2-review-avatar cpv2-review-avatar-user" aria-hidden="true"><UserRound size={14} strokeWidth={2} /></span>{t("userSituation")}</span><p>{item.question}</p></article>
        <article className="cpv2-your-method"><span className="cpv2-review-label"><span className="cpv2-review-avatar cpv2-review-avatar-creator" aria-hidden="true">{profile?.initials || "C"}</span>{t("yourMethod")}</span><p>{item.creator_reference}</p></article>
      </div>
      <article className="cpv2-current-response"><span>{t("currentResponse")}</span><div>{item.candidate_output}</div></article>
      <div className={`cpv2-eval-note ${item.verdict === "PASS" ? "is-pass" : "is-fail"}`}><strong>{item.verdict === "PASS" ? t("evaluationPassed") : t("evaluationFailed")}</strong><p>{item.diagnosis}</p></div>
      {handled ? <StatusTag tone={reviewStatusTone(item.status)}>{reviewStatusLabel(item.status, t)}</StatusTag> : currentDraft.open ? <div className="cpv2-correction-form"><FormField label={t("whatShouldHatchHaveDone")} required><Textarea value={currentDraft.correction ?? ""} onChange={(event) => setDraft((current) => ({ ...current, [item.id]: { ...current[item.id], correction: event.target.value } }))} /></FormField><FormField label={t("why")} required><Textarea value={currentDraft.why ?? ""} onChange={(event) => setDraft((current) => ({ ...current, [item.id]: { ...current[item.id], correction: current[item.id]?.correction, why: event.target.value } }))} /></FormField><Button type="button" loading={busy === `review:${item.id}`} onClick={() => void action("correct")}>{t("saveAndNext")}</Button></div> : <div className="cpv2-review-actions"><div className="cpv2-review-action-row">{canAcceptReviewCase(item) ? <Button type="button" className="is-success" disabled={Boolean(busy)} onClick={() => void action("accept")}>{t("useResult")}</Button> : null}<Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={() => setDraft((current) => ({ ...current, [item.id]: { ...current[item.id], open: true } }))}>{t("correctResult")}</Button></div><div className="cpv2-review-remove"><Button type="button" variant="link" disabled={Boolean(busy)} onClick={() => setRemoveOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}>{t("removeQuestion")}</Button>{removeOpen[item.id] ? <div className="cpv2-remove-popover" role="dialog" aria-label={t("removeQuestion")}><p>{t("removeQuestionHelp")}</p><div className="cpv2-remove-popover-actions"><Button type="button" loading={busy === `review:${item.id}`} onClick={() => void action("reject_question")}>{t("confirmRemoveQuestion")}</Button><Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={() => setRemoveOpen((current) => ({ ...current, [item.id]: false }))}>{t("cancel")}</Button></div></div> : null}</div></div>}
    </div>
    <CorpusPreview t={t} corpus={review.corpus} />
    <div className="cpv2-workspace-actions">{review.rerun_ready ? <Button type="button" loading={busy === "rerun"} onClick={() => void rerun()}>{t("generateAnotherVersion")}</Button> : review.release_ready ? <Button type="button" onClick={onComplete}>{t("complete")}</Button> : null}</div>
  </section>;
}

function GenerationStatus({ t, label }) {
  return <div className="cpv2-generation-status" role="status" aria-live="polite"><span className="cpv2-loading-spinner" aria-hidden="true" /><span>{label ?? t("waiting")}</span></div>;
}

function RunAttentionPanel({ t, run, busy, onRetry, onFiles }) {
  const action = runAttentionAction(run);
  const error = runAttentionError(run);
  return <section className="cpv2-workspace-panel cpv2-attention-panel" aria-busy={busy === "retry-run"}>
    <StatusTag tone="error">{t("versionNeedsAttention")}</StatusTag>
    <h2>{t("versionGenerationPaused")}</h2>
    <p>{error ?? t("failureDetailsUnavailable")}</p>
    <div className="cpv2-workspace-actions">
      {action === "retry" ? <Button type="button" loading={busy === "retry-run"} disabled={Boolean(busy)} onClick={() => void onRetry()}>{t("retryFailedStage")}</Button> : <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={onFiles}>{t("addSourceFiles")}</Button>}
    </div>
  </section>;
}

function CorpusPreview({ t, corpus }) {
  if (!corpus?.available) return <article className="cpv2-corpus-preview"><h3>{t("fullCorpus")}</h3><p>{corpus?.reason ?? t("corpusUnavailable")}</p></article>;
  return <article className="cpv2-corpus-preview"><div className="cpv2-panel-heading"><h3>{t("fullCorpus")}</h3><code>{corpus.digest}</code></div>{corpus.assets.map((asset) => <details key={`${asset.layer}:${asset.path}`}><summary>{asset.id} · {asset.layer}</summary><pre>{asset.content}</pre></details>)}</article>;
}

function CompletePanel({ t, product, briefSpec, run, review, busy, setBusy, onRetry, onRerun, onPublished, onReview, onBrief, onFiles, request, token, productId }) {
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const reviewMode = completeReviewMode(review);
  async function publish() {
    if (!briefSpec?.fields?.length || !review?.release_ready || !run?.candidate) return;
    setBusy("publish"); setError("");
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/release`, { method: "POST", token, headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ candidate_id: run.id, report_digest: run.candidate.report_digest, expected_version: product?.resource_version ?? product?.version ?? 0 }) });
      onPublished();
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(""); }
  }

  // Complete is a release decision, not a second progress screen. Keep the
  // creator on the authoritative run state until the server has produced a
  // reviewable version; never show a preview that cannot yet be published.
  if (!run) {
    return <section className="cpv2-workspace-panel cpv2-complete-panel cpv2-complete-waiting">
      <StatusTag tone="neutral">{t("waiting")}</StatusTag>
      <h2>{t("complete")}</h2>
      <p>{t("noRun")}</p>
      <div className="cpv2-workspace-actions"><Button type="button" variant="secondary" onClick={onFiles}>{t("addSourceFiles")}</Button></div>
    </section>;
  }
  if (["queued", "running"].includes(run.status)) {
    return <section className="cpv2-workspace-panel cpv2-complete-panel cpv2-complete-waiting" aria-busy="true">
      <StatusTag tone="neutral">{t("waiting")}</StatusTag>
      <h2>{t("versionGenerated")}</h2>
      <p>{t("waiting")}</p>
    </section>;
  }
  if (runNeedsAttention(run)) {
    return <RunAttentionPanel t={t} run={run} busy={busy} onRetry={onRetry} onFiles={onFiles} />;
  }
  if (!review || (!review.release_ready && !review.rerun_ready)) {
    return <section className="cpv2-workspace-panel cpv2-complete-panel cpv2-complete-waiting" aria-busy="true">
      <StatusTag tone="neutral">{t("waiting")}</StatusTag>
      <h2>{t("versionGenerated")}</h2>
      <p>{t("waiting")}</p>
      <div className="cpv2-workspace-actions"><Button type="button" variant="secondary" onClick={onReview}>{t("review")}</Button></div>
    </section>;
  }

  return <section className="cpv2-workspace-panel cpv2-complete-panel">
    <h2>{t("complete")}</h2>
    <div className="cpv2-product-detail-preview"><h3>{product?.name ?? t("product")}</h3><p>{product?.promise ?? product?.description ?? ""}</p><Button type="button" variant="link" onClick={() => setShowDetails((current) => !current)}>{t("viewProductDetails")}</Button>{showDetails ? <CorpusPreview t={t} corpus={review?.corpus} /> : null}</div>
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {!briefSpec?.fields?.length ? <div className="cpv2-complete-brief-required"><p>{t("briefRequiredBeforePublish")}</p><Button type="button" variant="secondary" onClick={onBrief}>{t("brief")}</Button></div> : reviewMode === "publish" ? <><div className="cpv2-complete-actions"><Button type="button" loading={busy === "publish"} onClick={() => void publish()}>{t("publishProduct")}</Button><Button type="button" variant="secondary" onClick={onFiles}>{t("addSourceFiles")}</Button></div><p className="cpv2-complete-next-step">{t("addFilesForVersion")}</p></> : <div className="cpv2-complete-actions"><p>{reviewMode === "rerun" ? t("correctionSaved") : t("reviewBeforeComplete")}</p>{reviewMode === "rerun" ? <Button type="button" variant="secondary" onClick={async () => { setBusy("rerun"); try { const result = await submitFactoryReview(token, { id: run.id, version: review.version }, { action: "rerun", candidateDigest: review.candidate_digest }); if (result.next_run) onRerun(result.next_run); } catch (nextError) { setError(nextError.message); } finally { setBusy(""); } }}>{t("generateAnotherVersion")}</Button> : <Button type="button" variant="secondary" onClick={onReview}>{t("review")}</Button>}</div>}
  </section>;
}

function versionStatus(run, t) {
  if (run.status === "ready") return t("complete");
  if (run.status === "waiting_for_creator") return t("aboutYou");
  if (run.stage === "review_required") return t("review");
  if (run.status === "needs_attention") return t("versionNeedsAttention");
  return t("waiting");
}

function documentId(document) {
  return document?.id ?? document?.file_id ?? document?.document_id ?? document?.artifact_id ?? "";
}

function statusTone(status) {
  if (status === "ready" || status === "accepted") return "success";
  if (status === "error" || status === "failed") return "error";
  return "neutral";
}

function reviewStatusTone(status) {
  if (["accepted", "used", "corrected"].includes(String(status).toLowerCase())) return "success";
  if (["needs_correction", "needs_review"].includes(String(status).toLowerCase())) return "warning";
  return "neutral";
}

function reviewStatusLabel(status, t) {
  const key = `reviewStatus_${String(status ?? "").toLowerCase()}`;
  return t(key) === key ? String(status ?? t("saved")) : t(key);
}
