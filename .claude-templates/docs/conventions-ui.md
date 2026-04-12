# UI Component Conventions

Extracted from CLAUDE.md for on-demand reference. Read this when building or modifying UI components.

*Expo-opinionated defaults below. Prune what doesn't apply; add project-specific components as you build them.*

## Screen structure

Every screen uses `Screen` wrapper → `ScreenHeader` (title, optional caption, optional action slot) → content. Don't build ad-hoc headers.

## Shared components

Build these early — they pay for themselves fast.

- **InfoRow** from `@/components` for label/value pairs (pass `borderless` for inline breakdowns) — never inline one-off row components
- **ItemTable** from `@/components` for line-item lists — never duplicate the column header + row markup
- **StatCard** from `@/components` for dashboard metrics. Accepts optional `onPress` — when provided, wraps in Pressable with scale feedback and shows a `›` chevron
- {{ADD PROJECT-SPECIFIC SHARED COMPONENTS AS YOU BUILD THEM}}

## Buttons

- **Button** from `@/components` for all action buttons — never build ad-hoc `Pressable` + inline style buttons. Variants: `primary` / `secondary` / `ghost` / `danger` / `confirm`. Sizes: `sm` / `md` / `lg`. Optional `icon` prop renders a ReactNode to the left of the label. Optional `haptic` prop (`'light'` / `'medium'` / `'heavy'`) triggers impact feedback on press — use only for high-stakes actions
- **IconButton** from `@/components` for icon-only pressables (settings gear, FAB, send button, scroll-to-bottom). Props: `icon`, `onPress`, `accessibilityLabel` (required), `size`, `variant`, `loading`, `haptic`. Uses `RADII.full` for circular shape
- **ButtonGroup** from `@/components` to wrap rows or columns of action buttons — `gap` (default `'sm'`), `direction` (`'row'` default / `'column'`). Prefer over bare `<Box flexDirection="row" gap="sm">`

## Haptics & press feedback

- **Haptics**: `fireHaptic(weight)` from `@/utils/haptics` — shared utility used by Button and IconButton. Use the `haptic` prop rather than calling `fireHaptic` directly
- **Press feedback**: every interactive element must have press feedback. Two hooks in `@design/hooks`:
  - `usePressStyle` for instant feedback (returns Pressable style callback) — `'scale'` for cards (0.97 + 0.85), `'opacity'` for pills/toggles, `'bg'` for list rows
  - `useAnimatedPress` for smooth 150ms animated feedback (returns `{ animatedStyle, onPressIn, onPressOut }` for `Animated.View` wrapper) — used by Button and IconButton
  - Both respect `useReducedMotion`. Never leave a Pressable without feedback

## Design tokens

- **RADII** (xs:4, sm:6, md:8, lg:12, xl:16, pill:20, full:9999) and **PRESS** (scale:0.97, opacity:0.85) exported from `@design/tokens`. `RADII` is wired into the Restyle theme as `borderRadii` — use string keys on Box (`borderRadius="lg"`). For StyleSheet values, use `RADII.lg`. For values not in the token scale, use `style={{ borderRadius: N }}` on Box
- **Motion tokens**: `MOTION.duration` (instant:80, fast:150, base:220, slow:360, enter:480, ping:3600) — use instead of hardcoded ms values in `withTiming`, `FadeIn`, etc. `useReducedMotion` from `@design/hooks` gates animations for accessibility
- **Spacing scale**: Restyle theme — use `margin="lg"` on Box, not inline `{ margin: 16 }`

## Navigation & layout components

- **`ContentContainer`**: max-width centering wrapper — opt-in per screen, not baked into `Screen`. Use for text-heavy screens. Skip for data-dense screens that benefit from width
- **Tab bar**: if supporting desktop, render a sidebar (`position: 'absolute'` + `sceneStyle: { marginLeft }`) and a standard bottom bar on phone/tablet. `SIDEBAR_WIDTH` constant in `_layout.tsx`
- **Modal sheets on tablet**: add `isTablet && styles.sheetTablet` with `maxWidth: 540`, `alignSelf: 'center'`, `borderRadius`, `marginBottom: 40` for centered dialog presentation

## Responsive layouts

Three breakpoints — `phone` (0), `tablet` (768), `desktop` (1024) — defined in `BREAKPOINTS` in `@design/tokens`. Two mechanisms, use the right one:

- **Restyle responsive props** for spacing/sizing on `Box`/`Text`: `paddingHorizontal={{ phone: 'lg', tablet: '2xl' }}`. Declarative, no hook call, no memo invalidation — prefer for visual-only changes
- **`useLayout()` hook** from `@design/hooks` for conditional rendering and structural changes (show/hide elements, `flexDirection` swap, master-detail layout). Returns `{ isTablet, isDesktop, isLandscape, contentMaxWidth, breakpoint, width, height }`. **Never call `useLayout()` inside a `memo` component** rendered in a list — it re-renders on every dimension change and defeats memoization. Pass layout flags as props from the parent instead

## Accessibility baseline

- Every interactive element has `accessibilityLabel` (required on `IconButton`, strongly encouraged on `Button`)
- Respect `useReducedMotion` from `@design/hooks` — all animations gate through it
- Minimum touch target 44×44pt — enforce via `hitSlop` on small buttons
- Text contrast ratio 4.5:1 against background — verify in dark and light themes
- Screen reader order matches visual order — use `accessibilityElementsHidden` for decorative elements
