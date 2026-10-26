import { use, useEffect, useMemo } from 'react';
import { loadSprite } from '../content/loader';
import { spriteElement } from '../content/sprite';

/**
 * Puts a content version's icon sprite into the document for every `<Icon>` on the page, and
 * returns the icon ids it holds. Suspends until the sprite has loaded. Mount it once per page.
 */
export function useIconSprite(version: string): string[] {
  // loadSprite hands back the same promise for a version while it is pending or loaded (which
  // `use()` needs) and forgets a failed one, so a remount retries.
  const text = use(loadSprite(version));
  const sprite = useMemo(() => spriteElement(text), [text]);
  useEffect(() => {
    document.body.appendChild(sprite.element);
    return () => sprite.element.remove();
  }, [sprite]);
  return sprite.ids;
}

export type IconProps = {
  id: string;
  /** CSS px; icons are drawn on a 24 px grid. */
  size?: number;
  /** Accessible name. Without one the icon is decorative and hidden from assistive tech. */
  label?: string;
  className?: string;
};

/** One icon from the sprite, in `currentColor`. Needs `useIconSprite` mounted on the page. */
export function Icon({ id, size = 20, label, className }: IconProps) {
  const use = <use href={`#icon-${id}`} />;
  if (label) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} role="img">
        <title>{label}</title>
        {use}
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {use}
    </svg>
  );
}
