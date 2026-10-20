const SURFACES = Object.freeze({
  hatch: {
    signInPill: "Welcome back",
    signUpPill: "New to Hatch",
    heroTitle: "Real experts, on call.",
    heroDescription: "Ask the Agents they built about your own situation, any time.",
    signInTitle: "Sign in to Hatch",
    signUpTitle: "Create your Hatch account",
    signInDescription: "Your library and conversations are waiting.",
    signUpDescription: "Free to join. Add an expert's Agent and start asking.",
    signInAction: "Sign in",
    signUpAction: "Create account",
    signInSwitch: "New to Hatch?",
    signUpSwitch: "Already have an account?"
  },
  studio: {
    signInPill: "For experts",
    signUpPill: "For experts",
    heroTitle: "Turn your expertise into an Agent product.",
    heroDescription: "Teach it your method once, and it helps your clients around the clock.",
    signInTitle: "Sign in to your Hatch Expert account",
    signUpTitle: "Create your Hatch Expert account",
    signInDescription: "Sign in to your Hatch Expert account and return to your products in Studio.",
    signUpDescription: "Define outcomes, organize your methods and examples, and verify quality in Studio.",
    signInAction: "Sign in",
    signUpAction: "Create your Hatch Expert account",
    signInSwitch: "New to Hatch Studio?",
    signUpSwitch: "Already have a Hatch Expert account?"
  },
  product: {
    signInPill: "Almost there",
    signUpPill: "Almost there",
    heroTitle: "",
    heroDescription: "",
    signInTitle: "Sign in to Hatch",
    signUpTitle: "Create your Hatch account",
    signInDescription: "Sign in to return to this Agent product.",
    signUpDescription: "Create an account to return to this Agent product.",
    signInAction: "Sign in and return to product",
    signUpAction: "Create account and return to product",
    signInSwitch: "New to Hatch?",
    signUpSwitch: "Already have an account?"
  }
});

export function createAuthPagePresentation(t) {
  return ({ signingUp, studioIntent, productIntent }) => {
    const shared = SURFACES[studioIntent ? "studio" : productIntent ? "product" : "hatch"];
    return {
      pill: t(signingUp ? shared.signUpPill : shared.signInPill),
      heroTitle: shared.heroTitle ? t(shared.heroTitle) : "",
      heroDescription: shared.heroDescription ? t(shared.heroDescription) : "",
      title: t(signingUp ? shared.signUpTitle : shared.signInTitle),
      description: t(signingUp ? shared.signUpDescription : shared.signInDescription),
      action: t(signingUp ? shared.signUpAction : shared.signInAction),
      switchPrompt: t(signingUp ? shared.signUpSwitch : shared.signInSwitch),
      switchAction: t(signingUp ? shared.signInAction : shared.signUpAction)
    };
  };
}
