// Every string of the access code pages (/c and /c/<code>) in zh, en and ja. zh is the source copy.
export const codePageCopy = Object.freeze({
  zh: Object.freeze({
    productFallback: "出海官网获客诊断",
    optional: "选填", back: "返回", next: "下一步",
    eventCode: "活动码", accessCode: "兑换码", use: "使用", open: "打开",
    codeNotFound: "{label}不存在",
    hasEventCode: "有活动码？",
    eventHint: "活动码仅限线下活动体验",
    toAccessCode: "如果您有一人一码的兑换码，点击这里",
    accessHint: "兑换码以 MSC 开头，一人一码",
    toEventCode: "如果您有活动码，点击这里",
    field_name: "姓名", field_phone: "电话", field_email: "邮箱", field_website: "网址", field_markets: "出海的国家和地区",
    missingField: "请填写：{field}", emailInvalid: "邮箱格式不对",
    orderProduct: "产品", orderExpert: "专家", orderWebsite: "网站", wechatPay: "微信支付",
    startDiagnosis: "开始诊断", starting: "正在开始诊断", newReport: "新建报告",
    generating: "报告正在生成",
    sentTo: "发送至 {email}", sentToYou: "发送至您的邮箱",
    waitMinutes: "您可以关闭此页面，约 {minutes} 分钟后报告会{dest}", waitSoon: "报告即将完成，完成后会{dest}",
    ready: "{name}，你的诊断报告已生成", readyPlain: "你的诊断报告已生成", viewReport: "查看报告",
    failed: "生成遇到问题，我们会尽快处理",
    wechatGuide: "请点击右上角 ··· 选择『在浏览器打开』",
    checking: "正在核对{item}", scoring: "正在评估「{item}」",
    check0: "像海外买家一样打开官网首页", check1: "询盘表单能不能顺利提交", check2: "手机端与电脑端的打开速度", check3: "HTTPS 证书是否有效", check4: "Google 地图上的商家信息",
    check5: "服务器所在的地区", check6: "英文文案是否通顺清楚", check7: "产品页有没有足够的证据", check8: "资质与认证展示", check9: "联系方式是否好找",
    dim0: "首屏 3 秒", dim1: "技术与性能", dim2: "信息架构", dim3: "内容与英文", dim4: "信任与证明", dim5: "转化路径", dim6: "SEO 与 AI 搜索", dim7: "设计与品牌", dim8: "可持续与社会影响",
    unreachable: "暂时无法打开，请稍后再试", readFailed: "暂时无法读取，请稍后再试", submitFailed: "提交失败，请重试",
    access_code_not_found: "兑换码不存在", access_code_not_paid: "尚未支付", access_code_used: "兑换码已被使用", access_code_wrong_product: "兑换码不适用于此产品",
    access_codes_unavailable: "兑换码服务暂不可用", brief_unavailable: "暂时无法开始诊断，请稍后再试", invalid_brief: "填写的内容有误，请检查后重试"
  }),
  en: Object.freeze({
    productFallback: "Website diagnosis for going global",
    optional: "Optional", back: "Back", next: "Next",
    eventCode: "event code", accessCode: "access code", use: "Use", open: "Open",
    codeNotFound: "We couldn't find that {label}",
    hasEventCode: "Have an event code?",
    eventHint: "Event codes are for in-person events only",
    toAccessCode: "Have a personal access code? Tap here",
    accessHint: "Access codes start with MSC, one per person",
    toEventCode: "Have an event code? Tap here",
    field_name: "Name", field_phone: "Phone", field_email: "Email", field_website: "Website URL", field_markets: "Countries and regions you sell to",
    missingField: "Please fill in: {field}", emailInvalid: "That email address doesn't look right",
    orderProduct: "Product", orderExpert: "Expert", orderWebsite: "Website", wechatPay: "WeChat Pay",
    startDiagnosis: "Start diagnosis", starting: "Starting your diagnosis", newReport: "New report",
    generating: "Your report is being generated",
    sentTo: "arrive at {email}", sentToYou: "arrive in your inbox",
    waitMinutes: "You can close this page. Your report will {dest} in about {minutes} min.", waitSoon: "Almost done. Your report will {dest} when it's ready.",
    ready: "{name}, your diagnosis report is ready", readyPlain: "Your diagnosis report is ready", viewReport: "View report",
    failed: "Something went wrong while generating your report. We'll look into it right away.",
    wechatGuide: "Tap ··· at the top right and choose “Open in Browser”",
    checking: "Checking {item}", scoring: "Scoring “{item}”",
    check0: "the homepage, opened the way an overseas buyer would", check1: "whether the inquiry form submits smoothly", check2: "load speed on mobile and desktop", check3: "whether the HTTPS certificate is valid", check4: "your business listing on Google Maps",
    check5: "where your server is located", check6: "whether the English copy reads clearly", check7: "whether product pages carry enough proof", check8: "how certifications and credentials are shown", check9: "whether contact details are easy to find",
    dim0: "First 3 seconds", dim1: "Technology and performance", dim2: "Information architecture", dim3: "Content and English", dim4: "Trust and proof", dim5: "Conversion path", dim6: "SEO and AI search", dim7: "Design and brand", dim8: "Sustainability and social impact",
    unreachable: "We can't open this right now. Please try again later.", readFailed: "We can't load this right now. Please try again later.", submitFailed: "Couldn't submit. Please try again.",
    access_code_not_found: "This access code doesn't exist", access_code_not_paid: "This access code hasn't been paid for yet", access_code_used: "This access code has already been used", access_code_wrong_product: "This access code doesn't work for this product",
    access_codes_unavailable: "Access codes are temporarily unavailable", brief_unavailable: "We can't start the diagnosis right now. Please try again later.", invalid_brief: "Some answers aren't valid. Please check and try again."
  }),
  ja: Object.freeze({
    productFallback: "海外展開向けWebサイト診断",
    optional: "任意", back: "戻る", next: "次へ",
    eventCode: "イベントコード", accessCode: "引き換えコード", use: "利用", open: "開く",
    codeNotFound: "その{label}は見つかりません",
    hasEventCode: "イベントコードをお持ちですか？",
    eventHint: "イベントコードは会場でのイベント限定です",
    toAccessCode: "個人用の引き換えコードをお持ちの方はこちら",
    accessHint: "引き換えコードは MSC で始まり、1人1コードです",
    toEventCode: "イベントコードをお持ちの方はこちら",
    field_name: "お名前", field_phone: "電話番号", field_email: "メールアドレス", field_website: "WebサイトのURL", field_markets: "進出先の国・地域",
    missingField: "入力してください：{field}", emailInvalid: "メールアドレスの形式が正しくありません",
    orderProduct: "製品", orderExpert: "専門家", orderWebsite: "Webサイト", wechatPay: "WeChat Pay",
    startDiagnosis: "診断を始める", starting: "診断を開始しています", newReport: "新しいレポート",
    generating: "レポートを作成しています",
    sentTo: "{email} 宛に届きます", sentToYou: "メールで届きます",
    waitMinutes: "このページは閉じても構いません。約 {minutes} 分後にレポートは{dest}", waitSoon: "まもなく完成します。完成後、レポートは{dest}",
    ready: "{name}さん、診断レポートが完成しました", readyPlain: "診断レポートが完成しました", viewReport: "レポートを見る",
    failed: "レポートの作成中に問題が発生しました。至急対応いたします。",
    wechatGuide: "右上の「···」をタップし、「ブラウザで開く」を選んでください",
    checking: "{item}を確認中", scoring: "「{item}」を評価中",
    check0: "海外のバイヤーと同じ目線でのトップページ表示", check1: "問い合わせフォームが問題なく送信できるか", check2: "モバイルとPCでの表示速度", check3: "HTTPS 証明書が有効か", check4: "Google マップ上の事業者情報",
    check5: "サーバーの所在地", check6: "英文コピーが自然で分かりやすいか", check7: "製品ページに十分な裏付けがあるか", check8: "資格・認証の見せ方", check9: "連絡先が見つけやすいか",
    dim0: "ファーストビュー3秒", dim1: "技術とパフォーマンス", dim2: "情報設計", dim3: "コンテンツと英語", dim4: "信頼と実績の裏付け", dim5: "コンバージョン導線", dim6: "SEOとAI検索", dim7: "デザインとブランド", dim8: "サステナビリティと社会的影響",
    unreachable: "現在このページを開けません。しばらくしてからもう一度お試しください。", readFailed: "現在読み込めません。しばらくしてからもう一度お試しください。", submitFailed: "送信できませんでした。もう一度お試しください。",
    access_code_not_found: "この引き換えコードは存在しません", access_code_not_paid: "この引き換えコードはまだお支払いが完了していません", access_code_used: "この引き換えコードはすでに使用されています", access_code_wrong_product: "この引き換えコードはこの製品では使えません",
    access_codes_unavailable: "引き換えコードのサービスは現在ご利用いただけません", brief_unavailable: "現在診断を開始できません。しばらくしてからもう一度お試しください。", invalid_brief: "入力内容に誤りがあります。ご確認のうえ、もう一度お試しください。"
  })
});

export function codePageT(locale, key, values = {}) {
  const template = codePageCopy[locale]?.[key] ?? codePageCopy.zh[key] ?? key;
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
}

const SERVER_CODES = new Set(["access_code_not_found", "access_code_not_paid", "access_code_used", "access_code_wrong_product", "access_codes_unavailable", "brief_unavailable", "invalid_brief"]);
const REASONS = { not_found: "access_code_not_found", not_paid: "access_code_not_paid" };

/** What the buyer reads for a failed request: the text of its error `code` (or of a status `reason`) in their language, never the server's own message. */
export function codePageErrorText(error, locale, fallback = "unreachable") {
  const code = REASONS[error?.code] ?? error?.code;
  return codePageT(locale, SERVER_CODES.has(code) ? code : fallback);
}
