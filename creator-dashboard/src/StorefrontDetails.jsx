import React from "react";
import { storefrontModel } from "./storefrontModel.js";
import { webT } from "./webI18n.js";
import "./storefrontDetails.css";

export function StorefrontDetails({
  product,
  creatorName,
  creatorAvatarUrl,
  creatorInitial,
  action,
  mode = "public",
  headingLevel = 1,
  desktopRequirement,
  refundPolicy,
  releaseLabel
}) {
  const model = storefrontModel(product, { desktopRequirement, refundPolicy });
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const hasDetails = model.inputs.length || model.outputs.length || model.boundaries.length || model.privacy;
  return (
    <article className={`storefront-shared is-${mode}`}>
      <header className="storefront-shared__hero">
        <div>
          <span className="storefront-shared__creator">
            <span className="storefront-shared__creator-avatar" aria-hidden="true">
              {creatorAvatarUrl ? <img src={creatorAvatarUrl} alt="" /> : (creatorInitial || (typeof creatorName === "string" ? creatorName.trim().charAt(0) : ""))}
            </span>
            <span className="storefront-shared__creator-name">{creatorName || webT("common.creator")}</span>
          </span>
          <Heading>{model.name}</Heading>
          {model.promise ? <p>{model.promise}</p> : null}
          {releaseLabel ? <small>{releaseLabel}</small> : null}
        </div>
        <aside className="storefront-shared__access" aria-label={mode === "preview" ? webT("buyer.previewAccess") : webT("buyer.productAccess")}>
          <span>{mode === "preview" ? webT("buyer.preview") : webT("common.access")}</span>
          <strong>{webT("common.free")}</strong>
          {action}
        </aside>
      </header>

      {hasDetails ? (
        <div className="storefront-shared__grid">
          {model.inputs.length ? <StorefrontList title={webT("buyer.whatYouProvide")} values={model.inputs} /> : null}
          {model.outputs.length ? <StorefrontList title={webT("buyer.whatYouReceive")} values={model.outputs} /> : null}
          {model.boundaries.length ? <StorefrontList title={webT("buyer.boundaries")} values={model.boundaries} /> : null}
          {model.privacy ? <section><span className="storefront-shared__eyebrow">{webT("buyer.privacy")}</span><h3>{webT("buyer.workUnderControl")}</h3><p>{model.privacy}</p></section> : null}
        </div>
      ) : null}

      {model.desktopRequirement ? (
        <footer className="storefront-shared__policies">
          <section><strong>{webT("buyer.desktopRequirement")}</strong><p>{model.desktopRequirement}</p></section>
        </footer>
      ) : null}
    </article>
  );
}

function StorefrontList({ title, values }) {
  return <section><span className="storefront-shared__eyebrow">{title}</span><ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul></section>;
}
