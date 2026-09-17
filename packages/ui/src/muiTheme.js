// MUI is an optional consumer of @hatch/ui. Keep the adapter as plain theme
// options so the shared package does not pull MUI into non-MUI surfaces.
export const hatchMuiThemeOptions = {
  palette: {
    mode: "light",
    // These values are non-purple fallbacks for MUI's color calculations.
    // Component surfaces below resolve the canonical Hatch CSS variables.
    primary: { main: "#1f1c19", contrastText: "#fffaf4" },
    secondary: { main: "#a64e35", contrastText: "#fffaf4" },
    background: { default: "#f3efe8", paper: "#fbf8f2" },
    text: { primary: "#000000", secondary: "#6b6259" },
    divider: "rgba(54, 43, 33, .17)",
    error: { main: "#a84a36", contrastText: "#fff9f5" },
    success: { main: "#4f715f", contrastText: "#fffaf4" },
    warning: { main: "#896b31", contrastText: "#fffaf4" }
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: "var(--hatch-font-ui)",
    h4: { fontWeight: 700, letterSpacing: "-.035em" },
    h5: { fontWeight: 700, letterSpacing: "-.025em" },
    button: { textTransform: "none", fontWeight: 600 }
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: "var(--hatch-radius-control)", fontFamily: "var(--hatch-font-pill)" },
        containedPrimary: { color: "var(--hatch-ui-on-primary)", backgroundColor: "var(--hatch-ui-primary)", "&:hover": { backgroundColor: "var(--hatch-ui-primary-hover)" } },
        outlinedPrimary: { color: "var(--hatch-ui-accent)", borderColor: "var(--hatch-ui-accent)", "&:hover": { borderColor: "var(--hatch-ui-accent-hover)", backgroundColor: "var(--hatch-ui-pigment-clay)" } },
        textPrimary: { color: "var(--hatch-ui-accent)" },
        colorError: { color: "var(--hatch-ui-on-danger)", backgroundColor: "var(--hatch-ui-danger-solid)", "&:hover": { backgroundColor: "var(--hatch-ui-danger)" } }
      }
    },
    MuiIconButton: { styleOverrides: { root: { borderRadius: "var(--hatch-radius-control)", "&:hover": { backgroundColor: "var(--hatch-ui-pigment-clay)" } } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none", backgroundColor: "var(--hatch-ui-surface-solid)" } } },
    MuiPopover: { styleOverrides: { paper: { border: "1px solid var(--hatch-ui-border-soft)", borderRadius: "var(--hatch-radius-menu)", boxShadow: "var(--hatch-shadow-menu)" } } },
    MuiDialog: { styleOverrides: { paper: { border: "1px solid var(--hatch-ui-border-soft)", borderRadius: "var(--hatch-radius-dialog)", backgroundColor: "var(--hatch-ui-surface-solid)", boxShadow: "var(--hatch-shadow-dialog)" } } },
    MuiListItemButton: { styleOverrides: { root: { borderRadius: "var(--hatch-radius-control)", margin: "2px 8px", "&:hover": { backgroundColor: "var(--hatch-ui-pigment-clay)" }, "&.Mui-selected": { backgroundColor: "var(--hatch-ui-selection)", "&:hover": { backgroundColor: "var(--hatch-ui-selection)" } } } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: "var(--hatch-radius-control)", backgroundColor: "var(--hatch-ui-surface-bright)", "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: "var(--hatch-ui-accent)" }, "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: "var(--hatch-ui-accent)", borderWidth: 2 } }, notchedOutline: { borderColor: "var(--hatch-ui-border)" } } },
    MuiSelect: { styleOverrides: { select: { fontFamily: "var(--hatch-font-ui)" } } },
    MuiTabs: { styleOverrides: { indicator: { backgroundColor: "var(--hatch-ui-accent)" } } },
    MuiTab: { styleOverrides: { root: { color: "var(--hatch-ui-ink-faint)", "&.Mui-selected": { color: "var(--hatch-ui-accent)" } } } },
    MuiChip: { styleOverrides: { root: { borderRadius: "var(--hatch-radius-pill)", fontFamily: "var(--hatch-font-pill)" }, colorSuccess: { color: "var(--hatch-ui-status-success-ink)", backgroundColor: "var(--hatch-ui-status-success-bg)" }, colorError: { color: "var(--hatch-ui-status-error-ink)", backgroundColor: "var(--hatch-ui-status-error-bg)" } } },
    MuiAlert: { styleOverrides: { root: { borderRadius: "var(--hatch-radius-control)" }, standardSuccess: { color: "var(--hatch-ui-status-success-ink)", backgroundColor: "var(--hatch-ui-status-success-bg)" }, standardWarning: { color: "var(--hatch-ui-status-warning-ink)", backgroundColor: "var(--hatch-ui-status-warning-bg)" }, standardError: { color: "var(--hatch-ui-status-error-ink)", backgroundColor: "var(--hatch-ui-status-error-bg)" } } },
    MuiCircularProgress: { styleOverrides: { root: { color: "var(--hatch-ui-accent)" } } },
    MuiSvgIcon: { styleOverrides: { root: { color: "inherit" } } }
  }
};
