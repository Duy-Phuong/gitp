import { money } from "./b";

export function total(x: number): number {
  const fmt = (n: number) => n;
  fmt(x);
  console.log("fmt");
  return money(x);
}
