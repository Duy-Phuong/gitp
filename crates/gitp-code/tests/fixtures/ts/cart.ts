import { money } from "./money";

export interface Props {
  count: number;
}

export class Cart {
  items: number[] = [];
  add(item: number): void {
    this.items.push(item);
  }
}

export function total(cart: Cart, x: number): number {
  cart.add(x);
  const c = new Cart();
  return money(c.items.length);
}

const fmt = (n: number): string => `${n}`;
