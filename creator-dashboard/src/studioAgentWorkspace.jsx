// One workspace per Agent: header (name, status, public link, primary action)
// and four tabs — Build (Factory path), Storefront, Versions, Readiness.
// Every control calls an existing Creator endpoint; nothing is simulated.
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button, ConfirmDialog, FormField, Input, Textarea } from "@hatch/ui";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { creatorFactoryPath, creatorProductPath } from "./creatorRoutes.js";
import { isProductLive } from "./studioPath.js";
import { readinessChecklist } from "./studioAgentReadiness.js";
import {
  EmptyState, InlineError, LoadingState, PageBoundary, RouteProblem, SectionHead, StatusPill, SuccessNotice, STUDIO_ROOT,
  absoluteUrl, arrayOf, dateTime, friendlyError, humanStatus, idOf, mutationKey, productName, publicPathOf, safePublicUrl, unwrap, useCopy, useRemote
} from "./studioShellKit.jsx";

const TABS = [
  { value: "build", label: "sxTabBuild" },
  { value: "storefront", label: "sxTabStorefront" },
  { value: "versions", label: "sxTabVersions" },
  { value: "readiness", label: "sxTabReadiness" }
];

export function StudioAgentWorkspace({ route, request, navigate, locale, t, profile, renderBuild }) {
  const productId = route.productId;
  const productPath = `/v1/creator/products/${encodeURIComponent(productId)}`;
  const resource = useRemote(request, productPath);
  const product = resource.data ? unwrap(resource.data, "product") : null;
  const tab = route.tab ?? "build";

  if (resource.state === "error") return <RouteProblem title={t("workspaceLoadError")} body={friendlyError(resource.error, t)} action={t("retry")} onAction={resource.retry} />;
  const live = isProductLive(product);
  const checklist = readinessChecklist(product?.readiness);
  const ctx = { product, productId, request, navigate, locale, t, profile, reload: resource.retry };

  return <div className={`sx-agent${tab === "build" ? " sx-agent--build" : ""}`}>
    <header className="sx-agent__head">
      <button type="button" className="sx-crumb" onClick={() => navigate(`${STUDIO_ROOT}/products`)}><ArrowLeft aria-hidden="true" />{t("sxNavAgents")}</button>
      <div className="sx-agent__row">
        <div className="sx-agent__title">
          <h1>{product ? productName(product, t) : "…"}</h1>
          {product ? <StatusPill live={live} t={t} /> : null}
        </div>
        {product ? <AgentHeaderActions product={product} live={live} checklist={checklist} tab={tab} navigate={navigate} t={t} /> : null}
      </div>
      <nav className="sx-tabs" aria-label={t("sxAgentTabs")}>
        {TABS.map((item) => <a key={item.value} href={creatorProductPath(productId, item.value)} aria-current={tab === item.value ? "page" : undefined} className={tab === item.value ? "is-active" : ""} onClick={(event) => { event.preventDefault(); navigate(creatorProductPath(productId, item.value)); }}>
          {t(item.label)}
          {item.value === "readiness" && checklist && !live ? <b className={checklist.ready ? "is-ok" : ""}>{checklist.ready ? "✓" : checklist.blocking}</b> : null}
        </a>)}
      </nav>
    </header>
    <div className="sx-agent__body">
      {tab === "build" ? renderBuild(product)
        : !product ? <LoadingState t={t} />
        : tab === "storefront" ? <StorefrontTab {...ctx} />
        : tab === "versions" ? <VersionsTab {...ctx} releaseId={route.releaseId} />
        : <ReadinessTab {...ctx} checklist={checklist} />}
    </div>
  </div>;
}

function AgentHeaderActions({ product, live, checklist, tab, navigate, t }) {
  const productId = idOf(product, "product");
  const publicPath = publicPathOf(product);
  const { copied, copy } = useCopy();
  const [error, setError] = useState("");
  return <div className="sx-agent__actions">
    {publicPath ? <Button variant="secondary" type="button" leading={<Copy aria-hidden="true" />} onClick={() => copy(publicPath).catch(() => setError(t("copyFailed")))}>{copied ? t("copied") : t("copyLink")}</Button> : null}
    {live && safePublicUrl(publicPath)
      ? <Button asChild className="web-btn-yolk" trailing={<ExternalLink aria-hidden="true" />}><a href={safePublicUrl(publicPath)} target="_blank" rel="noreferrer">{t("viewStorefront")}</a></Button>
      : tab === "readiness" ? null : <Button className={checklist?.ready ? "web-btn-yolk" : undefined} variant={checklist?.ready ? "primary" : "secondary"} type="button" onClick={() => navigate(creatorProductPath(productId, "readiness"))}>{checklist?.ready ? t("publish") : t("sxReviewReadiness")}</Button>}
    {error ? <span className="sx-inline-error" role="alert">{error}</span> : null}
  </div>;
}

