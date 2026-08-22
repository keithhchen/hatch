import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, FormField, InlineAlert, PageHeader, RadioGroup, Skeleton, StatusTag, Textarea } from "@hatch/ui";
import {
  getLatestNodeExecution,
  getProduct,
  listProductFiles,
  deleteProductFile,
  publishCorpusToRegistry,
  saveAboutYouNodeAnswers,
  saveProductBriefSpec,
  startAboutYouNode,
  startCorpusNode,
  updateProductPromise,
  uploadProductFile
} from "./creatorFactory.js";
import { createCreatorTranslator } from "./creatorI18n.js";
import {
  CREATOR_WORKFLOW_STEPS,
  deriveCreatorWorkflow,
  executionError,
  isExecutionActive,
  isExecutionError,
  isValidBriefSpec
} from "./creatorWorkflowUi.js";
import { getCreatorNodeTips } from "./creatorNodeTips.js";
import "./creatorProductWorkspace.css";

const TAB_KEYS = CREATOR_WORKFLOW_STEPS;

export function CreatorProductWorkspace({ token, productId, tab = "files", navigate, locale = "en" }) {
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [product, setProduct] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [aboutYou, setAboutYou] = useState(null);
  const [corpus, setCorpus] = useState(null);
  const [briefSpec, setBriefSpec] = useState(null);
  const [promiseDraft, setPromiseDraft] = useState("");
  const [selectedTab, setSelectedTab] = useState(TAB_KEYS.includes(tab) ? tab : "files");
  const [state, setState] = useState({ loading: true, busy: "", error: "", notice: "" });
  const retryActionRef = useRef(null);

  const workflow = useMemo(() => deriveCreatorWorkflow({ product, documents, aboutYou, corpus, briefSpec }), [aboutYou, briefSpec, corpus, documents, product]);
  const serverError = executionError(aboutYou) || executionError(corpus);
  const error = state.error || serverError;

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [productResponse, filesResponse, aboutResponse, corpusResponse] = await Promise.all([
        getProduct(token, productId),
        listProductFiles(token, productId),
        getLatestNodeExecution(token, productId, "about-you"),
        getLatestNodeExecution(token, productId, "corpus")
      ]);
      const nextProduct = productResponse?.product ?? productResponse;
      setProduct(nextProduct);
      setPromiseDraft(nextProduct?.promise ?? nextProduct?.description ?? "");
      setBriefSpec(nextProduct?.brief_spec ?? null);
      setDocuments(filesResponse?.files ?? filesResponse?.documents ?? []);
      setAboutYou(aboutResponse?.status === "not_started" ? null : aboutResponse);
      setCorpus(corpusResponse?.status === "not_started" ? null : corpusResponse);
      setState((current) => ({ ...current, loading: false }));
    } catch (nextError) {
      setState((current) => ({ ...current, loading: false, error: messageOf(nextError, t("workspaceLoadError")) }));
    }
  }, [productId, t, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!isExecutionActive(aboutYou) && !isExecutionActive(corpus)) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const node = isExecutionActive(aboutYou) ? "about-you" : "corpus";
        const next = await getLatestNodeExecution(token, productId, node);
        if (cancelled) return;
        if (node === "about-you") setAboutYou(next?.status === "not_started" ? null : next);
        else setCorpus(next?.status === "not_started" ? null : next);
      } catch (nextError) {
        if (!cancelled) setState((current) => ({ ...current, error: messageOf(nextError, t("workspaceLoadError")) }));
      }
    };
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [aboutYou, corpus, productId, t, token]);

  useEffect(() => {
    const requested = TAB_KEYS.includes(tab) ? tab : "files";
    if (state.loading || !product) return;
    const step = workflow.steps[requested];
    const next = step?.enabled ? requested : workflow.current;
    setSelectedTab(next);
    if (next !== requested) navigate(`/studio/products/${encodeURIComponent(productId)}/${next}`);
  }, [navigate, product, productId, state.loading, tab, workflow]);

  function goTab(nextTab) {
    if (!TAB_KEYS.includes(nextTab) || !workflow.steps[nextTab]?.enabled) return;
    setSelectedTab(nextTab);
    navigate(`/studio/products/${encodeURIComponent(productId)}/${nextTab}`);
  }

  async function upload(files) {
    if (!files?.length) return;
    retryActionRef.current = () => upload(files);
    setState((current) => ({ ...current, busy: "upload", error: "", notice: "" }));
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await uploadProductFile(token, productId, file));
      setDocuments((current) => [...uploaded.map((item) => item.file ?? item), ...current]);
      retryActionRef.current = null;
      setState((current) => ({ ...current, notice: t("filesReady", uploaded.length) }));
    } catch (nextError) {
      setState((current) => ({ ...current, error: messageOf(nextError, t("fileStatus_error")) }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  async function removeFile(file) {
    const fileId = file?.id ?? file?.file_id;
    if (!fileId) return;
    if (typeof globalThis.confirm === "function" && !globalThis.confirm(t("confirmRemoveFile"))) return;
    retryActionRef.current = () => removeFile(file);
    setState((current) => ({ ...current, busy: "delete", error: "", notice: "" }));
    try {
      await deleteProductFile(token, productId, fileId);
      setDocuments((current) => current.filter((item) => (item.id ?? item.file_id) !== fileId));
      retryActionRef.current = null;
      setState((current) => ({ ...current, notice: t("fileRemoved") }));
    } catch (nextError) {
      setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  async function savePromise(event) {
    event?.preventDefault();
    const promise = promiseDraft.trim();
    if (!promise || !product) return;
    retryActionRef.current = () => savePromise();
    setState((current) => ({ ...current, busy: "product-promise", error: "", notice: "" }));
    try {
      const savedResponse = await updateProductPromise(token, product, promise);
      const saved = savedResponse?.product ?? savedResponse;
      setProduct((current) => ({ ...current, ...saved, promise }));
      setPromiseDraft(saved?.promise ?? promise);
      retryActionRef.current = null;
      setState((current) => ({ ...current, notice: t("productPromiseSaved") }));
    } catch (nextError) {
      setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  async function startAboutYou(executionId = `about_you_${crypto.randomUUID()}`, idempotencyKey = crypto.randomUUID()) {
    const fileIds = documents.map((file) => file.id ?? file.file_id).filter(Boolean);
    if (!fileIds.length) return;
    retryActionRef.current = () => startAboutYou(executionId, idempotencyKey);
    setState((current) => ({ ...current, busy: "about-you", error: "", notice: "" }));
    try {
      const next = await startAboutYouNode(token, productId, fileIds, executionId, idempotencyKey);
      setAboutYou(next);
      retryActionRef.current = null;
      goTab("about-you");
    } catch (nextError) {
      setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  async function startCorpus(aboutYouRef, executionId = `corpus_${crypto.randomUUID()}`, idempotencyKey = crypto.randomUUID()) {
    const fileIds = documents.map((file) => file.id ?? file.file_id).filter(Boolean);
    retryActionRef.current = () => startCorpus(aboutYouRef, executionId, idempotencyKey);
    setState((current) => ({ ...current, busy: "corpus", error: "", notice: "" }));
    try {
      const next = await startCorpusNode(token, productId, fileIds, aboutYouRef, executionId, idempotencyKey);
      setCorpus(next);
      retryActionRef.current = null;
      // The server accepted the handoff, so navigate immediately. `workflow`
      // can still describe the pre-handoff render for this event loop tick.
      setSelectedTab("corpus");
      navigate(`/studio/products/${encodeURIComponent(productId)}/corpus`);
    } catch (nextError) {
      setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  async function retryFailedNode() {
    if (isExecutionError(aboutYou)) {
      const executionId = aboutYou.status === "max_rounds" ? undefined : aboutYou.execution_id;
      const retryKey = executionId ? `retry:about-you:${executionId}` : undefined;
      return startAboutYou(executionId, retryKey);
    }
    if (isExecutionError(corpus) && aboutYou?.handoff_ref) {
      const executionId = corpus.status === "max_rounds" ? undefined : corpus.execution_id;
      const retryKey = executionId ? `retry:corpus:${executionId}` : undefined;
      return startCorpus(aboutYou.handoff_ref, executionId, retryKey);
    }
    if (retryActionRef.current) return retryActionRef.current();
    return refresh();
  }

  if (state.loading && !product) return <section className="cpv2-loading" aria-busy="true"><Skeleton lines={5} /></section>;
  if (!product) return <section className="cpv2-workspace-error"><InlineAlert tone="error">{error || t("workspaceLoadError")}</InlineAlert><Button type="button" onClick={() => void refresh()}>{t("retry")}</Button></section>;

  return <section className="cpv2-product-workspace">
    <PageHeader className="cpv2-workspace-header" label={product.status === "published" ? t("published") : t("product")} title={product.name ?? t("product")} body={product.promise ?? product.description ?? ""} />
    <form className="cpv2-product-promise" onSubmit={(event) => { void savePromise(event); }}>
      <FormField label={t("whatProductDelivers")} required>
        <Textarea value={promiseDraft} onChange={(event) => setPromiseDraft(event.target.value)} required />
      </FormField>
      <Button type="submit" loading={state.busy === "product-promise"} disabled={Boolean(state.busy) || !promiseDraft.trim()}>{t("saveProductPromise")}</Button>
    </form>
    <div className="cpv2-workspace-tabs" role="tablist" aria-label={t("productWorkflow")}>
      {TAB_KEYS.map((key) => {
        const step = workflow.steps[key];
      const label = key === "about-you" ? t("aboutYou") : t(key);
        return <button key={key} type="button" role="tab" aria-selected={selectedTab === key} aria-disabled={!step.enabled} aria-busy={step.loading} aria-invalid={step.failed || undefined} className={`${selectedTab === key ? "is-active" : ""}${!step.enabled ? " is-disabled" : ""}${step.failed ? " is-failed" : ""}`} disabled={!step.enabled} onClick={() => goTab(key)}><span>{label}</span>{step.loading ? <span className="cpv2-tab-spinner" aria-label={t("loading")} /> : null}</button>;
      })}
    </div>
    {error ? <InlineAlert tone="error"><div className="cpv2-error-bar"><span>{error}</span>{(isExecutionError(aboutYou) || isExecutionError(corpus) || state.error) ? <Button type="button" variant="secondary" loading={Boolean(state.busy)} onClick={() => void retryFailedNode()}>{t("retry")}</Button> : null}</div></InlineAlert> : null}
    {state.notice ? <InlineAlert className="cpv2-inline-feedback" tone="success">{state.notice}</InlineAlert> : null}
    {selectedTab === "files" ? <FilesPanel t={t} documents={documents} busy={state.busy} onUpload={upload} onStart={() => void startAboutYou()} onRetry={() => void retryFailedNode()} onDelete={removeFile} hasExecution={Boolean(aboutYou)} /> : null}
    {selectedTab === "about-you" ? <AboutYouPanel t={t} locale={locale} execution={aboutYou} corpus={corpus} busy={state.busy} onSubmit={(answers) => void saveAnswers(answers, startCorpus, token, productId, aboutYou, setAboutYou, setState, t, retryActionRef)} onRetry={() => void retryFailedNode()} onFiles={() => goTab("files")} /> : null}
    {selectedTab === "corpus" ? <CorpusPanel t={t} locale={locale} execution={corpus} aboutYou={aboutYou} busy={state.busy} onRetry={() => void retryFailedNode()} /> : null}
    {selectedTab === "brief" ? <BriefPanel t={t} token={token} product={product} briefSpec={briefSpec} busy={state.busy} onRetryAction={(action) => { retryActionRef.current = action; }} onSaved={(nextProduct) => { retryActionRef.current = null; const saved = nextProduct?.product ?? nextProduct; setProduct((current) => ({ ...current, ...saved })); setBriefSpec(saved?.brief_spec ?? null); setState((current) => ({ ...current, notice: t("briefSaved") })); }} onError={(nextError) => setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }))} /> : null}
    {selectedTab === "complete" ? <CompletePanel t={t} product={product} briefSpec={briefSpec} corpus={corpus} busy={state.busy} setBusy={(busy) => setState((current) => ({ ...current, busy }))} token={token} productId={productId} onRetryAction={(action) => { retryActionRef.current = action; }} onPublished={refresh} onBrief={() => goTab("brief")} onError={(nextError) => setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }))} /> : null}
  </section>;
}

async function saveAnswers(answers, startCorpus, token, productId, aboutYou, setAboutYou, setState, t, retryActionRef, corpusExecutionId = `corpus_${crypto.randomUUID()}`, corpusIdempotencyKey = crypto.randomUUID(), answersIdempotencyKey = crypto.randomUUID()) {
  retryActionRef.current = () => saveAnswers(answers, startCorpus, token, productId, aboutYou, setAboutYou, setState, t, retryActionRef, corpusExecutionId, corpusIdempotencyKey, answersIdempotencyKey);
  setState((current) => ({ ...current, busy: "answers", error: "", notice: "" }));
  try {
    const saved = await saveAboutYouNodeAnswers(token, productId, aboutYou.execution_id, answers, answersIdempotencyKey);
    const nextAboutYou = { ...aboutYou, status: "handoff_saved", handoff_ref: saved.about_you_ref };
    setAboutYou(nextAboutYou);
    await startCorpus(saved.about_you_ref, corpusExecutionId, corpusIdempotencyKey);
    retryActionRef.current = null;
  } catch (nextError) {
    setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }));
  } finally {
    setState((current) => ({ ...current, busy: "" }));
  }
}

function FilesPanel({ t, documents, busy, onUpload, onStart, onDelete, hasExecution }) {
  return <section className="cpv2-workspace-panel">
    <div className="cpv2-panel-heading"><div><h2>{t("files")}</h2><p>{t("giveMaterial")}</p><small>{t("sourceNote")}</small></div><StatusTag tone="neutral">{documents.length} {t("files")}</StatusTag></div>
    <label className={`cpv2-upload-dropzone${busy ? " is-disabled" : ""}`}>
      <span className="cpv2-upload-dropzone-icon" aria-hidden="true">↑</span>
      <span className="cpv2-upload-dropzone-copy"><strong>{t("uploadFiles")}</strong><small>{t("uploadHint")}</small></span>
      <span className="cpv2-upload-button">{t("chooseFiles")}</span>
      <input className="cpv2-file-input" type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.pptx,.csv,.tsv,.txt,.md,.json,.html,.htm" onChange={(event) => { void onUpload([...event.target.files]); event.target.value = ""; }} disabled={Boolean(busy)} />
    </label>
    {!documents.length ? <p className="cpv2-empty-inline">{t("noFilesYet")}</p> : <ul className="cpv2-file-list">{documents.map((file) => <li key={file.id ?? file.file_id ?? file.display_name}><span>{file.display_name ?? file.name ?? t("unnamedFile")}</span><StatusTag tone={file.status === "error" ? "error" : "success"}>{file.status ?? t("ready")}</StatusTag><Button type="button" variant="link" disabled={Boolean(busy)} onClick={() => void onDelete(file)}>{t("removeFile")}</Button></li>)}</ul>}
    <div className="cpv2-workspace-actions"><Button type="button" loading={busy === "about-you"} disabled={!documents.length || Boolean(busy)} onClick={onStart}>{hasExecution ? t("continueWithFiles") : t("startDistillation")}</Button></div>
  </section>;
}

function AboutYouPanel({ t, locale, execution, corpus, busy, onSubmit, onRetry, onFiles }) {
  const questions = execution?.output?.questions ?? [];
  const [answers, setAnswers] = useState({});
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setAnswers((current) => Object.fromEntries(questions.map((question) => [question.question, current[question.question] ?? ""])));
    setActiveIndex(0);
  }, [execution?.execution_id, questions.length]);
  if (!execution) return <EmptyNodePanel title={t("aboutYou")} body={t("noQuestions")} onAction={onFiles} action={t("addSourceFiles")} />;
  if (isExecutionActive(execution)) return <NodeProgressPanel locale={locale} node="about-you" title={t("aboutYou")} execution={execution} />;
  if (isExecutionError(execution)) return <NodeErrorPanel t={t} title={t("aboutYou")} execution={execution} onRetry={onRetry} />;
  if (!questions.length) return <EmptyNodePanel title={t("aboutYou")} body={t("noQuestions")} onAction={onFiles} action={t("addSourceFiles")} />;
  if (execution.status === "handoff_saved") {
    const corpusFinished = corpus?.status === "completed" && Boolean(corpus.output_ref);
    if (corpusFinished) {
      return <section className="cpv2-workspace-panel" role="status"><StatusTag tone="success">{t("saved")}</StatusTag><h2>{t("aboutYou")}</h2><p>{t("answersSaved")}</p></section>;
    }
    if (isExecutionActive(corpus)) return <NodeProgressPanel locale={locale} node="corpus" title={t("corpus")} execution={corpus} />;
    return <NodeHandoffPanel locale={locale} node="corpus" title={t("corpus")} busy={busy === "answers" || busy === "corpus"} />;
  }
  const question = questions[activeIndex];
  const answer = String(answers[question.question] ?? "");
  const selectedOption = question.options.includes(answer) ? answer : "";
  const isLastQuestion = activeIndex === questions.length - 1;
  const canAdvance = Boolean(answer.trim());
  const setAnswer = (value) => setAnswers((current) => ({ ...current, [question.question]: value }));
  const submitAll = () => onSubmit(questions.map((item) => ({ question: item.question, answer: String(answers[item.question] ?? "").trim() })));
  return <section className="cpv2-workspace-panel cpv2-about-you-panel">
    <div className="cpv2-panel-heading"><div><h2>{t("aboutYou")}</h2><p>{t("helpUnderstand")}</p></div><StatusTag tone="neutral">{questions.length}</StatusTag></div>
    <article className="cpv2-about-you-question" aria-live="polite"><span className="cpv2-review-label">{t("questionOf", activeIndex + 1, questions.length)}</span><h3>{question.question}</h3><RadioGroup label={question.question} value={selectedOption} options={question.options.map((option) => ({ value: option, label: option }))} onValueChange={setAnswer} className="cpv2-about-you-options" /><FormField label={t("other")}><Textarea value={selectedOption ? "" : answer} placeholder={t("addContext")} onChange={(event) => setAnswer(event.target.value)} /></FormField></article>
    <div className="cpv2-about-you-navigation"><Button type="button" variant="secondary" disabled={Boolean(busy) || activeIndex === 0} onClick={() => setActiveIndex((index) => index - 1)}>{t("previous")}</Button><span aria-hidden="true">{activeIndex + 1} / {questions.length}</span><Button type="button" loading={busy === "answers"} disabled={Boolean(busy) || !canAdvance} onClick={() => { if (isLastQuestion) submitAll(); else setActiveIndex((index) => index + 1); }}>{isLastQuestion ? t("continueToCorpus") : t("next")}</Button></div>
  </section>;
}

