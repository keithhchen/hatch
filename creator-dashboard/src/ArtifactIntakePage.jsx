import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InlineAlert, Input, Progress, Textarea } from "@hatch/ui";
import { AttachButton } from "@hatch/chat/react";
import { ArrowUp, Check, Paperclip, X } from "lucide-react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { intakeStarted, intakeSubmitted } from "./analytics/events.js";
import {
  FORM_FILE_NAME, INTAKE_FILE_ACCEPT, MAX_FILE_BYTES, MAX_INTAKE_FILES, answeredCount, assignNames, buildFormMd, draftStore, fileCount, fileMediaType, isAcceptedFile, submissionIds, validateIntake
} from "./artifactForm.js";
import { BrowserImageAttachments } from "./webChatClient.js";
import { webChatErrorText } from "./webChatI18n.js";

const storage = () => { try { return window.localStorage; } catch { return null; } };

function Choice({ field, value, onChange }) {
  const multi = field.type === "multi";
  const picked = multi ? value ?? [] : value;
  const isOn = option => multi ? picked.includes(option) : picked === option;
  const toggle = option => onChange(multi ? (isOn(option) ? picked.filter(entry => entry !== option) : [...picked, option]) : option);
  return <div className="artifact__options" role={multi ? "group" : "radiogroup"} aria-label={field.label}>
    {field.options.map(option => <button type="button" key={option} role={multi ? "checkbox" : "radio"} aria-checked={isOn(option)} className="artifact__option" onClick={() => toggle(option)}>{option}</button>)}
  </div>;
}

/** The chat composer's attach control and file chips, for a files question. */
function FilesField({ field, files, uploads, disabled, onPick, onRemove, t }) {
  const attachT = (key, values) => t(key === "addImages" ? "artifactAddFiles" : key, values);
  return <div className="artifact__files">
    <AttachButton accept={INTAKE_FILE_ACCEPT} disabled={disabled} onFiles={picked => onPick(field, picked)} t={attachT} />
    {files.length ? <div className="web-chat__images">
      {files.map(file => {
        const upload = uploads.get(file);
        return <span className="web-chat__image-chip" key={`${file.name}-${file.size}-${file.lastModified}`}>
          <Paperclip aria-hidden="true" /><span title={file.name}>{file.name}</span>
          {upload?.status === "uploading" ? <Progress className="artifact__file-progress" value={upload.progress * 100} /> : null}
          {upload?.status === "done" ? <Check aria-hidden="true" /> : null}
          {upload?.status === "error" ? <span className="artifact__file-error">{t("artifactUploadFailed")}{upload.message ? `: ${upload.message}` : ""}</span> : null}
          {disabled ? null : <button type="button" aria-label={t("removeImage", { name: file.name })} onClick={() => onRemove(field, file)}><X aria-hidden="true" /></button>}
        </span>;
      })}
    </div> : null}
  </div>;
}

