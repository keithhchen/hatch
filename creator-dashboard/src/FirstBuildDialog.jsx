import React, { useEffect, useRef, useState } from "react";
import { Dialog } from "@mui/material";
import { HelpCircle } from "lucide-react";
import { Button } from "@hatch/ui";
import { TrialScene } from "./web/TrialScenes.tsx";
import { landingCopy } from "./web/landingCopy.ts";
import { creatorFactoryPath } from "./creatorRoutes.js";
import { shouldShowFirstBuildIntro } from "./firstBuildIntro.js";
import { arrayOf, unwrap, useRemote } from "./studioShellKit.jsx";
import "./firstBuildDialog.css";

const COPY = {
  zh: {
    start: "开始上传",
    begin: "开始",
    help: "了解如何构建",
    steps: [
      { title: "上传资料", bullets: ["你的课程、讲义、写过的文章", "过往客户的通话或咨询录音", "和客户的聊天截图、案例 PDF", "不用整理，原样上传就行"] },
      { title: "访谈", bullets: ["先和你简单聊几句", ["然后一次性给你一份问题清单：", "你的价值观", "做事的具体细节", "它还不知道的地方", "什么能答、什么不能答"], "按任意顺序、用文字或语音回答"] },
      { title: "构建", bullets: ["生成你的分身", "你会得到一个不公开的链接，先自己去体验", "满意了再发布"] }
    ]
  },
  en: {
    start: "Start uploading",
    begin: "Get started",
    help: "How building works",
    steps: [
      { title: "Upload", bullets: ["Your courses, handouts, articles you've written", "Recordings of past client calls or consultations", "Chat screenshots with clients, case PDFs", "No need to tidy up. Upload them as they are"] },
      { title: "Interview", bullets: ["A short chat with you first", ["Then one list of questions, all at once:", "Your values", "The details of how you work", "What it doesn't know yet", "What it can and can't answer"], "Answer in any order, by text or voice"] },
      { title: "Build", bullets: ["Generates your AI twin", "You get a private link to try it yourself first", "Publish when you're happy with it"] }
    ]
  },
  ja: {
    start: "アップロードを始める",
    begin: "はじめる",
    help: "構築の流れ",
    steps: [
      { title: "資料のアップロード", bullets: ["講義、配布資料、書いた記事", "過去のお客様との通話や相談の録音", "お客様とのチャットのスクリーンショット、事例の PDF", "整理は不要。そのままアップロードでOK"] },
      { title: "インタビュー", bullets: ["まず軽くお話しします", ["そのあと質問リストを一度にお渡しします：", "あなたの価値観", "仕事の具体的な進め方", "まだ知らないこと", "答えてよいこと、答えられないこと"], "好きな順番で、文字でも音声でも回答できます"] },
      { title: "構築", bullets: ["あなたの分身を生成します", "非公開のリンクが届くので、まず自分で試せます", "納得できたら公開します"] }
    ]
  }
};

/**
 * The first-build intro and the quiet help button that opens it any time.
 * On the New Agent page (`productId` absent) it opens by itself for an account with no Agents, and its button just closes it.
 * In an Agent's workspace its button goes to Upload.
 */
export function FirstBuildIntro({ request, productId, profile, locale, navigate }) {
  const accountId = profile?.id == null ? "" : String(profile.id);
  const onNewPage = !productId;
  const products = useRemote(request, onNewPage ? "/v1/creator/products" : null);
  const [open, setOpen] = useState(false);
  const decided = useRef(false);
  const auto = onNewPage && shouldShowFirstBuildIntro({ accountId, products: products.state === "ready" ? arrayOf(unwrap(products.data, "products")) : null });
  // Decided once from the list as first loaded: creating the first Agent from this page must not reopen it.
  useEffect(() => { if (auto && !decided.current) { decided.current = true; setOpen(true); } }, [auto]);

  const copy = COPY[locale] ?? COPY.en;
  const lang = landingCopy[locale] ? locale : "en";
  const close = () => setOpen(false);
  const start = () => { close(); if (!onNewPage) navigate(creatorFactoryPath(productId, "sources", "uploads")); };
  return <>
    <button type="button" className="sx-icon-btn sx-icon-btn--quiet" aria-label={copy.help} onClick={() => setOpen(true)}><HelpCircle aria-hidden="true" /></button>
    <Dialog open={open} onClose={close} fullWidth maxWidth="lg" scroll="paper" aria-labelledby="first-build-title" PaperProps={{ className: "trial-modal fbd" }}>
      <div className="fbd__inner">
        <h2 id="first-build-title">{landingCopy[lang].trial.title}</h2>
        <ol className="trial-steps">
          {copy.steps.map((step, index) => <li key={step.title}>
            <TrialScene index={index} m={landingCopy[lang].trial.mini} />
            <strong><span className="trial-step__number" aria-hidden="true">{index + 1}</span>{step.title}</strong>
            <ul className="fbd__bullets">
              {step.bullets.map((bullet) => Array.isArray(bullet)
                ? <li key={bullet[0]}>{bullet[0]}<ul>{bullet.slice(1).map((item) => <li key={item}>{item}</li>)}</ul></li>
                : <li key={bullet}>{bullet}</li>)}
            </ul>
          </li>)}
        </ol>
        <Button type="button" onClick={start}>{onNewPage ? copy.begin : copy.start}</Button>
      </div>
    </Dialog>
  </>;
}
