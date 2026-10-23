// One workspace per Agent: header (name, status, public link) and two tabs —
// Build (Factory path) and Publish. Studio shows no version history.
// Every control calls an existing Creator endpoint; nothing is simulated.
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button, FormField, Input, Textarea } from "@hatch/ui";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { creatorFactoryPath, creatorProductPath } from "./creatorRoutes.js";
import { isProductLive } from "./studioPath.js";
import {
  InlineError, LoadingState, PageBoundary, RouteProblem, SectionHead, StatusPill, SuccessNotice, STUDIO_ROOT,
  absoluteUrl, arrayOf, dateTime, friendlyError, idOf, mutationKey, productName, publicPathOf, safePublicUrl, unwrap, useCopy, useRemote
} from "./studioShellKit.jsx";

const TABS = [
  { value: "build", label: "sxTabBuild" },
  { value: "publish", label: "sxTabPublish" }
];

export function StudioAgentWorkspace({ route, request, navigate, locale, t, profile, renderBuild }) {
  const productId = route.productId;
  const productPath = `/v1/creator/products/${encodeURIComponent(productId)}`;
  const resource = useRemote(request, productPath);
  const product = resource.data ? unwrap(resource.data, "product") : null;
  const tab = route.tab ?? "build";

  if (resource.state === "error") return <RouteProblem title={t("workspaceLoadError")} body={friendlyError(resource.error, t)} action={t("retry")} onAction={resource.retry} />;
  const live = isProductLive(product);
  const ctx = { product, productId, request, navigate, locale, t, profile, reload: resource.retry };

  return <div className={`sx-agent${tab === "build" ? " sx-agent--build" : ""}`}>
    <header className="sx-agent__head">
      <button type="button" className="sx-crumb" onClick={() => navigate(`${STUDIO_ROOT}/products`)}><ArrowLeft aria-hidden="true" />{t("sxNavAgents")}</button>
      <div className="sx-agent__row">
        <div className="sx-agent__title">
          <h1>{product ? productName(product, t) : "…"}</h1>
          {product ? <StatusPill live={live} t={t} /> : null}
        </div>
        {product ? <AgentHeaderActions product={product} live={live} t={t} /> : null}
      </div>
      <nav className="sx-tabs" aria-label={t("sxAgentTabs")}>
        {TABS.map((item) => <a key={item.value} href={creatorProductPath(productId, item.value)} aria-current={tab === item.value ? "page" : undefined} className={tab === item.value ? "is-active" : ""} onClick={(event) => { event.preventDefault(); navigate(creatorProductPath(productId, item.value)); }}>
          {t(item.label)}
        </a>)}
      </nav>
    </header>
    <div className="sx-agent__body">
      {tab === "build" ? renderBuild(product)
        : !product ? <LoadingState t={t} />
        : <PublishTab {...ctx} />}
    </div>
  </div>;
}

function AgentHeaderActions({ product, live, t }) {
  const href = live ? safePublicUrl(publicPathOf(product)) : null;
  return href ? <div className="sx-agent__actions">
    <Button asChild className="web-btn-yolk" trailing={<ExternalLink aria-hidden="true" />}><a href={href} target="_blank" rel="noreferrer">{t("viewStorefront")}</a></Button>
  </div> : null;
}

/* ---------- Publish ---------- */

function PublishTab({ product, productId, request, navigate, locale, t, profile, reload }) {
  const base = `/v1/creator/products/${encodeURIComponent(productId)}`;
  const status = useRemote(request, `${base}/live`);
  const preview = useRemote(request, `${base}/storefront-preview`);
  const reloadAll = () => { reload(); status.retry(); preview.retry(); };
  const publicUrl = (status.state === "ready" || status.state === "refreshing") ? status.data?.public_url ?? null : null;
  // One page: a sticky status bar (publish + share link), edits on the left, the client page on the right.
  return <div className="sx-publish">
    <PublishStatus status={status} base={base} productId={productId} request={request} navigate={navigate} locale={locale} t={t} onPublished={reloadAll} publicUrl={publicUrl ?? publicPathOf(product)} />
    <div className="sx-publish__grid">
      <div className="sx-publish__edit">
        <DetailsForm product={product} productId={productId} request={request} t={t} onSaved={reloadAll} />
        <BriefSpecForm product={product} productId={productId} request={request} t={t} onSaved={reloadAll} />
      </div>
      <section className="sx-publish__preview" aria-labelledby="sx-preview-title">
        <PreviewPane resource={preview} profile={profile} t={t} />
      </section>
    </div>
  </div>;
}