export function ArtifactIntakePage({ api, definition, productId, productName, draftConversationId, conversationPath, navigate, t, locale }) {
  const analytics = useAnalytics();
  const fields = definition.intake.fields;
  const draft = useMemo(() => draftStore(storage(), productId), [productId]);
  const [answers, setAnswers] = useState(() => draft.load());
  const [files, setFiles] = useState({});
  const [uploads, setUploads] = useState(() => new Map());
  const [notices, setNotices] = useState([]);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const conversationRef = useRef(draftConversationId);
  const uploadedRef = useRef(new Map());
  const preparedRef = useRef(new Map());
  const formUploadedRef = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => { analytics.track(intakeStarted({ agentId: productId })); }, [analytics, productId]);
  useEffect(() => { draft.save(answers); }, [draft, answers]);

  const setAnswer = (field, value) => setAnswers(current => ({ ...current, [field.id]: value }));
  const setUpload = (file, state) => setUploads(current => new Map(current).set(file, state));
  const total = fileCount(fields, files);

  const pick = useCallback((field, picked) => {
    const messages = [];
    const accepted = [];
    let room = MAX_INTAKE_FILES - total;
    const held = Object.values(files).flat();
    const same = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
    for (const file of picked) {
      // The same file chosen again is the file already held, never a second copy under a new name.
      if (held.some(entry => same(entry, file)) || accepted.some(entry => same(entry, file))) continue;
      if (!isAcceptedFile(file)) messages.push(t("artifactFileRejected", { name: file.name }));
      else if (file.size > MAX_FILE_BYTES) messages.push(t("artifactFileTooLarge", { name: file.name }));
      else if (room <= 0) { messages.push(t("artifactFileLimit", { max: MAX_INTAKE_FILES })); break; }
      else { accepted.push(file); room -= 1; }
    }
    setNotices([...new Set(messages)]);
    if (accepted.length) setFiles(current => ({ ...current, [field.id]: [...(current[field.id] ?? []), ...accepted] }));
  }, [t, total]);

  const remove = (field, file) => setFiles(current => ({ ...current, [field.id]: current[field.id].filter(entry => entry !== file) }));

  /** Images shrunk once, then every file named as the Runtime will name it: same name gets " (2)", " (3)" in upload order. */
  async function prepareFiles() {
    const prepared = [];
    for (const field of fields) {
      for (const original of files[field.id] ?? []) {
        let entry = preparedRef.current.get(original);
        if (!entry) {
          try {
            const file = fileMediaType(original).startsWith("image/") ? await BrowserImageAttachments.compress(original) : original;
            entry = { file, mediaType: fileMediaType(file) };
            preparedRef.current.set(original, entry);
          } catch (cause) {
            setUpload(original, { status: "error", message: cause.message });
            throw cause;
          }
        }
        prepared.push({ field, original, ...entry });
      }
    }
    const names = assignNames([FORM_FILE_NAME, ...prepared.map(entry => entry.file.name)]).slice(1);
    return prepared.map((entry, index) => ({ ...entry, name: names[index] }));
  }

  /** Each file once: a retry after a failure re-sends only what did not arrive. */
  async function uploadFiles(conversationId, prepared) {
    for (const { original, file, name, mediaType } of prepared) {
      if (uploadedRef.current.has(original)) continue;
      setUpload(original, { status: "uploading", progress: 0 });
      try {
        await api.upload(conversationId, file, name, mediaType, progress => setUpload(original, { status: "uploading", progress }));
        uploadedRef.current.set(original, name);
        setUpload(original, { status: "done" });
      } catch (cause) {
        setUpload(original, { status: "error", message: cause.message });
        throw cause;
      }
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (busyRef.current) return;
    const found = validateIntake(fields, answers, files);
    setProblems(found);
    setError(null);
    if (found.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // One key per submission, kept until it succeeds: a double click, refresh or retry is the same conversation and the same run.
      const submissionKey = draft.submissionKey(() => crypto.randomUUID());
      conversationRef.current ??= await api.createConversation(productId, submissionKey);
      const conversationId = conversationRef.current;
      const prepared = await prepareFiles();
      const fileNames = {};
      for (const { field, name } of prepared) (fileNames[field.id] ??= []).push(name);
      // The form is the first file of the conversation (问卷.md) and the first message's text, which lists every file by path; no message carries attachments.
      const formMd = buildFormMd(productName, fields, answers, fileNames);
      if (formUploadedRef.current !== formMd) {
        await api.upload(conversationId, new File([formMd], FORM_FILE_NAME, { type: "text/markdown" }), FORM_FILE_NAME, "text/markdown", () => {});
        formUploadedRef.current = formMd;
      }
      await uploadFiles(conversationId, prepared);
      await api.sendFirstMessage(conversationId, formMd, submissionIds(submissionKey));
      analytics.track(intakeSubmitted({ agentId: productId, answered: answeredCount(fields, answers, files), files: fileCount(fields, files) }));
      draft.clear();
      navigate(conversationPath(conversationId));
    } catch (cause) {
      setError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const missing = problems.filter(problem => problem.code === "required").map(problem => fields.find(field => field.id === problem.field).label);
  const done = answeredCount(fields, answers, files);
  return <>
    <div className="web-chat__messages"><div className="web-chat__thread">
      <form id="artifact-intake" className="artifact__form" onSubmit={submit} noValidate>
        <div className="artifact__progress"><Progress value={fields.length ? done / fields.length * 100 : 0} label={t("artifactProgress", { done, total: fields.length })} /></div>
        {fields.map(field => {
          const invalid = problems.some(problem => problem.field === field.id);
          return <section key={field.id} className={`artifact__field${invalid ? " is-invalid" : ""}`} data-field={field.id}>
            <h2 className="web-chat__brief-label">{field.label}{field.required ? <em>{t("required")}</em> : null}</h2>
            {field.help ? <p className="artifact__help">{field.help}</p> : null}
            {field.type === "text" ? <Input aria-label={field.label} value={answers[field.id] ?? ""} maxLength={2000} disabled={busy} onChange={event => setAnswer(field, event.target.value)} /> : null}
            {field.type === "long_text" ? <Textarea aria-label={field.label} rows={5} value={answers[field.id] ?? ""} maxLength={32000} disabled={busy} onChange={event => setAnswer(field, event.target.value)} /> : null}
            {field.type === "choice" || field.type === "multi" ? <Choice field={field} value={answers[field.id]} onChange={value => setAnswer(field, value)} /> : null}
            {field.type === "files" ? <>
              <FilesField field={field} files={files[field.id] ?? []} uploads={uploads} disabled={busy} onPick={pick} onRemove={remove} t={t} />
              <Textarea aria-label={t("artifactFileNote")} placeholder={t("artifactFileNote")} rows={3} value={answers[field.id] ?? ""} maxLength={32000} disabled={busy} onChange={event => setAnswer(field, event.target.value)} />
            </> : null}
          </section>;
        })}
      </form>
    </div></div>
    <div className="web-chat__dock">
      {notices.map(notice => <InlineAlert key={notice} tone="warning">{notice}</InlineAlert>)}
      {missing.length ? <InlineAlert tone="error">{t("artifactMissingRequired", { fields: missing.join("、") })}</InlineAlert> : null}
      {problems.some(problem => problem.code === "fileLimit") ? <InlineAlert tone="error">{t("artifactFileLimit", { max: MAX_INTAKE_FILES })}</InlineAlert> : null}
      {error ? <InlineAlert tone="error">{webChatErrorText(error, locale)}</InlineAlert> : null}
      <div className="artifact__bar">
        {total ? <span className="artifact__count">{t("artifactFilesCount", { count: total, max: MAX_INTAKE_FILES })}</span> : <span />}
        <button type="submit" form="artifact-intake" className="web-chat__button web-chat__button--yolk" disabled={busy}><span>{busy ? t("artifactSubmitting") : t("artifactSubmit")}</span><ArrowUp aria-hidden="true" /></button>
      </div>
    </div>
  </>;
}
