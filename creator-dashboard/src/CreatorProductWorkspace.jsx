import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, FormField, InlineAlert, PageHeader, Skeleton, StatusTag, Textarea } from "@hatch/ui";
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
import "./creatorProductWorkspace.css";

const TAB_KEYS = CREATOR_WORKFLOW_STEPS;

export function CreatorProductWorkspace({ token, productId, tab = "files", navigate, locale = "en" }) {
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [product, setProduct] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [aboutYou, setAboutYou] = useState(null);
  const [corpus, setCorpus] = useState(null);
  const [briefSpec, setBriefSpec] = useState(null);
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

  async function startAboutYou(executionId) {
    const fileIds = documents.map((file) => file.id ?? file.file_id).filter(Boolean);
    if (!fileIds.length) return;
    retryActionRef.current = () => startAboutYou(executionId);
    setState((current) => ({ ...current, busy: "about-you", error: "", notice: "" }));
    try {
      const next = await startAboutYouNode(token, productId, fileIds, executionId);
      setAboutYou(next);
      retryActionRef.current = null;
      goTab("about-you");
    } catch (nextError) {
      setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }));
    } finally {
      setState((current) => ({ ...current, busy: "" }));
    }
  }

  async function startCorpus(aboutYouRef, executionId) {
    const fileIds = documents.map((file) => file.id ?? file.file_id).filter(Boolean);
    retryActionRef.current = () => startCorpus(aboutYouRef, executionId);
    setState((current) => ({ ...current, busy: "corpus", error: "", notice: "" }));
    try {
      const next = await startCorpusNode(token, productId, fileIds, aboutYouRef, executionId);
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
    if (isExecutionError(aboutYou)) return startAboutYou(aboutYou.status === "max_rounds" ? undefined : aboutYou.execution_id);
    if (isExecutionError(corpus) && aboutYou?.handoff_ref) {
      return startCorpus(aboutYou.handoff_ref, corpus.status === "max_rounds" ? undefined : corpus.execution_id);
    }
    if (retryActionRef.current) return retryActionRef.current();
    return refresh();
  }

  if (state.loading && !product) return <section className="cpv2-loading" aria-busy="true"><Skeleton lines={5} /></section>;
  if (!product) return <section className="cpv2-workspace-error"><InlineAlert tone="error">{error || t("workspaceLoadError")}</InlineAlert><Button type="button" onClick={() => void refresh()}>{t("retry")}</Button></section>;

  return <section className="cpv2-product-workspace">
    <PageHeader className="cpv2-workspace-header" label={product.status === "published" ? t("published") : t("product")} title={product.name ?? t("product")} body={product.promise ?? product.description ?? ""} />
    <div className="cpv2-workspace-tabs" role="tablist" aria-label={t("productWorkflow")}>
      {TAB_KEYS.map((key) => {
        const step = workflow.steps[key];
        const label = key === "about-you" ? t("aboutYou") : key === "corpus" ? "Corpus" : t(key);
        return <button key={key} type="button" role="tab" aria-selected={selectedTab === key} aria-disabled={!step.enabled} aria-busy={step.loading} aria-invalid={step.failed || undefined} className={`${selectedTab === key ? "is-active" : ""}${!step.enabled ? " is-disabled" : ""}${step.failed ? " is-failed" : ""}`} disabled={!step.enabled} onClick={() => goTab(key)}><span>{label}</span>{step.loading ? <span className="cpv2-tab-spinner" aria-label={t("waiting")} /> : null}</button>;
      })}
    </div>
    {error ? <InlineAlert tone="error"><div className="cpv2-error-bar"><span>{error}</span>{(isExecutionError(aboutYou) || isExecutionError(corpus) || state.error) ? <Button type="button" variant="secondary" loading={Boolean(state.busy)} onClick={() => void retryFailedNode()}>{t("retry")}</Button> : null}</div></InlineAlert> : null}
    {state.notice ? <InlineAlert className="cpv2-inline-feedback" tone="success">{state.notice}</InlineAlert> : null}
    {selectedTab === "files" ? <FilesPanel t={t} documents={documents} busy={state.busy} onUpload={upload} onStart={() => void startAboutYou()} onRetry={() => void retryFailedNode()} onDelete={removeFile} hasExecution={Boolean(aboutYou)} /> : null}
    {selectedTab === "about-you" ? <AboutYouPanel t={t} execution={aboutYou} busy={state.busy} onSubmit={(answers) => void saveAnswers(answers, startCorpus, token, productId, aboutYou, setAboutYou, setState, t, retryActionRef)} onRetry={() => void retryFailedNode()} onFiles={() => goTab("files")} /> : null}
    {selectedTab === "corpus" ? <CorpusPanel t={t} execution={corpus} busy={state.busy} onRetry={() => void retryFailedNode()} /> : null}
    {selectedTab === "brief" ? <BriefPanel t={t} token={token} product={product} briefSpec={briefSpec} busy={state.busy} onRetryAction={(action) => { retryActionRef.current = action; }} onSaved={(nextProduct) => { retryActionRef.current = null; const saved = nextProduct?.product ?? nextProduct; setProduct((current) => ({ ...current, ...saved })); setBriefSpec(saved?.brief_spec ?? null); setState((current) => ({ ...current, notice: t("briefSaved") })); }} onError={(nextError) => setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }))} /> : null}
    {selectedTab === "complete" ? <CompletePanel t={t} product={product} briefSpec={briefSpec} corpus={corpus} busy={state.busy} setBusy={(busy) => setState((current) => ({ ...current, busy }))} token={token} productId={productId} onRetryAction={(action) => { retryActionRef.current = action; }} onPublished={refresh} onBrief={() => goTab("brief")} onError={(nextError) => setState((current) => ({ ...current, error: messageOf(nextError, t("failureDetailsUnavailable")) }))} /> : null}
  </section>;
}

