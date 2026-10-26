import { z } from 'zod';
import { SeasonTag, Side, Slug } from './common';

export const WeaponClassId = z.enum([
  'ar',
  'smg',
  'shotgun',
  'dmr',
  'lmg',
  'mp',
  'handgun',
  'shield',
]);
export type WeaponClassId = z.infer<typeof WeaponClassId>;

export const Operator = z.strictObject({
  id: Slug,
  name: z.string().min(1),
  side: Side,
  /** Two letters on the generated badge; the board never shows portraits. */
  badge: z.string().regex(/^[A-Z0-9]{2}$/),
  roles: z.array(z.string().min(1)),
  uniqueGadget: z.strictObject({ gadgetId: Slug, count: z.number().int().positive() }),
  secondaryGadgetOptions: z.array(Slug),
  weaponClasses: z.array(WeaponClassId).min(1),
  seasonAdded: SeasonTag,
  seasonRemoved: SeasonTag.optional(),
});
export type Operator = z.infer<typeof Operator>;
export const Operators = z.array(Operator);

export const Gadget = z.strictObject({
  id: Slug,
  name: z.string().min(1),
  side: z.enum(['attack', 'defence', 'both']),
  placement: z.enum(['wall', 'floor', 'hatch', 'opening', 'free']),
  defaultCount: z.number().int().positive(),
  iconId: Slug,
  /** Belongs to one operator, rather than being a pickable secondary. */
  unique: z.boolean(),
});
export type Gadget = z.infer<typeof Gadget>;
export const Gadgets = z.array(Gadget);

export const WeaponClass = z.strictObject({
  id: WeaponClassId,
  name: z.string().min(1),
  iconId: Slug,
});
export type WeaponClass = z.infer<typeof WeaponClass>;
export const WeaponClasses = z.array(WeaponClass);

/** Team rules the 0.9 linter reads instead of hard-coding them. */
export const Rules = z.strictObject({
  reinforcementsPerDefender: z.number().int().nonnegative(),
  dronesPerAttacker: z.number().int().nonnegative(),
  teamSize: z.number().int().positive(),
});
export type Rules = z.infer<typeof Rules>;
