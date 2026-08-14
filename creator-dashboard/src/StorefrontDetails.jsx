import React from "react";
import { storefrontModel } from "./storefrontModel.js";
import "./storefrontDetails.css";

export function StorefrontDetails({
  product,
  creatorName,
  action,
  mode = "public",
  headingLevel = 1,
  desktopRequirement,
  refundPolicy,
  releaseLabel
}) {
  const model = storefrontModel(product, { desktopRequirement, refundPolicy });
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const empty = "Not provided yet";
  return (
    <article className={`storefront-shared is-${mode}`}>
      <header className="storefront-shared__hero">
        <div>
          <span className="storefront-shared__eyebrow">By {creatorName || "Creator"}</span>
          <Heading>{model.name}</Heading>
          <p>{model.promise || empty}</p>
          {releaseLabel ? <small>{releaseLabel}</small> : null}
        </div>
        <aside className="storefront-shared__access" aria-label={mode === "preview" ? "Preview access" : "Product access"}>
          <span>{mode === "preview" ? "Preview" : "Access"}</span>
          <strong>Free</strong>
          {action}
        </aside>
      </header>

      <div className="storefront-shared__grid">
        <StorefrontList title="What you provide" values={model.inputs} empty={empty} />
        <StorefrontList title="What you receive" values={model.outputs} empty={empty} />
        <StorefrontList title="Boundaries" values={model.boundaries} empty={empty} />
        <section>
          <span className="storefront-shared__eyebrow">Privacy</span>
          <h3>Your work stays under your control.</h3>
          <p className={!model.privacy ? "is-missing" : ""}>{model.privacy || empty}</p>
        </section>
      </div>

      <footer className="storefront-shared__policies">
        <section><strong>Desktop requirement</strong><p className={!model.desktopRequirement ? "is-missing" : ""}>{model.desktopRequirement || empty}</p></section>
      </footer>
    </article>
  );
}

function StorefrontList({ title, values, empty }) {
  return <section><span className="storefront-shared__eyebrow">{title}</span>{values.length ? <ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul> : <p className="is-missing">{empty}</p>}</section>;
}
