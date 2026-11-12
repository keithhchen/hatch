import React, { useEffect, useState } from "react";
import { Button } from "@hatch/ui";
import { API_KEYS_PATH, hasNoApiKeys } from "./apiKeys.js";

/** Overview nudge for users with no API keys. Shown only after the real list loads empty. */
export function ApiKeysBanner({ request, navigate, t }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let active = true;
    hasNoApiKeys(request).then((empty) => { if (active) setShow(empty); });
    return () => { active = false; };
  }, [request]);
  return show ? <section className="sx-card sx-apikeys-banner">
    <p>{t("sxakBanner")}</p>
    <Button type="button" onClick={() => navigate(API_KEYS_PATH)}>{t("sxakBannerCta")}</Button>
  </section> : null;
}
