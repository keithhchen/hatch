# @hatch/ui

Hatch 的共享 React design system。Web、Tauri Desktop 与 Storybook 都从这里消费同一套组件、CSS、字体和品牌 tokens。

```jsx
import "@hatch/ui/fonts";
import "@hatch/ui/theme.css";
import {
  Button,
  Dialog,
  DialogContent,
  Select,
  HatchBrand,
  AtmosphericPaper,
  HatchUIProvider
} from "@hatch/ui";
```

每个 app entry 明确加载 `@hatch/ui/theme.css`；该样式表再加载唯一的 `packages/brand/tokens.css`。显式 import 避免 bundler tree-shaking 掉 CSS。应用不得复制 token 值或直接维护第二份 Button、Dialog、Select 样式。

## 品牌资产

- Logo：`packages/brand/hatch-mark.svg`，通过 `HatchBrand` 或 `hatchMarkUrl` 使用。
- Atmospheric Paper：通过 `AtmosphericPaper` 使用。
- Gradient recipe：唯一配方在 `AtmosphericPaper`；base、warm/cool fields、strength、blur 与 duration 都来自品牌 tokens。
- Display serif：Instrument Serif；UI：system sans；pill/label：Inter。

## Typography source of truth

`packages/brand/tokens.css` owns the shared `rem` typography values. `@hatch/ui`
is the reference implementation that consumes those semantic variables. Web,
Desktop and Storybook import the shared package; they do not copy component CSS
or preserve unapproved local font sizes. A missing role is a spec/token change
first, followed by the HUI component and its product consumers.

## GUI

在 `creator-dashboard` 运行：

```sh
npm run storybook
```

打开 `Hatch / Design System GUI / Theme Lab`。Controls 修改的就是共享 CSS variables，不生成另一套 CSS，也不进入产品 runtime。

Storybook 中可使用 fixture 展示组件状态；Web/Desktop 产品入口不得引入这些 fixture。
