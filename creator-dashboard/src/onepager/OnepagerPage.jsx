import { useState } from "react";
import { langFromBrowser } from "./locale.ts";
import HatchPage from "./HatchPage.tsx";
import "@fontsource/dm-mono/400.css";
import "./onepager.css";

export default function OnepagerPage() {
  const [initialLang] = useState(langFromBrowser);
  return <HatchPage initialLang={initialLang} />;
}
