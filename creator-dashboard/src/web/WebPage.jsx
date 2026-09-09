import HatchPage from "./HatchPage.tsx";
import { useWebLocale } from "../WebLocaleProvider.jsx";
import "@fontsource/dm-mono/400.css";
import "./web.css";

export default function WebPage() {
  const { setLocale } = useWebLocale();
  return <HatchPage onLanguageChange={setLocale} />;
}
