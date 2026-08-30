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
  StatusTag,
  Textarea
} from "@hatch/ui";
import { createCreatorTranslator } from "./creatorI18n.js";
import {
  createProduct,
  getProduct,
  listProductFiles,
  startFactoryRunFromSources,
  uploadProductFile
} from "./creatorFactory.js";
import {
  canGenerateProductVersion,
  productFileState,
  shouldPollProductFiles
} from "./creatorProductFilesUi.js";

/** Product-owned file area. Files are never global and never attached to a run. */
export function CreatorProductFiles({ token, productId, navigate, locale = "en" }) {
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [product, setProduct] = useState(null);
  const [files, setFiles] = useState([]);
  const [draft, setDraft] = useState({ name: "", promise: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const filesNeedPolling = useMemo(() => shouldPollProductFiles(files), [files]);

  useEffect(() => {
    if (!productId) return undefined;
    let active = true;
    Promise.all([getProduct(token, productId), listProductFiles(token, productId)])
      .then(([nextProduct, nextFiles]) => {
        if (!active) return;
        setProduct(nextProduct?.product ?? nextProduct);
        setFiles(nextFiles.files ?? nextFiles.documents ?? []);
      })
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [token, productId]);

  useEffect(() => {
    if (!productId || !filesNeedPolling) return undefined;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await listProductFiles(token, productId);
        if (!cancelled) setFiles(response.files ?? response.documents ?? []);
      } catch (nextError) {
        if (!cancelled) setError(nextError.message);
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

  const selectedCount = useMemo(() => files.length, [files]);

  async function create(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const created = await createProduct(token, draft);
      const id = created?.product?.id ?? created?.product?.product_id ?? created?.id ?? created?.product_id;
      if (!id) throw new Error(t("productCreatedWithoutId"));
      navigate(`/studio/products/${encodeURIComponent(id)}/files`);
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  async function upload(selected) {
    const selectedFiles = [...(selected ?? [])];
    if (!selectedFiles.length || !product) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const uploaded = [];
      for (const file of selectedFiles) uploaded.push(await uploadProductFile(token, product.id ?? product.product_id, file));
      setFiles((current) => [...uploaded, ...current]);
      setNotice(t("filesAdded", uploaded.length));
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  async function startRun() {
    if (!product || !files.length || busy) return;
    setBusy(true); setError("");
    try {
      const run = await startFactoryRunFromSources(token, product, files.map((file) => file.id));
      navigate(`/studio/products/${encodeURIComponent(product.id ?? product.product_id)}/about-you`);
      return run;
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  if (!productId) {
    return <section className="cpv2-card cpv2-panel cpv2-source-library">
      <BackToProducts navigate={navigate} t={t} />
      <PageHeader label={t("createProduct")} title={t("startProductTitle")} body={t("startProductBody")} />
      {error ? <InlineAlert tone="error" title={t("productCouldNotBeCreated")}>{error}</InlineAlert> : null}
      <form onSubmit={create} className="cpv2-source-product-form">
        <FormField label={t("productName")} required hint={t("productNameHint")}><Input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t("productNameExample")} /></FormField>
        <FormField label={t("whatProductDelivers")} required><Textarea required value={draft.promise} onChange={(event) => setDraft((current) => ({ ...current, promise: event.target.value }))} placeholder={t("describeResult")} /></FormField>
        <Button type="submit" loading={busy}>{t("createProduct")}</Button>
      </form>
    </section>;
  }

  return <section className="cpv2-source-library">
    <BackToProducts navigate={navigate} t={t} />
    <PageHeader label={t("files")} title={product?.name ?? t("productFiles")} body={t("addFilesBody")} />
    {error ? <InlineAlert tone="error" title={t("filesUnavailable")}>{error}</InlineAlert> : null}
    {notice ? <InlineAlert className="cpv2-inline-feedback" tone="success" title={t("filesAddedTitle")}>{notice}</InlineAlert> : null}
    <article className="cpv2-card cpv2-panel">
      <div className="cpv2-source-library-toolbar"><div><span className="cpv2-kicker">{t("productFiles")}</span><h2>{t("filesCount", selectedCount)}</h2></div></div>
      <FileUploader multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.html,.htm,.png,.jpg,.jpeg,.webp" onFiles={upload} disabled={busy} label={t("uploadFiles")} hint={t("localFilesOnly")} className="cpv2-source-uploader" />
      <p className="cpv2-muted">{t("sourceNote")}</p>
      {files.length ? <List items={files} className="cpv2-source-list" ariaLabel={t("productFiles")} renderItem={(file) => { const status = productFileState(file); return <><div><strong>{file.display_name}</strong><small>{file.media_type} · {file.projection?.kind === "image" ? t("imageNative") : t("markdownProjection")}</small></div><StatusTag tone={status === "ready" ? "success" : status === "error" ? "error" : "neutral"}>{t(`fileStatus_${status}`)}</StatusTag></>; }} /> : <EmptyState title={t("noFilesYet")} body={t("firstFileForProduct")} />}
      <div className="cpv2-source-library-actions"><Button type="button" loading={busy} disabled={!canGenerateProductVersion(files) || busy} onClick={() => void startRun()}>{t("generateVersion")}</Button></div>
    </article>
  </section>;
}

function BackToProducts({ navigate, t }) {
  return <Breadcrumbs className="cpv2-breadcrumbs" items={[{ label: t("products"), href: "/studio/products", onClick: (event) => { event.preventDefault(); navigate("/studio/products"); } }]} />;
}