async function saveAnswers(answers, startCorpus, token, productId, aboutYou, setAboutYou, setState, t, retryActionRef) {
  retryActionRef.current = () => saveAnswers(answers, startCorpus, token, productId, aboutYou, setAboutYou, setState, t, retryActionRef);
  setState((current) => ({ ...current, busy: "answers", error: "", notice: "" }));
  try {
    const saved = await saveAboutYouNodeAnswers(token, productId, aboutYou.execution_id, answers);
    const nextAboutYou = { ...aboutYou, status: "handoff_saved", handoff_ref: saved.about_you_ref };
    setAboutYou(nextAboutYou);
    await startCorpus(saved.about_you_ref);
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
    <label className="cpv2-upload-dropzone"><span>{t("uploadFiles")}</span><input type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.pptx,.csv,.tsv,.txt,.md,.json,.html,.htm" onChange={(event) => { void onUpload([...event.target.files]); event.target.value = ""; }} disabled={Boolean(busy)} /></label>
    {!documents.length ? <p className="cpv2-empty-inline">{t("noFilesYet")}</p> : <ul className="cpv2-file-list">{documents.map((file) => <li key={file.id ?? file.file_id ?? file.display_name}><span>{file.display_name ?? file.name ?? t("unnamedFile")}</span><StatusTag tone={file.status === "error" ? "error" : "success"}>{file.status ?? t("ready")}</StatusTag><Button type="button" variant="link" disabled={Boolean(busy)} onClick={() => void onDelete(file)}>{t("removeFile")}</Button></li>)}</ul>}
    <div className="cpv2-workspace-actions"><Button type="button" loading={busy === "about-you"} disabled={!documents.length || Boolean(busy)} onClick={onStart}>{hasExecution ? t("continueWithFiles") : t("startDistillation")}</Button></div>
  </section>;
}

function AboutYouPanel({ t, execution, busy, onSubmit, onRetry, onFiles }) {
  const questions = execution?.output?.questions ?? [];
  const [answers, setAnswers] = useState({});
  useEffect(() => {
    setAnswers((current) => Object.fromEntries(questions.map((question) => [question.question, current[question.question] ?? ""])));
  }, [execution?.execution_id, questions.length]);
  if (!execution) return <EmptyNodePanel title={t("aboutYou")} body={t("noQuestions")} onAction={onFiles} action={t("addSourceFiles")} />;
  if (isExecutionActive(execution)) return <NodeProgressPanel t={t} title={t("aboutYou")} execution={execution} />;
  if (isExecutionError(execution)) return <NodeErrorPanel t={t} title={t("aboutYou")} execution={execution} onRetry={onRetry} />;
  if (!questions.length) return <EmptyNodePanel title={t("aboutYou")} body={t("noQuestions")} onAction={onFiles} action={t("addSourceFiles")} />;
  if (execution.status === "handoff_saved") return <NodeProgressPanel t={t} title={t("aboutYou")} execution={{ ...execution, status: "completed" }} label="Answers saved. Corpus is starting…" />;
  return <section className="cpv2-workspace-panel cpv2-about-you-panel">
    <div className="cpv2-panel-heading"><div><h2>{t("aboutYou")}</h2><p>{t("helpUnderstand")}</p></div><StatusTag tone="neutral">{questions.length}</StatusTag></div>
    <div className="cpv2-about-you-questions">{questions.map((question, index) => <article key={question.question} className="cpv2-about-you-question"><span className="cpv2-review-label">{t("questionOf", index + 1, questions.length)}</span><h3>{question.question}</h3><div className="cpv2-about-you-options">{question.options.map((option) => <label key={option}><input type="radio" name={`about-you-${index}`} checked={answers[question.question] === option} onChange={() => setAnswers((current) => ({ ...current, [question.question]: option }))} />{option}</label>)}</div><FormField label={t("other")}><Textarea value={question.options.includes(answers[question.question]) ? "" : answers[question.question] ?? ""} placeholder={t("addContext")} onChange={(event) => setAnswers((current) => ({ ...current, [question.question]: event.target.value }))} /></FormField></article>)}</div>
    <div className="cpv2-workspace-actions"><Button type="button" loading={busy === "answers"} disabled={Boolean(busy) || questions.some((question) => !String(answers[question.question] ?? "").trim())} onClick={() => onSubmit(questions.map((question) => ({ question: question.question, answer: answers[question.question].trim() })))}>{t("continueToCorpus")}</Button></div>
  </section>;
}

function CorpusPanel({ t, execution, busy, onRetry }) {
  if (!execution) return <EmptyNodePanel title="Corpus" body={t("waiting")} />;
  if (isExecutionActive(execution)) return <NodeProgressPanel t={t} title="Corpus" execution={execution} />;
  if (isExecutionError(execution)) return <NodeErrorPanel t={t} title="Corpus" execution={execution} onRetry={onRetry} busy={busy} />;
  const output = execution.output;
  return <section className="cpv2-workspace-panel cpv2-corpus-panel"><div className="cpv2-panel-heading"><div><h2>Corpus</h2><p>{t("fullCorpus")}</p></div><StatusTag tone="success">{t("ready")}</StatusTag></div>{output ? <><article className="cpv2-corpus-block"><h3>System instructions</h3><pre>{output.system_instructions}</pre></article><article className="cpv2-corpus-block"><h3>Skills</h3>{output.skills?.map((skill) => <details key={skill.id}><summary>{skill.title}</summary><p>{skill.instruction}</p></details>)}</article><article className="cpv2-corpus-block"><h3>Knowledge</h3>{output.knowledge?.map((item) => <details key={item.id}><summary>{item.title}</summary><p>{item.content}</p></details>)}</article></> : <p>{t("corpusUnavailable")}</p>}</section>;
}

function BriefPanel({ t, token, product, briefSpec, busy, onRetryAction, onSaved, onError }) {
  const [fields, setFields] = useState(() => briefSpec?.fields ?? []);
  const [saving, setSaving] = useState(false);
  useEffect(() => setFields(briefSpec?.fields ?? []), [briefSpec]);
  function add() { setFields((current) => [...current, { id: nextBriefFieldId(current), label: "", required: false }]); }
  async function saveFields(nextFields) {
    if (!nextFields.length || nextFields.some((field) => !field.label.trim())) return;
    onRetryAction?.(() => saveFields(nextFields));
    setSaving(true);
    try { onSaved(await saveProductBriefSpec(token, product, { contract_version: "1", fields: nextFields })); }
    catch (nextError) { onError(nextError); }
    finally { setSaving(false); }
  }
  return <form className="cpv2-workspace-panel cpv2-brief-panel" onSubmit={(event) => { event.preventDefault(); void saveFields(fields); }}><div className="cpv2-panel-heading"><div><h2>{t("briefTitle")}</h2><p>{t("briefBody")}</p></div><Button type="button" variant="secondary" onClick={add} disabled={fields.length >= 16 || saving || Boolean(busy)}>{t("addBriefQuestion")}</Button></div>{fields.map((field, index) => <div className="cpv2-brief-field" key={field.id}><span>{index + 1}</span><FormField label={t("briefQuestion")} required><Textarea value={field.label} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, label: event.target.value } : item))} /></FormField><label><input type="checkbox" checked={field.required} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, required: event.target.checked } : item))} />{t("requiredQuestion")}</label><Button type="button" variant="link" onClick={() => setFields((current) => current.filter((item) => item.id !== field.id))}>{t("removeQuestion")}</Button></div>)}{!fields.length ? <p>{t("briefRequiredBeforePublish")}</p> : null}<div className="cpv2-workspace-actions"><Button type="submit" loading={saving} disabled={saving || Boolean(busy) || !isValidBriefSpec({ contract_version: "1", fields: fields.length ? fields : [{ id: "invalid", label: "", required: false }] })}>{t("saveBriefAndContinue")}</Button></div></form>;
}

