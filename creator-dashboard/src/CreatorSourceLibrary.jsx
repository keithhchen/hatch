import React, { useMemo, useState } from "react";
import { Button, FormField, InlineAlert, Input, Textarea } from "@hatch/ui";
import { createCreatorTranslator } from "./creatorI18n.js";
import { creatorFactoryPath } from "./creatorRoutes.js";
import { createProduct } from "./creatorFactory.js";
import { StudioPathCards } from "./studioPathCards.jsx";

/** New Agent: two sentences create the real Product, then the guided path starts. */
export function CreatorProductFiles({ token, navigate, locale = "en" }) {
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const [draft, setDraft] = useState({ name: "", promise: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const created = await createProduct(token, draft);
      const id = created?.product?.id ?? created?.product?.product_id ?? created?.id ?? created?.product_id;
      if (!id) throw new Error(t("productCreatedWithoutId"));
      navigate(creatorFactoryPath(id));
    } catch (nextError) { setError(nextError.message); }
    finally { setBusy(false); }
  }

  return <section className="cpv2-new">
    <div className="cpv2-new__grid">
      <div>
        <header className="sx-page-head">
          <div className="sx-page-head__text">
            <h1>{t("newTitle")}</h1>
            <p>{t("newBody")}</p>
          </div>
        </header>
        {error ? <InlineAlert tone="error" title={t("productCouldNotBeCreated")}>{error}</InlineAlert> : null}
        <form onSubmit={create} className="cpv2-new__form sx-card">
          <FormField label={t("newNameLabel")}><Input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t("newNamePlaceholder")} /></FormField>
          <FormField label={t("newPromiseLabel")}><Textarea required rows={4} value={draft.promise} onChange={(event) => setDraft((current) => ({ ...current, promise: event.target.value }))} placeholder={t("newPromisePlaceholder")} /></FormField>
          <Button className="web-btn-yolk" type="submit" loading={busy} trailing={<span aria-hidden="true">→</span>}>{t("newSubmit")}</Button>
        </form>
      </div>
      <aside className="cpv2-new__path" aria-labelledby="studio-new-path">
        <h2 id="studio-new-path">{t("newNextTitle")}</h2>
        <StudioPathCards t={t} compact />
      </aside>
    </div>
  </section>;
}
