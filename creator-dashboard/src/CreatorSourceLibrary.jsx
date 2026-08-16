import React, { useEffect, useMemo, useState } from "react";
import {
  Breadcrumbs,
  Button,
  EmptyState,
  FileUploader,
  FormField,
  InlineAlert,
  Input,
  List,
  PageHeader,
  Textarea
} from "@hatch/ui";
import {
  createDistillationTask,
  getDistillationTask,
  listSourceDocuments,
  startFactoryRunFromSources,
  uploadSourceDocument
} from "./creatorFactory.js";

export function CreatorSourceLibrary({ token, taskId, navigate }) {
  const [task, setTask] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [draft, setDraft] = useState({ name: "", brief: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!taskId) return undefined;
    let active = true;
    Promise.all([getDistillationTask(token, taskId), listSourceDocuments(token, taskId)])
      .then(([nextTask, nextDocuments]) => {
        if (!active) return;
        setTask(nextTask);
        setDocuments(nextDocuments.documents ?? []);
      })
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [token, taskId]);

  const selectedCount = useMemo(() => documents.length, [documents]);

  async function createTask(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const created = await createDistillationTask(token, draft);
      navigate(`/studio/tasks/${encodeURIComponent(created.id)}/files`);
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  async function upload(files) {
    const selectedFiles = [...(files ?? [])];
    if (!selectedFiles.length || !task) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const uploaded = [];
      for (const file of selectedFiles) uploaded.push(await uploadSourceDocument(token, task.id, file));
      setDocuments((current) => [...uploaded, ...current]);
      setNotice(`${uploaded.length} file${uploaded.length === 1 ? "" : "s"} uploaded. Original files and projections are retained in this Task's private store.`);
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  async function startRun() {
    if (!task || documents.length === 0 || busy) return;
    setBusy(true); setError("");
    try {
      const run = await startFactoryRunFromSources(token, task, documents.map((document) => document.id));
      navigate(`/studio/factory/runs/${encodeURIComponent(run.id)}`);
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  if (!taskId) {
    return <section className="cpv2-card cpv2-panel cpv2-source-library">
      <BackToProducts navigate={navigate} />
      <PageHeader label="Create Task" title="Create one focused Task." body="Every Task gets its own files. After creation, all uploaded files and revisions stay attached to that Task." />
      {error ? <InlineAlert tone="error" title="Task could not be created">{error}</InlineAlert> : null}
      <form onSubmit={createTask} className="cpv2-source-task-form">
        <FormField label="Task name" required hint="This name is immutable after creation."><Input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Signal Resume Review" /></FormField>
        <FormField label="Task promise" required hint="What does the Buyer provide, and what finished result do they receive?"><Textarea required value={draft.brief} onChange={(event) => setDraft((current) => ({ ...current, brief: event.target.value }))} placeholder="Describe the finished result." /></FormField>
        <Button type="submit" loading={busy}>Create Task</Button>
      </form>
    </section>;
  }

  return <section className="cpv2-source-library">
    <BackToProducts navigate={navigate} />
    <PageHeader label="Task files" title={task?.name ?? "Task files"} body="Upload files for this Task. When you continue, Hatch prepares a private revision from these files." />
    {error ? <InlineAlert tone="error" title="Task files unavailable">{error}</InlineAlert> : null}
    {notice ? <InlineAlert tone="success" title="Upload complete">{notice}</InlineAlert> : null}
    <article className="cpv2-card cpv2-panel">
      <div className="cpv2-source-library-toolbar"><div><span className="cpv2-kicker">Private Task storage</span><h2>{selectedCount} file{selectedCount === 1 ? "" : "s"}</h2></div></div>
      <FileUploader multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.html,.htm,.png,.jpg,.jpeg,.webp" onFiles={upload} disabled={busy} label="Upload files" hint="Local files only; repeat uploads are allowed." className="cpv2-source-uploader" />
      <p className="cpv2-muted">PDF, DOCX, XLSX, CSV, TXT, Markdown, JSON, HTML are projected to Markdown. Images stay native for Kimi K2.6.</p>
      {documents.length ? <List items={documents} className="cpv2-source-list" ariaLabel="Task files" renderItem={(document) => <><div><strong>{document.display_name}</strong><small>{document.media_type} · {document.projection?.kind === "image" ? "native image" : "Markdown projection"}</small></div><span>{document.projection?.sha256?.slice(0, 18) ?? "digest pending"}</span></>} /> : <EmptyState title="No files yet" body="Upload the first file to create this Task's private file area." />}
      <div className="cpv2-source-library-actions"><Button type="button" loading={busy} disabled={!documents.length} onClick={startRun}>Start distillation</Button><Button type="button" variant="secondary" onClick={() => navigate("/studio/factory")}>Open Factory runs</Button></div>
    </article>
  </section>;
}

function BackToProducts({ navigate }) {
  return <Breadcrumbs className="cpv2-breadcrumbs" items={[{ label: "Products", href: "/studio/products", onClick: (event) => { event.preventDefault(); navigate("/studio/products"); } }]} />;
}
