const SURFACES = Object.freeze({
  hatch: {
    signInTitle: "Sign in",
    signUpTitle: "Create account",
    signInDescription: "Sign in with your Hatch account.",
    signUpDescription: "Create a free account to add and use Agents.",
    signInAction: "Sign in",
    signUpAction: "Create account",
    signInSwitch: "Create account",
    signUpSwitch: "Sign in to an existing account"
  },
  studio: {
    signInTitle: "Sign in to Hatch Studio",
    signUpTitle: "Create a Hatch Expert account",
    signInDescription: "Manage your Agent products in Studio.",
    signUpDescription: "Build, test and publish Agent products in Studio.",
    signInAction: "Sign in",
    signUpAction: "Create Hatch Expert account",
    signInSwitch: "Create a Hatch Expert account",
    signUpSwitch: "Sign in to an existing account"
  },
  product: {
    signInTitle: "Sign in",
    signUpTitle: "Create account",
    signInDescription: "Sign in to continue to this Agent.",
    signUpDescription: "Create an account to continue to this Agent.",
    signInAction: "Sign in",
    signUpAction: "Create account",
    signInSwitch: "Create account",
    signUpSwitch: "Sign in to an existing account"
  }
});

export function createAuthPagePresentation(t) {
  return ({ signingUp, studioIntent, productIntent }) => {
    const shared = SURFACES[studioIntent ? "studio" : productIntent ? "product" : "hatch"];
    return {
      title: t(signingUp ? shared.signUpTitle : shared.signInTitle),
      description: t(signingUp ? shared.signUpDescription : shared.signInDescription),
      action: t(signingUp ? shared.signUpAction : shared.signInAction),
      switchAction: t(signingUp ? shared.signUpSwitch : shared.signInSwitch)
    };
  };
}