/* ---------- Storefront ---------- */

function StorefrontTab({ product, productId, request, locale, t, profile, reload, navigate }) {
  const preview = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}/storefront-preview`);
  const live = isProductLive(product);
  const reloadAll = () => { reload(); preview.retry(); };
  return <div className="sx-storefront">
    <div className="sx-storefront__edit">
      <DetailsForm product={product} productId={productId} request={request} t={t} onSaved={reloadAll} />
      <BriefSpecForm product={product} productId={productId} request={request} t={t} onSaved={reloadAll} />
      <PublicLinkCard product={product} live={live} navigate={navigate} t={t} />
    </div>
    <section className="sx-storefront__preview" aria-labelledby="sx-preview-title">
      <PreviewPane resource={preview} profile={profile} t={t} />
    </section>
  </div>;
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
    <p className="sx-quiet">{t("sxDetailsBody")}</p>
    {state.error ? <InlineError>{state.error}</InlineError> : null}
    {state.saved && !dirty ? <SuccessNotice>{t("sxSaved")}</SuccessNotice> : null}
    <FormField label={t("newNameLabel")} required><Input required maxLength={240} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></FormField>
    <FormField label={t("sxPromiseLabel")} hint={t("sxPromiseHint")} required><Textarea required rows={4} value={draft.promise} onChange={(event) => setDraft((current) => ({ ...current, promise: event.target.value }))} /></FormField>
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
    <div className="sx-form__foot">
      <Button type="submit" loading={state.busy} disabled={!dirty || !valid}>{t("save")}</Button>
      <Button variant="secondary" type="button" leading={<Plus aria-hidden="true" />} disabled={fields.length >= FIELD_LIMIT} onClick={() => setFields((current) => [...current, { id: nextFieldId(current), label: "", required: false }])}>{t("sxBriefAdd")}</Button>
      {dirty ? <button type="button" className="sx-link sx-link--quiet" onClick={() => setFields(initial)}>{t("sxDiscard")}</button> : null}
    </div>
  </form>;
}

function PublicLinkCard({ product, live, navigate, t }) {
  const publicPath = publicPathOf(product);
  const { copied, copy } = useCopy();
  const [error, setError] = useState("");
  return <section className="sx-card">
    <SectionHead title={t("shareLink")} />
    {live && publicPath ? <>
      <div className="sx-linkbox"><Input readOnly value={absoluteUrl(publicPath)} onFocus={(event) => event.target.select()} aria-label={t("shareLink")} /><Button type="button" leading={<Copy aria-hidden="true" />} onClick={() => copy(publicPath).catch(() => setError(t("copyFailed")))}>{copied ? t("copied") : t("copyLink")}</Button></div>
      {error ? <InlineError>{error}</InlineError> : null}
    </> : <p className="sx-quiet">{t("sxLinkAfterPublish")} <button type="button" className="sx-link" onClick={() => navigate(creatorProductPath(idOf(product, "product"), "readiness"))}>{t("sxReviewReadiness")}</button></p>}
  </section>;
}

function PreviewPane({ resource, profile, t }) {
  const [viewport, setViewport] = useState("desktop");
  return <>
    <div className="sx-preview-head">
      <h2 id="sx-preview-title">{t("sxPreviewTitle")}</h2>
      <div className="cpv2-segmented" role="group" aria-label={t("previewViewport")}>
        {["desktop", "mobile"].map((value) => <button key={value} type="button" className={viewport === value ? "is-active" : ""} aria-pressed={viewport === value} onClick={() => setViewport(value)}>{t(value)}</button>)}
      </div>
    </div>
    <PageBoundary resource={resource} title={t("previewLoadError")} t={t}>{(payload) => {
      const preview = payload?.preview && typeof payload.preview === "object" ? payload.preview : payload;
      const product = preview.product ?? preview;
      const candidate = product.candidate;
      return <div className={`cpv2-storefront-frame sx-frame is-${viewport}`}>
        <StorefrontDetails product={product} creatorName={preview.creator?.display_name ?? profile?.display_name} creatorAvatarUrl={preview.creator?.avatar_url ?? profile?.avatar_url} mode="preview" headingLevel={2} desktopRequirement={preview.desktop_requirement ?? product.desktop_requirement} releaseLabel={candidate ? t("candidateVersion", candidate.version ?? "—") : undefined} action={<Button type="button" disabled>{t("getAccess")}</Button>} />
      </div>;
    }}</PageBoundary>
    {resource.state === "ready" && !isProductLive(unwrap(resource.data, "product")) ? <p className="sx-quiet sx-preview-note">{t("previewBody")}</p> : null}
  </>;
}

/* ---------- Versions ---------- */

function VersionsTab({ product, productId, request, navigate, locale, t, reload, releaseId }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}/releases`);
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ busy: false, error: "", done: false });
  const candidate = product.candidate;
  async function rollback() {
    if (!target || !reason.trim()) return;
    setState({ busy: true, error: "", done: false });
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(idOf(target, "release"))}/rollback`, { method: "POST", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ expected_version: product.resource_version, reason: reason.trim() }) });
      setState({ busy: false, error: "", done: true });
      setTarget(null); setReason("");
      resource.retry(); reload();
    } catch (error) { setState({ busy: false, error: friendlyError(error, t), done: false }); setTarget(null); }
  }
  return <div className="sx-stack">
    {state.error ? <InlineError>{state.error}</InlineError> : null}
    {state.done ? <SuccessNotice>{t("currentReleaseUpdated")}</SuccessNotice> : null}
    {candidate ? <section className="sx-card">
      <SectionHead title={t("sxCandidateTitle")} />
      <div className="sx-version is-candidate">
        <div><strong>{t("candidateVersion", candidate.version ?? "—")}</strong><small>{humanStatus(candidate.status ?? (candidate.corpus_verified ? "ready" : "pending"), t)}</small></div>
        <div className="sx-version__actions">
          {idOf(candidate, "candidate") ? <Button variant="secondary" size="small" type="button" onClick={() => navigate(`${STUDIO_ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}>{t("sxReviewCandidate")}</Button> : null}
          <Button size="small" type="button" onClick={() => navigate(creatorProductPath(productId, "readiness"))}>{t("sxReviewReadiness")}</Button>
        </div>
      </div>
    </section> : null}
    <section className="sx-card">
      <SectionHead title={t("sxReleasesTitle")} />
      <p className="sx-quiet">{t("existingAccessPinned")}</p>
      <PageBoundary resource={resource} title={t("releaseLoadError")} t={t}>{(payload) => {
        const releases = arrayOf(payload?.releases);
        const activeId = idOf(payload?.active_release ?? product.release, "release");
        if (!releases.length) return <EmptyState title={t("sxNoReleasesTitle")} body={t("sxNoReleasesBody")} action={t("sxReviewReadiness")} onAction={() => navigate(creatorProductPath(productId, "readiness"))} />;
        return <ul className="sx-versions">{releases.map((release, index) => {
          const id = idOf(release, "release");
          const current = release.current === true || (activeId && id === activeId);
          return <li key={id || index} className={`sx-version${current ? " is-current" : ""}${releaseId && id === releaseId ? " is-focused" : ""}`}>
            <div><strong>{release.label ?? t("sxReleaseN", release.version ?? releases.length - index)}</strong><small>{dateTime(release.published_at ?? release.created_at, locale)}{release.materialization_status ? ` · ${humanStatus(release.materialization_status, t)}` : ""}</small></div>
            <div className="sx-version__actions">{current ? <span className="sx-pill is-live">{t("current")}</span> : <Button variant="secondary" size="small" type="button" onClick={() => { setTarget(release); setReason(""); }}>{t("sxMakeCurrent")}</Button>}</div>
          </li>;
        })}</ul>;
      }}</PageBoundary>
    </section>
    <ConfirmDialog
      open={Boolean(target)}
      onOpenChange={(value) => { if (!value) setTarget(null); }}
      title={t("exactReleaseConfirm")}
      description={t("rollbackAudit")}
      confirmLabel={t("confirmRollback")}
      cancelLabel={t("cancel")}
      busy={state.busy}
      confirmDisabled={!reason.trim()}
      onConfirm={rollback}
    >
      <FormField label={t("auditReason")} required><Textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("whyReleaseCurrent")} /></FormField>
    </ConfirmDialog>
  </div>;
}