function CorpusPanel({ t, locale, execution, aboutYou, busy, onRetry }) {
  if (!execution && aboutYou?.status === "handoff_saved") return <NodeHandoffPanel locale={locale} node="corpus" title={t("corpus")} busy={busy === "answers" || busy === "corpus"} />;
  if (!execution) return <EmptyNodePanel title={t("corpus")} body={t("notReady")} />;
  if (isExecutionActive(execution)) return <NodeProgressPanel locale={locale} node="corpus" title={t("corpus")} execution={execution} />;
  if (isExecutionError(execution)) return <NodeErrorPanel t={t} title={t("corpus")} execution={execution} onRetry={onRetry} busy={busy} />;
  const output = execution.output;
  return <section className="cpv2-workspace-panel cpv2-corpus-panel"><div className="cpv2-panel-heading"><div><h2>{t("corpus")}</h2><p>{t("fullCorpus")}</p></div><StatusTag tone="success">{t("ready")}</StatusTag></div>{output ? <><article className="cpv2-corpus-block cpv2-corpus-system"><div className="cpv2-corpus-block-heading"><h3>System instructions</h3><span>{t("ready")}</span></div><pre>{output.system_instructions}</pre></article><section className="cpv2-corpus-block"><div className="cpv2-corpus-block-heading"><h3>Skills</h3><span>{output.skills?.length ?? 0}</span></div><div className="cpv2-corpus-grid">{output.skills?.map((skill) => <details className="cpv2-corpus-item" key={skill.id}><summary>{skill.title}</summary><p>{skill.instruction}</p></details>)}</div></section><section className="cpv2-corpus-block"><div className="cpv2-corpus-block-heading"><h3>Knowledge</h3><span>{output.knowledge?.length ?? 0}</span></div><div className="cpv2-corpus-grid">{output.knowledge?.map((item) => <details className="cpv2-corpus-item" key={item.id}><summary>{item.title}</summary><p>{item.content}</p></details>)}</div></section></> : <p>{t("corpusUnavailable")}</p>}</section>;
}

