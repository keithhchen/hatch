const config = {
  stories: ["../src/**/*.stories.@(js|jsx)", "../../packages/ui/src/**/*.stories.@(js|jsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {}
  },
  docs: { autodocs: "tag" }
};

export default config;