function CompletePanel({ t, product, briefSpec, corpus, busy, setBusy, token, productId, onRetryAction, onPublished, onBrief, onError }) {
  const [showDetails, setShowDetails] = useState(false);
  async function publish() {
    if (!corpus?.output_ref || !isValidBriefSpec(briefSpec)) return;
    onRetryAction?.(() => publish());
    setBusy("publish");
    try { await publishCorpusToRegistry(token, productId, { corpus_ref: corpus.output_ref, brief_spec: briefSpec }); onRetryAction?.(null); await onPublished(); }
    catch (nextError) { onError(nextError); }
    finally { setBusy(""); }
  }
  if (product.status === "published") return <section className="cpv2-workspace-panel cpv2-complete-panel"><StatusTag tone="success">{t("published")}</StatusTag><h2>{t("complete")}</h2><p>{t("productPublished")}</p></section>;
  if (!corpus?.output_ref) return <EmptyNodePanel title={t("complete")} body={t("waiting")} />;
  return <section className="cpv2-workspace-panel cpv2-complete-panel"><h2>{t("complete")}</h2><p>{product.promise ?? product.description ?? ""}</p>{showDetails && corpus.output ? <CorpusPanel t={t} execution={corpus} /> : null}{!isValidBriefSpec(briefSpec) ? <div className="cpv2-complete-brief-required"><p>{t("briefRequiredBeforePublish")}</p><Button type="button" variant="secondary" onClick={onBrief}>{t("brief")}</Button></div> : <div className="cpv2-workspace-actions"><Button type="button" variant="link" onClick={() => setShowDetails((current) => !current)}>{t("viewProductDetails")}</Button><Button type="button" loading={busy === "publish"} disabled={Boolean(busy)} onClick={() => void publish()}>{t("publishProduct")}</Button></div>}</section>;
}

function NodeProgressPanel({ t, title, execution, label }) {
  return <section className="cpv2-workspace-panel" aria-busy="true"><StatusTag tone="neutral">{execution.status}</StatusTag><h2>{title}</h2><div className="cpv2-generation-status" role="status" aria-live="polite"><span className="cpv2-loading-spinner" aria-hidden="true" /><span>{label ?? `${t("waiting")} · round ${execution.round ?? 0}`}</span></div></section>;
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
