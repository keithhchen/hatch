import { useState } from "react";
import { langFromBrowser } from "./locale.ts";
import HatchPage from "./HatchPage.tsx";
import "@fontsource/dm-mono/400.css";
import "./web.css";

export default function WebPage() {
  const [initialLang] = useState(langFromBrowser);
  return <HatchPage initialLang={initialLang} />;
}
