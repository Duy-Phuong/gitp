import { money } from "./money";

export class Cart {
  constructor() {
    this.items = [];
  }
  add(item) {
    this.items.push(item);
  }
}

export function total(cart, x) {
  cart.add(x);
  const c = new Cart();
  return money(c.items.length);
}

const fmt = (n) => `${n}`;
