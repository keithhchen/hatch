import { Link2 } from "lucide-react";
import type { LandingCopy } from "./landingCopy";
import "./trialScenes.css";

export type TrialMini = LandingCopy["trial"]["mini"];

/** Three small scenes, one per step: loose, overlapping pieces of the product in yolk and ink. */
export function TrialScene({ index, m }: { index: number; m: TrialMini }) {
  const wave = <span className="wave">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 70}ms` }} />)}</span>;
  if (index === 0) return (
    <div className="tm tm-material" aria-hidden="true">
      <div className="tm-blob" />
      <div className="tm-doc"><b>PDF</b><span>{m.pdf}</span><i /><i /><i /></div>
      <div className="tm-pill tm-link"><Link2 size={14} />{m.link}</div>
      <div className="tm-pill tm-voice">{wave}<small>{m.voice}</small></div>
      <div className="tm-chat"><p className="tm-b in">{m.chatA}</p><p className="tm-b out">{m.chatB}</p></div>
    </div>
  );
  if (index === 1) return (
    <div className="tm tm-interview" aria-hidden="true">
      <div className="tm-blob" />
      <p className="tm-b in tm-ask">{m.ask}</p>
      <div className="tm-b out tm-reply">{wave}</div>
      <div className="tm-outline">
        <span className="tm-noted">{m.noted}</span>
        {m.outline.map((item, i) => <div key={item}><b className={i < 2 ? "done" : ""}>{i < 2 ? "✓" : ""}</b>{item}</div>)}
      </div>
    </div>
  );
  return (
    <div className="tm tm-link-card" aria-hidden="true">
      <div className="tm-blob" />
      <div className="tm-share">
        <div className="tm-share-head"><span className="tm-avatar" /><b>{m.name}</b></div>
        <div className="tm-url"><span>{m.url}</span><em>{m.copy}</em></div>
      </div>
      <p className="tm-b out tm-q">{m.userQ}</p>
      <p className="tm-b in tm-a">{m.aiA}</p>
    </div>
  );
}