/* ---------- Readiness & publish ---------- */

function ReadinessTab({ product, productId, request, navigate, t, reload, checklist }) {
  const live = isProductLive(product);
  const candidate = product.candidate;
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState({ busy: false, error: "", result: null });
  const { copied, copy } = useCopy();
  const fixTarget = (fix) => {
    if (fix === "storefront") return () => navigate(creatorProductPath(productId, "storefront"));
    if (fix === "evaluate") return () => navigate(creatorFactoryPath(productId, "evaluate", "evaluator"));
    if (fix === "build") return () => navigate(creatorFactoryPath(productId));
    return null;
  };
  async function publish() {
    setState({ busy: true, error: "", result: null });
    try {
      const result = await request(`/v1/creator/products/${encodeURIComponent(productId)}/release`, { method: "POST", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ candidate_id: idOf(candidate, "candidate"), report_digest: candidate?.report_digest ?? candidate?.evaluation_digest, expected_version: product.resource_version ?? product.version }) });
      setState({ busy: false, error: "", result });
      setConfirming(false);
      reload();
    } catch (error) { setState({ busy: false, error: friendlyError(error, t), result: null }); setConfirming(false); }
  }
  const publishedUrl = state.result ? (state.result.canonical_url ?? state.result.public_url) : null;

  return <div className="sx-readiness">
    <section className={`sx-summary${live ? " is-live" : checklist?.ready ? " is-ready" : ""}`}>
      {live ? <CircleCheck aria-hidden="true" /> : checklist?.ready ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <div>
        <h2>{live ? t("sxSummaryLive") : !checklist ? t("sxSummaryUnknown") : checklist.ready ? t("sxSummaryReady") : t("sxSummaryBlocked", checklist.blocking)}</h2>
        <p>{live ? t("sxSummaryLiveBody") : checklist?.ready ? t("publicPointerAfterMaterialization") : t("sxSummaryBlockedBody")}</p>
      </div>
      {!live ? <Button className="web-btn-yolk" type="button" disabled={!checklist?.ready || !candidate} onClick={() => setConfirming(true)}>{t("publish")}</Button> : null}
    </section>
    {state.error ? <InlineError>{state.error}</InlineError> : null}
    {state.result ? <SuccessNotice>{t("yourProductLive")}{publishedUrl ? <> · <button type="button" className="sx-link" onClick={() => void copy(publishedUrl)}>{copied ? t("copied") : t("copyLink")}</button></> : null}</SuccessNotice> : null}
    {checklist ? <section className="sx-card">
      <SectionHead title={t("finalChecks")} />
      <ul className="sx-checks">{checklist.items.map((item) => {
        const onFix = item.ready ? null : fixTarget(item.fix);
        return <li key={item.key} className={item.ready ? "is-ready" : "is-blocked"}>
          {item.ready ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          <div><strong>{t(`sxCheck_${item.key}`)}</strong><small>{t(item.ready ? `sxCheckOk_${item.key}` : `sxCheckFix_${item.key}`)}</small></div>
          {onFix ? <button type="button" className="sx-link" onClick={onFix}>{t("sxFix")}</button> : <span className="sx-check-state">{item.ready ? t("statusReady") : t("sxNeedsSupport")}</span>}
        </li>;
      })}
      {checklist.unknownBlockers.map((blocker) => <li key={blocker} className="is-blocked"><CircleAlert aria-hidden="true" /><div><strong>{blocker}</strong></div><span /></li>)}
      </ul>
    </section> : <EmptyState title={t("sxSummaryUnknown")} body={t("sxReadinessMissing")} />}
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      title={t("publishCandidateConfirm")}
      description={t("publicPointerAfterMaterialization")}
      confirmLabel={t("confirmPublish")}
      cancelLabel={t("cancel")}
      busy={state.busy}
      onConfirm={publish}
    />
  </div>;
}
