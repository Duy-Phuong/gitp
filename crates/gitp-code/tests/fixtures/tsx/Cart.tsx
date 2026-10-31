import { money } from "./money";

interface Props {
  count: number;
}

export class Cart {
  add(item: number): void {}
}

export function total(cart: Cart, x: number): number {
  cart.add(x);
  const c = new Cart();
  return money(x);
}

const fmt = (n: number): string => `${n}`;

export function View(p: Props) {
  return <div className="x">{fmt(p.count)}</div>;
}
