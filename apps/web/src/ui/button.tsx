import type { ButtonHTMLAttributes } from 'react';

const variants = {
  // Inverted: text colour as the fill, background colour as the label.
  primary: 'bg-fg text-bg hover:opacity-85',
  secondary: 'border border-border text-fg hover:bg-surface-2',
} as const;

const sizes = {
  default: 'h-8 px-3',
  lg: 'h-10 px-4',
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
};

export function Button({
  variant = 'secondary',
  size = 'default',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-control text-base font-medium transition duration-150 ease-out select-none motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-60 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