function BriefPanel({ t, token, product, briefSpec, busy, onRetryAction, onSaved, onError }) {
  const [fields, setFields] = useState(() => briefSpec?.fields ?? []);
  const [saving, setSaving] = useState(false);
  useEffect(() => setFields(briefSpec?.fields ?? []), [briefSpec]);
  function add() { setFields((current) => [...current, { id: nextBriefFieldId(current), label: "", required: false }]); }
  async function saveFields(nextFields, recover = false) {
    if (!nextFields.length || nextFields.some((field) => !field.label.trim())) return;
    onRetryAction?.(() => saveFields(nextFields, true));
    setSaving(true);
    try {
      const currentResponse = recover ? await getProduct(token, product.id ?? product.product_id) : undefined;
      const currentProduct = recover ? (currentResponse?.product ?? currentResponse) : product;
      onSaved(await saveProductBriefSpec(token, currentProduct, { contract_version: "1", fields: nextFields }));
    }
    catch (nextError) { onError(nextError); }
    finally { setSaving(false); }
  }
  return <form className="cpv2-workspace-panel cpv2-brief-panel" onSubmit={(event) => { event.preventDefault(); void saveFields(fields); }}><div className="cpv2-panel-heading"><div><h2>{t("briefTitle")}</h2><p>{t("briefBody")}</p></div><Button type="button" variant="secondary" onClick={add} disabled={fields.length >= 16 || saving || Boolean(busy)}>{t("addBriefQuestion")}</Button></div>{fields.map((field, index) => <div className="cpv2-brief-field" key={field.id}><span>{index + 1}</span><FormField label={t("briefQuestion")} required><Textarea value={field.label} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, label: event.target.value } : item))} /></FormField><label><input type="checkbox" checked={field.required} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, required: event.target.checked } : item))} />{t("requiredQuestion")}</label><Button type="button" variant="link" onClick={() => setFields((current) => current.filter((item) => item.id !== field.id))}>{t("removeQuestion")}</Button></div>)}{!fields.length ? <p>{t("briefRequiredBeforePublish")}</p> : null}<div className="cpv2-workspace-actions"><Button type="submit" loading={saving} disabled={saving || Boolean(busy) || !isValidBriefSpec({ contract_version: "1", fields: fields.length ? fields : [{ id: "invalid", label: "", required: false }] })}>{t("saveBriefAndContinue")}</Button></div></form>;
}