function PublishStatus({ status, base, productId, request, navigate, locale, t, onPublished, publicUrl }) {
  const [state, setState] = useState({ busy: false, error: "", result: null });
  const { copied, copy } = useCopy();
  if (status.state === "loading" || status.state === "idle") return <LoadingState t={t} />;
  if (status.state === "error") return <section className="sx-summary is-error" role="alert">
    <div><h2>{t("sxPublishStatusError")}</h2><p>{friendlyError(status.error, t)}</p></div>
    <Button variant="secondary" type="button" onClick={status.retry}>{t("retry")}</Button>
  </section>;
  const info = status.data ?? {};
  const live = info.is_live === true;
  const pending = arrayOf(info.pending_changes);
  async function publish() {
    setState({ busy: true, error: "", result: null });
    try {
      const result = await request(`${base}/live`, { method: "POST", headers: { "Idempotency-Key": mutationKey() }, body: JSON.stringify({}) });
      setState({ busy: false, error: "", result });
      onPublished();
    } catch (error) {
      setState({ busy: false, error: error.code === "system_missing" ? t("sxBuildIncomplete") : (error.message || friendlyError(error, t)), result: null });
    }
  }
  const shareUrl = live ? (state.result?.public_url ?? publicUrl) : null;
  const goToBuild = () => navigate(creatorFactoryPath(productId, "build", "generation"));
  return <section className={`sx-summary${live ? " is-live" : ""}`}>
    <div>
      <h2>{live ? t("sxStatusLive") : t("sxStatusDraft")}</h2>
      {live && info.published_at ? <p>{t("sxPublishedAt", dateTime(info.published_at, locale))}</p> : null}
      {live && pending.length ? <p className="sx-summary__pending">{t("sxPendingChanges")}</p> : null}
      {!info.can_publish ? <p>{t("sxBuildIncomplete")} <button type="button" className="sx-link" onClick={goToBuild}>{t("sxGoToBuild")}</button></p> : null}
      {shareUrl ? <p className="sx-summary__link"><a className="sx-link" href={safePublicUrl(shareUrl)} target="_blank" rel="noreferrer">{absoluteUrl(shareUrl)}</a><button type="button" className="sx-link" onClick={() => void copy(shareUrl)}><Copy aria-hidden="true" />{copied ? t("copied") : t("copyLink")}</button></p> : null}
    </div>
    <Button className="web-btn-yolk" type="button" loading={state.busy} disabled={!info.can_publish || (live && pending.length === 0)} onClick={publish}>{live ? t("sxUpdateAction") : t("sxPublishAction")}</Button>
    {state.error ? <div className="sx-summary__note"><InlineError>{state.error}</InlineError></div> : null}
    {state.result ? <div className="sx-summary__note"><SuccessNotice>{t("sxPublishedNotice")}</SuccessNotice></div> : null}
  </section>;
}

