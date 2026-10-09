export function createAuthPagePresentation(t) {
  return ({ signingUp, studioIntent, productIntent }) => {
    const surface = studioIntent ? "studio" : productIntent ? "product" : "hatch";
    const shared = {
      hatch: {
        eyebrow: "Hatch",
        heroTitle: "Expert agents that deliver.",
        heroDescription: "View the expert products you subscribe to on Hatch.",
        accountLabel: "Hatch account",
        signInTitle: "Sign in to Hatch",
        signUpTitle: "Create your Hatch account",
        signInDescription: "",
        signUpDescription: "",
        signInAction: "Sign in",
        signUpAction: "Create account",
        signInSwitch: "New to Hatch?",
        signUpSwitch: "Already have an account?"
      },
      studio: {
        eyebrow: "Hatch Studio",
        heroTitle: "Turn your expertise into an Agent product.",
        heroDescription: "Build an Agent product from your professional methods.",
        accountLabel: "Hatch Expert account",
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
        eyebrow: "Selected Agent",
        heroTitle: "",
        heroDescription: "",
        accountLabel: "Hatch account",
        signInTitle: "Sign in to Hatch",
        signUpTitle: "Create your Hatch account",
        signInDescription: "Sign in to return to this Agent product.",
        signUpDescription: "Create an account to return to this Agent product.",
        signInAction: "Sign in and return to product",
        signUpAction: "Create account and return to product",
        signInSwitch: "New to Hatch?",
        signUpSwitch: "Already have an account?"
      }
    }[surface];

    return {
      eyebrow: t(shared.eyebrow),
      heroTitle: t(shared.heroTitle),
      heroDescription: t(shared.heroDescription),
      accountLabel: t(shared.accountLabel),
      title: t(signingUp ? shared.signUpTitle : shared.signInTitle),
      description: t(signingUp ? shared.signUpDescription : shared.signInDescription),
      action: t(signingUp ? shared.signUpAction : shared.signInAction),
      switchPrompt: t(signingUp ? shared.signUpSwitch : shared.signInSwitch),
      switchAction: t(signingUp ? shared.signInAction : shared.signUpAction)
    };
  };
}