function CompletePanel({ t, product, briefSpec, corpus, busy, setBusy, token, productId, onRetryAction, onPublished, onBrief, onError }) {
  const [showDetails, setShowDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const publishIdempotencyKeyRef = useRef(crypto.randomUUID());
  async function publish() {
    if (!corpus?.output_ref || !isValidBriefSpec(briefSpec)) return;
    onRetryAction?.(() => publish());
    setBusy("publish");
    try { await publishCorpusToRegistry(token, productId, { brief_spec: briefSpec }, publishIdempotencyKeyRef.current); onRetryAction?.(null); await onPublished(); }
    catch (nextError) { onError(nextError); }
    finally { setBusy(""); }
  }
  if (product.status === "published" || product.status === "live") return <section className="cpv2-workspace-panel cpv2-complete-panel"><StatusTag tone="success">{t("published")}</StatusTag><h2>{t("complete")}</h2><p>{t("productPublished")}</p></section>;
  if (!corpus?.output_ref) return <EmptyNodePanel title={t("complete")} body={t("notReady")} />;
  return <section className="cpv2-workspace-panel cpv2-complete-panel"><h2>{t("complete")}</h2><p>{product.promise ?? product.description ?? ""}</p>{showDetails && corpus.output ? <CorpusPanel t={t} execution={corpus} /> : null}{!isValidBriefSpec(briefSpec) ? <div className="cpv2-complete-brief-required"><p>{t("briefRequiredBeforePublish")}</p><Button type="button" variant="secondary" onClick={onBrief}>{t("brief")}</Button></div> : confirming ? <div className="cpv2-confirm cpv2-confirm-publish" role="alert"><div><p><strong>{t("publishCandidateConfirm")}</strong></p><small>{t("productPublished")}</small></div><Button type="button" variant="secondary" onClick={() => setConfirming(false)}>{t("cancel")}</Button><Button type="button" loading={busy === "publish"} disabled={Boolean(busy)} onClick={() => void publish()}>{t("confirmPublish")}</Button></div> : <div className="cpv2-workspace-actions"><Button type="button" variant="link" onClick={() => setShowDetails((current) => !current)}>{t("viewProductDetails")}</Button><Button type="button" disabled={Boolean(busy)} onClick={() => setConfirming(true)}>{t("publishProduct")}</Button></div>}</section>;
}

function NodeProgressPanel({ locale, node, title, execution }) {
  return <NodeCompanionPanel locale={locale} node={node} title={title} execution={execution} state="working" busy />;
}

function NodeHandoffPanel({ locale, node, title, busy }) {
  return <NodeCompanionPanel locale={locale} node={node} title={title} state="handoff" busy={busy} />;
}

function NodeCompanionPanel({ locale, node, title, execution, state, busy }) {
  const tips = getCreatorNodeTips(locale, node);
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => setTipIndex(0), [execution?.execution_id, node, state]);
  useEffect(() => {
    if (!busy || tips.length < 2) return undefined;
    const timer = setInterval(() => setTipIndex((current) => (current + 1) % tips.length), 7000);
    return () => clearInterval(timer);
  }, [busy, tips.length]);
  const tip = tips[tipIndex % tips.length];
  const nextTipLabel = locale === "zh" ? "下一条线索" : locale === "ja" ? "次の手がかり" : "Show next clue";
  const roundLabel = execution?.round == null ? null : locale === "zh" ? `第 ${execution.round} 轮` : locale === "ja" ? `ラウンド ${execution.round}` : `Round ${execution.round}`;
  return <section className="cpv2-workspace-panel cpv2-node-progress-panel" aria-busy={busy ? "true" : "false"} data-node={node} data-state={state}>
    <div className={`cpv2-node-companion${busy ? " is-busy" : ""}`}>
      <div className="cpv2-node-gradient" aria-hidden="true" />
      <div className="cpv2-node-companion-copy">
        <div className="cpv2-node-progress-heading"><h2>{title}</h2>{roundLabel ? <span className="cpv2-node-progress-round">{roundLabel}</span> : null}</div>
        <div className="cpv2-node-tip" role="status" aria-live="polite"><p key={`${node}-${tipIndex}`}>{tip}</p><button type="button" onClick={() => setTipIndex((current) => (current + 1) % tips.length)} aria-label={nextTipLabel}><span aria-hidden="true">↗</span></button></div>
      </div>
    </div>
  </section>;
}

function NodeErrorPanel({ t, title, execution, onRetry, busy }) {
  return <section className="cpv2-workspace-panel cpv2-attention-panel"><StatusTag tone="error">{t("versionNeedsAttention")}</StatusTag><h2>{title}</h2><p>{executionError(execution) ?? t("failureDetailsUnavailable")}</p><Button type="button" loading={Boolean(busy)} onClick={onRetry}>{t("retry")}</Button></section>;
}

function EmptyNodePanel({ title, body, action, onAction }) {
  return <section className="cpv2-workspace-panel"><h2>{title}</h2><p>{body}</p>{onAction ? <Button type="button" variant="secondary" onClick={onAction}>{action}</Button> : null}</section>;
}

function nextBriefFieldId(fields) {
  let index = fields.length + 1;
  while (fields.some((field) => field.id === `question-${index}`)) index += 1;
  return `question-${index}`;
}

function messageOf(error, fallback) {
  return String(error?.message ?? error?.detail ?? fallback);
}
