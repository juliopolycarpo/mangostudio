import { type ComponentType, createElement, type ReactNode } from 'react';

// Animation-only props from `motion/react`. They drive enter/exit transitions
// and must be dropped before reaching the real DOM node so React does not warn
// about unknown attributes, and so rendering stays synchronous in tests.
const ANIMATION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileInView',
  'whileDrag',
  'viewport',
  'custom',
  'layout',
  'layoutId',
  'layoutDependency',
  'drag',
  'onAnimationStart',
  'onAnimationComplete',
  'onUpdate',
]);

type MotionProps = Record<string, unknown>;

function withoutAnimationProps(props: MotionProps): MotionProps {
  const domProps: MotionProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ANIMATION_PROPS.has(key)) domProps[key] = value;
  }
  return domProps;
}

const motionComponentCache = new Map<string, ComponentType<MotionProps>>();

// Cache per tag so repeated `motion.div` accesses return a stable component and
// React does not remount the element on every render. `ref` is left untouched
// in props: React 19 forwards it to the host element via createElement.
function resolveMotionComponent(tag: string): ComponentType<MotionProps> {
  const cached = motionComponentCache.get(tag);
  if (cached) return cached;
  // biome-ignore lint/nursery/noComponentHookFactories: cached per tag, so identity is stable across renders and no subtree remounts.
  const Component = (props: MotionProps) => createElement(tag, withoutAnimationProps(props));
  Component.displayName = `motion.${tag}`;
  motionComponentCache.set(tag, Component);
  return Component;
}

/**
 * Test double for `motion/react`'s `motion` proxy that renders plain DOM nodes.
 * // Usage: <motion.div animate={{ opacity: 1 }}>body</motion.div> -> <div>body</div>
 */
export const motion = new Proxy({} as Record<string, ComponentType<MotionProps>>, {
  get: (_target, property) =>
    typeof property === 'string' ? resolveMotionComponent(property) : undefined,
});

/**
 * Test double for `motion/react`'s `AnimatePresence`. It unmounts exiting
 * children immediately instead of awaiting an exit animation, which keeps
 * presence-driven assertions deterministic regardless of CI timing.
 * // Usage: <AnimatePresence>{open && <motion.div />}</AnimatePresence>
 */
export function AnimatePresence({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