function DetailsForm({ product, productId, request, t, onSaved }) {
  const initial = { name: product.name ?? product.product_name ?? "", promise: product.promise ?? product.product_promise ?? "" };
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState({ busy: false, error: "", saved: false });
  useEffect(() => { setDraft(initial); }, [product.updated_at, product.name, product.promise]);
  const dirty = draft.name !== initial.name || draft.promise !== initial.promise;
  const valid = draft.name.trim() && draft.promise.trim();
  async function save(event) {
    event.preventDefault();
    if (!dirty || !valid) return;
    setState({ busy: true, error: "", saved: false });
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}`, { method: "PATCH", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ name: draft.name.trim(), promise: draft.promise.trim(), expected_updated_at: product.updated_at }) });
      setState({ busy: false, error: "", saved: true });
      onSaved();
    } catch (error) { setState({ busy: false, error: friendlyError(error, t), saved: false }); }
  }
  return <form className="sx-card sx-form" onSubmit={save}>
    <SectionHead title={t("sxDetailsTitle")} />
    {state.error ? <InlineError>{state.error}</InlineError> : null}
    {state.saved && !dirty ? <SuccessNotice>{t("sxSaved")}</SuccessNotice> : null}
    <FormField label={t("sxNameLabel")} required><Input required maxLength={240} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></FormField>
    <FormField label={t("sxPromiseLabel")} hint={t("sxPromiseHint")} required><Textarea required rows={4} value={draft.promise} onChange={(event) => setDraft((current) => ({ ...current, promise: event.target.value }))} /></FormField>
    <p className="sx-quiet sx-form__note">{t("sxDetailsEffect")}</p>
    <div className="sx-form__foot">
      <Button type="submit" loading={state.busy} disabled={!dirty || !valid}>{t("save")}</Button>
      {dirty ? <button type="button" className="sx-link sx-link--quiet" onClick={() => setDraft(initial)}>{t("sxDiscard")}</button> : null}
    </div>
  </form>;
}

const FIELD_LIMIT = 16;
function nextFieldId(fields) {
  let index = fields.length + 1;
  while (fields.some((field) => field.id === `field-${index}`)) index += 1;
  return `field-${index}`;
}

function BriefSpecForm({ product, productId, request, t, onSaved }) {
  const initial = useMemo(() => arrayOf(product.brief_spec?.fields).map((field) => ({ id: String(field.id), label: String(field.label ?? ""), required: field.required === true })), [product.brief_spec]);
  const [fields, setFields] = useState(initial);
  const [state, setState] = useState({ busy: false, error: "", saved: false });
  useEffect(() => { setFields(initial); }, [initial]);
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  const valid = fields.length >= 1 && fields.length <= FIELD_LIMIT && fields.every((field) => field.label.trim() && field.label.trim().length <= 500);
  const update = (index, change) => setFields((current) => current.map((field, position) => position === index ? { ...field, ...change } : field));
  async function save(event) {
    event.preventDefault();
    if (!dirty || !valid) return;
    setState({ busy: true, error: "", saved: false });
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/brief-spec`, { method: "PUT", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ brief_spec: { contract_version: "1", fields: fields.map((field) => ({ id: field.id, label: field.label.trim(), required: field.required })) }, expected_updated_at: product.updated_at }) });
      setState({ busy: false, error: "", saved: true });
      onSaved();
    } catch (error) { setState({ busy: false, error: friendlyError(error, t), saved: false }); }
  }
  return <form className="sx-card sx-form" onSubmit={save}>
    <SectionHead title={t("sxBriefTitle")} />
    <p className="sx-quiet">{t("sxBriefBody")}</p>
    {state.error ? <InlineError>{state.error}</InlineError> : null}
    {state.saved && !dirty ? <SuccessNotice>{t("sxSaved")}</SuccessNotice> : null}
    {fields.length ? <ol className="sx-brief">{fields.map((field, index) => <li key={field.id}>
      <span className="sx-brief__n" aria-hidden="true">{index + 1}</span>
      <Input aria-label={t("sxBriefQuestion", index + 1)} value={field.label} maxLength={500} onChange={(event) => update(index, { label: event.target.value })} placeholder={t("sxBriefPlaceholder")} />
      <label className="sx-check"><input type="checkbox" checked={field.required} onChange={(event) => update(index, { required: event.target.checked })} /><span>{t("sxBriefRequired")}</span></label>
      <button type="button" className="sx-icon-btn" aria-label={t("sxBriefRemove", index + 1)} disabled={fields.length <= 1} onClick={() => setFields((current) => current.filter((_, position) => position !== index))}><Trash2 aria-hidden="true" /></button>
    </li>)}</ol> : <p className="sx-quiet">{t("sxBriefEmpty")}</p>}
    <p className="sx-quiet sx-form__note">{t("sxBriefEffect")}</p>
    <div className="sx-form__foot">
      <Button type="submit" loading={state.busy} disabled={!dirty || !valid}>{t("save")}</Button>
      <Button variant="secondary" type="button" leading={<Plus aria-hidden="true" />} disabled={fields.length >= FIELD_LIMIT} onClick={() => setFields((current) => [...current, { id: nextFieldId(current), label: "", required: false }])}>{t("sxBriefAdd")}</Button>
      {dirty ? <button type="button" className="sx-link sx-link--quiet" onClick={() => setFields(initial)}>{t("sxDiscard")}</button> : null}
    </div>
  </form>;
}

function PreviewPane({ resource, profile, t }) {
  return <>
    <div className="sx-preview-head">
      <h2 id="sx-preview-title">{t("sxPreviewTitle")}</h2>
    </div>
    <PageBoundary resource={resource} title={t("previewLoadError")} t={t}>{(payload) => {
      const preview = payload?.preview && typeof payload.preview === "object" ? payload.preview : payload;
      const product = preview.product ?? preview;
      return <div className="cpv2-storefront-frame sx-frame">
        <StorefrontDetails product={product} creatorName={preview.creator?.display_name ?? profile?.display_name} creatorAvatarUrl={preview.creator?.avatar_url ?? profile?.avatar_url} mode="preview" headingLevel={2} desktopRequirement={preview.desktop_requirement ?? product.desktop_requirement} action={<Button type="button" disabled>{t("getAccess")}</Button>} />
      </div>;
    }}</PageBoundary>
    {resource.state === "ready" && !isProductLive(unwrap(resource.data, "product")) ? <p className="sx-quiet sx-preview-note">{t("previewBody")}</p> : null}
  </>;
}
