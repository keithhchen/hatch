import React from "react";
import { AccountAvatar } from "./AccountAvatar.jsx";
import { storefrontModel } from "./storefrontModel.js";
import { buyerT } from "./buyerI18n.js";
import { useLocale } from "./locale.jsx";
import "./storefrontDetails.css";

export function StorefrontDetails({
  product,
  creatorName,
  creatorAvatarName,
  creatorAvatarUrl,
  action,
  mode = "public",
  headingLevel = 1,
  desktopRequirement,
  refundPolicy,
  releaseLabel
}) {
  const { locale } = useLocale();
  const t = (key) => buyerT(locale, key);
  const model = storefrontModel(product, { desktopRequirement, refundPolicy });
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const fallbackCreator = t("Hatch Expert");
  const hasDetails = model.inputs.length || model.outputs.length || model.boundaries.length || model.privacy;
  return (
    <article className={`storefront-shared is-${mode}`}>
      <header className="storefront-shared__hero">
        <div>
          <span className="storefront-shared__creator">
            <AccountAvatar className="storefront-shared__creator-avatar" size="small" src={creatorAvatarUrl} name={creatorAvatarName || (typeof creatorName === "string" ? creatorName : fallbackCreator)} />
            <span className="storefront-shared__creator-name">{creatorName || fallbackCreator}</span>
          </span>
          <Heading>{model.name === "Untitled product" ? t("Untitled product") : model.name}</Heading>
          {model.promise ? <p>{model.promise}</p> : null}
          {releaseLabel ? <small>{releaseLabel}</small> : null}
        </div>
        <aside className="storefront-shared__access" aria-label={mode === "preview" ? t("Preview offer") : t("Product offer")}>
          <strong>{t("Free")}</strong>
          {action}
        </aside>
      </header>

      {hasDetails ? (
        <div className="storefront-shared__grid">
          {model.inputs.length ? <StorefrontList title={t("What to provide")} values={model.inputs} /> : null}
          {model.outputs.length ? <StorefrontList title={t("What you receive")} values={model.outputs} /> : null}
          {model.boundaries.length ? <StorefrontList title={t("Out of scope")} values={model.boundaries} /> : null}
          {model.privacy ? <section><span className="storefront-shared__eyebrow">{t("Privacy")}</span><p>{model.privacy}</p></section> : null}
        </div>
      ) : null}

      {model.desktopRequirement ? (
        <footer className="storefront-shared__policies">
          <section><strong>{t("Availability")}</strong><p>{model.desktopRequirement}</p></section>
        </footer>
      ) : null}
    </article>
  );
}

function StorefrontList({ title, values }) {
  return <section><span className="storefront-shared__eyebrow">{title}</span><ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul></section>;
}
